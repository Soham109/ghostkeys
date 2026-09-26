import Foundation

/// The one object the daemon needs: feed it microphone chunks and IMU tap onsets, get `AcousticEvent`s back.
/// Pure computation (no hardware), so it is fully testable with synthetic audio. Not thread safe: call it from one
/// queue (for example, hop `AcousticSession` chunks onto the daemon's detection queue).
public final class SoundModeProcessor {
    public struct Options: Sendable {
        public var rubs = true
        public var sonar = true
        /// Stereo-pilot SonarField mode (hover_level, push/pull, sweeps, finger slides). Replaces `sonar` when on:
        /// play `StereoPilotGenerator`, not `PilotToneGenerator`.
        public var sonarField = false
        public var fieldConfig = SonarFieldConfig()
        /// Classify taps when the daemon calls `noteTapOnset` (needs `tapClassifier`).
        public var tapTypes = true
        public var friction = FrictionDetectorConfig()
        public var sonarConfig = SonarConfig()
        /// Audio time minus IMU time for the same physical event, seconds (measure once per model; small).
        public var imuToAudioOffset: Double = 0
        /// Search radius around the expected onset when aligning a tap window.
        public var tapSearchRadius: Double = 0.015
        public init() {}
    }

    public let sampleRate: Double
    public var options: Options
    /// Trained tap-type model; nil means taps are not classified.
    public var tapClassifier: TapTypeClassifier?
    public let ringBuffer: AudioRingBuffer
    public let friction: FrictionDetector
    public let sonar: SonarWaveDetector
    public let field: SonarField
    private let extractor: TapFeatureExtractor
    private var pendingOnsets: [Double] = []

    public init(options: Options = .init(), tapClassifier: TapTypeClassifier? = nil,
                sampleRate: Double = GhostkeysAcousticsInfo.sampleRate) {
        self.options = options
        self.tapClassifier = tapClassifier
        self.sampleRate = sampleRate
        ringBuffer = AudioRingBuffer(duration: 0.2, sampleRate: sampleRate)
        friction = FrictionDetector(config: options.friction, sampleRate: sampleRate)
        var sonarConfig = options.sonarConfig
        sonarConfig.sampleRate = sampleRate
        sonar = SonarWaveDetector(config: sonarConfig)
        var fieldConfig = options.fieldConfig
        fieldConfig.sampleRate = sampleRate
        field = SonarField(config: fieldConfig)
        extractor = TapFeatureExtractor(sampleRate: sampleRate)
    }

    /// Clears all state; call when the microphone session restarts.
    public func reset() {
        ringBuffer.clear()
        friction.reset()
        sonar.reset()
        field.reset()
        pendingOnsets.removeAll()
    }

    /// The IMU detected a tap at `imuTime` (same clock as the audio chunk times). The classification arrives from a
    /// later `process` call once 40 ms of audio after the onset is available.
    public func noteTapOnset(imuTime: Double) {
        guard options.tapTypes, tapClassifier != nil else { return }
        pendingOnsets.append(imuTime)
    }

    public func process(_ samples: [Float], time: Double) -> [AcousticEvent] {
        samples.withUnsafeBufferPointer { process($0, time: time) }
    }

    /// Suppress SonarField gestures until `time` (typing gate, IMU motion or bump). Call on every keystroke.
    public func suppressSonar(until time: Double) { field.suppress(until: time) }

    /// Feeds mono samples (first sample at `time`, seconds). Returns events in time order within each detector.
    public func process(_ samples: UnsafeBufferPointer<Float>, time: Double) -> [AcousticEvent] {
        var out: [AcousticEvent] = []
        ringBuffer.write(samples, time: time)
        let useField = options.sonarField
        func forward(_ events: [SonarFieldEvent]) {
            for e in events {
                switch e {
                case .air(let a): out.append(.air(a))
                case .gesture(let g): out.append(.gesture(g))
                case .doppler: break
                }
            }
        }
        if useField { forward(field.process(samples, time: time)) }
        if options.rubs {
            for e in friction.process(samples, time: time) {
                switch e {
                case .started(let t):
                    out.append(.rubStarted(time: t))
                    if useField { forward(field.noteContactBegan(at: t)) }
                case .cancelled(let t, let reason):
                    out.append(.rubCancelled(time: t, reason: reason))
                    if useField { forward(field.noteContactCancelled(at: t)) }
                case .ended(let s):
                    out.append(.rubEnded(s))
                    out.append(.gesture(Self.gesture(for: s, config: friction.config)))
                    if useField { forward(field.noteContactEnded(start: s.startTime, end: s.endTime)) }
                }
            }
        }
        if options.sonar && !useField {
            for w in sonar.process(samples, time: time) {
                out.append(.wave(w))
                out.append(.gesture(AcousticGesture(kind: w.kind.gesture, time: w.time, confidence: w.confidence,
                                                    duration: w.time - w.startTime, speedMetersPerSecond: w.estimatedSpeed)))
            }
        }
        out.append(contentsOf: classifyPendingTaps())
        return out
    }

    /// Maps a rub to its gesture: `rub_left` / `rub_right` only when the direction is confident, else `rub`.
    public static func gesture(for s: RubSummary, config: FrictionDetectorConfig) -> AcousticGesture {
        var kind = AcousticGestureKind.rub
        var confidence = s.rubFrameFraction
        if s.direction != .unknown && s.directionConfidence >= config.directionConfidenceThreshold {
            let towardLeft = (s.direction == .towardMics) == (config.micSide == .left)
            kind = towardLeft ? .rubLeft : .rubRight
            confidence = s.directionConfidence
        }
        return AcousticGesture(kind: kind, time: s.endTime, confidence: confidence, duration: s.duration,
                               speedProxy: s.speedProxy, speedMetersPerSecond: s.speedMetersPerSecond,
                               direction: s.direction, directionConfidence: s.directionConfidence)
    }

    private func classifyPendingTaps() -> [AcousticEvent] {
        guard !pendingOnsets.isEmpty, let model = tapClassifier, let range = ringBuffer.timeRange else { return [] }
        let windowSeconds = TapFeatureExtractor.windowDuration
        let radius = options.tapSearchRadius
        var out: [AcousticEvent] = []
        var keep: [Double] = []
        for imu in pendingOnsets {
            let expected = imu + options.imuToAudioOffset
            let start = expected - radius - TapWindowAligner.preroll
            let end = expected + radius + windowSeconds
            if end > range.upperBound {
                if expected - range.upperBound < 0.5 { keep.append(imu) } // audio not here yet
                continue
            }
            let count = Int(((end - start) * sampleRate).rounded())
            let stretch = start >= range.lowerBound ? ringBuffer.read(from: start, count: count) : nil
            var result = TapClassification(type: nil, confidence: 0, nearestDistance: .infinity, votes: [:], rejectReason: .noOnset)
            if let stretch, let window = TapWindowAligner.window(from: stretch, samplesTime: start, expectedOnset: expected,
                                                                  searchRadius: radius, sampleRate: sampleRate) {
                result = model.classify(extractor.features(window))
            }
            out.append(.tapClassified(onset: imu, result))
            if result.type == .knuckle {
                out.append(.gesture(AcousticGesture(kind: .knockKnuckle, time: imu, confidence: result.confidence)))
            }
        }
        pendingOnsets = keep
        return out
    }
}
