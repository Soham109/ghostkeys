// Streaming tap engine: onset detection -> context gates -> features -> classifier -> gesture grammar.
//
// Public types that used to live here as stubs are implemented in their own files:
//   CalibrationReport, Trainer    Classifier/Trainer.swift
//   ZoneModel                     Classifier/ZoneModel.swift
//   LidGestureDetector            Gestures/LidGestureDetector.swift
//   LightGestureDetector          Gestures/LightGestureDetector.swift
//
// Timeline of one tap (797 Hz):
//   onset (first sample over threshold)
//   +80 ms  feature window complete; the pulse has normally ended by then
//           -> gates -> .candidate -> classify -> .tap (+ .gesture "tap" for immediate zones)
//   +doubleWindow after the last tap -> .gesture for zones in zonesNeedingMultiTap
// Pulses that ring longer than 80 ms delay the decision until they end (the pulse width limit is 160 ms).
//
// Precision layers after the classifier (27 Sep 2026, docs/review/DETECTION_AUDIT.md):
//   - FamiliarityGuard: when recent confident taps sit far from the calibration (another posture or surface), only
//     clear-cut taps fire (confidence >= 0.9, within 3 typical distances). `isUnfamiliar` exposes the state.
//     Junk the classifier already rejects or doubts does not count as evidence (round 2, DETECTION_ROUND2.md).
//   - Look-ahead: a key press or pointer event within 300 ms after a multi-tap zone's tap cancels the pending
//     double/triple (the hands were heading for the keyboard or trackpad). No latency cost: it was waiting anyway.
//
// Posture (round 3, docs/review/DETECTION_ROUND3.md): every candidate carries the machine's gravity direction
// (`TapFeatures.gravity`, so saved calibration samples keep their posture), `gravityDirection` exposes it, and an
// optional `modelSet` (one ZoneModel per posture) makes the posture's model live, by gravity and by tap evidence.

import Foundation

/// Streaming tap detector + classifier + gesture grammar. Feed every IMU sample in order.
public final class TapEngine {
    public var settings: DetectionSettings
    /// The zone model. Models saved by older builds are upgraded on assignment (`ZoneModel.upgraded()`: tighter
    /// reject distance, typical distance for the familiarity guard).
    /// With a `modelSet` installed, assigning (or mutating) it replaces the live posture's model in the set, and
    /// assigning nil removes the set.
    public var model: ZoneModel? {
        didSet {
            if let m = model, m.typicalDistance == nil, m.isTrained { model = m.upgraded() }
            if oldValue?.labels != model?.labels || oldValue?.typicalDistance != model?.typicalDistance { familiarity.reset() }
            if !installingFromSet, postureModels != nil {
                if let m = model { postureModels!.setModel(m, for: postureModels!.activePosture) } else { postureModels = nil }
            }
        }
    }

    /// Sets the normalized zone centres (`ZoneModel.setZoneCenters`) of the live model and of every posture model.
    public func setZoneCenters(_ centers: [String: [Double]]) {
        postureModels?.setZoneCenters(centers)
        installingFromSet = true
        model?.setZoneCenters(centers)
        installingFromSet = false
    }

    /// One model per posture (round 3, docs/review/DETECTION_ROUND3.md). When set, the engine follows the machine's
    /// low-passed gravity and makes the nearest posture's model the live `model` (see ZoneModelSet.swift for the
    /// hysteresis). Its models are upgraded once when installed. nil (the default): `model` is used as assigned.
    public var modelSet: ZoneModelSet? {
        get { postureModels }
        set {
            var s = newValue
            s?.mapModels { $0.typicalDistance == nil && $0.isTrained ? $0.upgraded() : $0 }
            if let g = gravity.direction { s?.update(gravity: g, t: lastSampleT, moving: gravity.isMoving) }
            installingFromSet = true
            model = s?.activeModel
            installingFromSet = false
            postureModels = s
        }
    }
    /// The posture whose model is live (nil without a `modelSet`).
    public var activePosture: String? { postureModels?.activePosture }
    /// Angle in degrees between the machine's gravity and the live posture model's calibration gravity (nil without a
    /// `modelSet`, before the first gravity reading, or when that model has no calibration gravity).
    public var postureGravityAngle: Double? { postureModels?.gravityAngle }
    /// Direction of the machine's low-passed gravity (unit length, device coordinates, as the accelerometer reads it at
    /// rest; 200 ms low-pass, frozen for 150 ms after each tap onset). nil before the first sample. Every candidate's
    /// `TapFeatures.gravity` is this value at its decision.
    public var gravityDirection: SIMD3<Double>? { gravity.direction }
    private var postureModels: ZoneModelSet?
    private var installingFromSet = false
    private var lastSampleT = 0.0

    /// Strict mode when recent candidates stop looking like the calibration (see FamiliarityGuard.swift).
    public var familiarity = FamiliarityGuard()
    /// True while taps look unlike the calibration (another posture or surface): only clear-cut taps fire.
    public var isUnfamiliar: Bool { familiarity.isUnfamiliar }

    /// Zones that have a binding needing more than one tap (double, triple, rhythm, sequence).
    /// Taps in other zones emit gesture "tap" immediately; taps in these zones wait for the
    /// double-tap window to close. See GestureGrammar.swift for the exact rules.
    public var zonesNeedingMultiTap: Set<String> {
        get { grammar.zonesNeedingMultiTap }
        set { grammar.zonesNeedingMultiTap = newValue }
    }

    /// Calibration capture: skips the typing, trackpad and burst gates so keystrokes and clicks can
    /// be captured as "none" negatives, and uses the low (quiet-desk) onset floor so gentle
    /// calibration taps are captured too. The paused and motion gates still apply.
    public var bypassInputGates = false
    /// Emit tilt_left / tilt_right gestures.
    public var tiltEnabled = true
    /// +1 if +x of the sensor points to the right of the machine, -1 otherwise.
    public var tiltRollSign: Double {
        get { tilt.rollSign }
        set { tilt.rollSign = newValue }
    }

    /// Nominal sample rate the filters are designed for.
    public let sampleRate: Double

    /// Current adaptive noise floor (median high-passed accel magnitude, g).
    public var noiseFloor: Double { onset.noise }
    /// Current trigger threshold (g).
    public var onsetThreshold: Double { onset.threshold }
    /// True while the quiet-desk floor is in effect (light-touch mode only: calm for 300 ms, no key
    /// or trackpad for 1 s).
    public var isQuiet: Bool { settings.lightTouch && onset.quiet }
    /// Current high-passed accel magnitude (g), for visualizers.
    public var level: Double { onset.level }

    // Components.
    private var history: SampleHistory
    private var onset = OnsetDetector()
    private var gravity = GravityMonitor()
    private var tilt = TiltDetector()
    private var grammar = GestureGrammar()
    private let extractor: FeatureExtractor

    // Input activity: recent key / mouse event times (seconds, same clock as samples).
    private var keyTimes: [Double] = []
    /// Key release times (a held key's release bump can arrive long after its key-down).
    private var keyUpTimes: [Double] = []
    private let keyUpGate = 0.150
    private var mouseTimes: [Double] = []
    /// Key events can be delivered a little after the vibration they caused.
    private let lateInputTolerance = 0.08
    private let trackpadGate = 0.15
    /// How long after a multi-tap zone's tap a key press or pointer event still cancels its gesture.
    private let lookAheadGate = 0.30

    private struct InFlight {
        var info: OnsetInfo
        var width: Double?
        var tooLong = false
        var movingAtOnset: Bool
        var typingAtOnset: Bool
        var trackpadAtOnset: Bool
        var modifiers: Set<String>
    }
    private var inFlight: [InFlight] = []
    private var activePulseIndex: Int?

    public init(settings: DetectionSettings) {
        self.settings = settings
        sampleRate = 797
        history = SampleHistory(capacity: 1024)
        extractor = FeatureExtractor(sampleRate: sampleRate)
        onset.sampleRate = sampleRate
        gravity.sampleRate = sampleRate
    }

    /// Clears all streaming state (keeps settings, model and zonesNeedingMultiTap).
    public func reset() {
        history.removeAll()
        onset.reset()
        gravity.reset()
        tilt.reset()
        grammar.reset()
        familiarity.reset()
        postureModels?.resetSelection()
        keyTimes.removeAll(); keyUpTimes.removeAll(); mouseTimes.removeAll()
        inFlight.removeAll()
        activePulseIndex = nil
    }

    public func ingest(_ s: IMUSample, context: InputContext) -> [DetectorEvent] {
        var out: [DetectorEvent] = []
        let index = history.count
        history.append(s)
        lastSampleT = s.t
        recordInput(context, t: s.t)
        // Look-ahead: a key press or pointer event shortly after a tap means the hands were on their way to the
        // keyboard or trackpad, and the spike was most likely a palm landing or a hand brushing the chassis. A
        // double/triple still waiting for its window to close is dropped (no latency cost: it was waiting anyway).
        // Every remembered event is checked, not only the ones first seen at this sample: a tap whose pulse rings past
        // 80 ms is decided late, and a key that went down between onset + 80 ms (the typing gate's reach) and that
        // decision was seen before the group existed (docs/review/VERIFY_07_DETECTION.md, finding 4).
        if let last = grammar.pendingLastTap {
            let lookAhead = min(settings.doubleWindowMs / 1000, lookAheadGate)
            let after = { (e: Double) in e > last && e - last <= lookAhead }
            if keyTimes.contains(where: after) || mouseTimes.contains(where: after) { grammar.cancelPending() }
        }

        onset.sensitivity = settings.sensitivity
        onset.lightTouch = settings.lightTouch
        onset.learnedFloor = model?.onsetFloor
        onset.captureMode = bypassInputGates
        onset.inputIdle = context.secondsSinceKey > 1 && context.secondsSinceMouse > 1
        grammar.doubleWindow = settings.doubleWindowMs / 1000

        // Gravity, motion and tilt.
        if gravity.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t) {
            if tiltEnabled, let name = tilt.process(gravity: gravity.gravity, t: s.t), !context.paused {
                out.append(.gesture(GestureEvent(t: s.t, gesture: name, zone: nil, zones: [], modifiers: context.modifiers, confidence: 1)))
            }
            // Posture models: follow gravity (decimated ticks, about 100 Hz).
            if postureModels != nil, let g = gravity.direction,
               postureModels!.update(gravity: g, t: s.t, moving: gravity.isMoving) {
                installingFromSet = true
                model = postureModels!.activeModel
                installingFromSet = false
            }
        }

        // Onset detection and pulse tracking.
        if let o = onset.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t, index: index) {
            switch o {
            case .onset(let info):
                startInFlight(info, context: context, t: s.t)
            case .restart(let info):
                // The weak pulse in flight is dropped without an event; this hit replaces it.
                inFlight.removeAll { $0.info.index == activePulseIndex }
                startInFlight(info, context: context, t: s.t)
            case .pulseEnded(let width):
                if let i = inFlight.firstIndex(where: { $0.info.index == activePulseIndex }) { inFlight[i].width = width }
                activePulseIndex = nil
            case .pulseTooLong:
                if let i = inFlight.firstIndex(where: { $0.info.index == activePulseIndex }) { inFlight[i].tooLong = true }
                activePulseIndex = nil
            }
        }

        // Finish spikes whose window is complete.
        var i = 0
        while i < inFlight.count {
            let f = inFlight[i]
            let windowDone = index - f.info.index >= extractor.samplesNeededAfterOnset
            if f.tooLong || (windowDone && f.width != nil) {
                inFlight.remove(at: i)
                out += finish(f, context: context, now: s.t)
            } else {
                i += 1
            }
        }

        // Close multi-tap windows.
        for g in grammar.tick(now: s.t, oldestInFlight: inFlight.first?.info.t) where !context.paused {
            out.append(.gesture(g))
        }
        return out
    }

    // MARK: Gates, features, classification

    private func finish(_ f: InFlight, context: InputContext, now: Double) -> [DetectorEvent] {
        let t = f.info.t
        func reject(_ r: RejectReason) -> [DetectorEvent] { [.rejected(t: t, reason: r)] }

        if context.paused { return reject(.paused) }
        if !bypassInputGates {
            let gate = settings.typingGateMs / 1000
            if f.typingAtOnset || keyTimes.contains(where: { $0 >= t - gate && $0 <= t + lateInputTolerance })
                || keyUpTimes.contains(where: { $0 >= t - keyUpGate && $0 <= t + lateInputTolerance }) {
                return reject(.typing)
            }
            if f.trackpadAtOnset || mouseTimes.contains(where: { $0 >= t - trackpadGate && $0 <= t + lateInputTolerance }) {
                return reject(.trackpad)
            }
            if f.info.burst { return reject(.burst) }
        }
        // Motion: the pulse was too long, or sustained rotation was going on at the onset or is by now.
        if f.tooLong || f.movingAtOnset || gravity.isMoving {
            return reject(.motion)
        }

        var features = extractor.extract(history: history, onset: f.info.index, pulseWidth: f.width ?? 0, t: t)
        features.gravity = gravity.direction
        var out: [DetectorEvent] = [.candidate(features)]
        // Posture models: a run of taps that fit another posture's model far better switches to it (ZoneModelSet).
        if postureModels != nil, postureModels!.observe(features, t: t) {
            installingFromSet = true
            model = postureModels!.activeModel
            installingFromSet = false
        }
        guard let model else { return out }

        let r = model.classifyDetailed(features)
        // Every classified candidate goes past the familiarity guard; it remembers only the ones that are evidence
        // about the user's taps (a confident zone, or a confident zone turned away by the reject distance).
        let familiar = familiarity.admit(r, model: model, t: t)
        guard r.zone != ZoneModel.noneLabel, familiar else {
            out.append(.rejected(t: t, reason: .low_confidence))
            return out
        }
        let strong = r.confidence >= settings.minConfidence
        if !strong {
            // Weak tap: may still complete a double/triple in a multi-tap zone (GestureGrammar.swift).
            let followUp = min(settings.followUpConfidence, settings.minConfidence)
            guard r.confidence >= followUp, grammar.zonesNeedingMultiTap.contains(r.zone) else {
                out.append(.rejected(t: t, reason: .low_confidence))
                return out
            }
            let tap = makeTap(f, features, r)
            let (absorbed, gestures) = grammar.acceptWeak(tap)
            out.append(absorbed ? .tap(tap) : .rejected(t: t, reason: .low_confidence))
            for g in gestures { out.append(.gesture(g)) }
            return out
        }
        let tap = makeTap(f, features, r)
        out.append(.tap(tap))
        for g in grammar.accept(tap) { out.append(.gesture(g)) }
        return out
    }

    private func startInFlight(_ info: OnsetInfo, context: InputContext, t: Double) {
        inFlight.append(InFlight(
            info: info, movingAtOnset: gravity.wasMoving(at: t),
            typingAtOnset: context.secondsSinceKey * 1000 < settings.typingGateMs || context.secondsSinceKeyUp < keyUpGate,
            trackpadAtOnset: context.secondsSinceMouse < trackpadGate,
            modifiers: context.modifiers))
        activePulseIndex = info.index
        // Keep the tap's own rocking out of the gravity estimate (see GravityMonitor.swift).
        gravity.freeze(until: t + gravity.freezeAfterOnset)
    }

    private func makeTap(_ f: InFlight, _ features: TapFeatures, _ r: ZoneModel.Result) -> TapEvent {
        // Strength 0...1: 0 at the trigger threshold, 1 at 20x the threshold (log scale).
        let peakMg = pow(10, features[.strength])
        let thrMg = max(f.info.threshold * 1000, 1e-3)
        let strength = Stats.clamp(log10(max(peakMg / thrMg, 1e-9)) / log10(20), 0, 1)
        return TapEvent(t: f.info.t, zone: r.zone, confidence: r.confidence, x: r.x, y: r.y, strength: strength, modifiers: f.modifiers)
    }

    /// Returns the key-down and pointer event times first seen at this sample.
    @discardableResult
    private func recordInput(_ c: InputContext, t: Double) -> (keys: [Double], pointer: [Double]) {
        // secondsSinceX is "time since the last event"; turning it into an absolute event time lets us
        // look for key presses that are reported slightly after the vibration they caused.
        var keys: [Double] = [], pointer: [Double] = []
        if c.secondsSinceKey < 60 {
            let k = t - c.secondsSinceKey
            if keyTimes.last.map({ abs(k - $0) > 0.005 }) ?? true { append(&keyTimes, k); keys.append(k) }
        }
        if c.secondsSinceKeyUp < 60 {
            let u = t - c.secondsSinceKeyUp
            if keyUpTimes.last.map({ abs(u - $0) > 0.005 }) ?? true { append(&keyUpTimes, u) }
        }
        if c.secondsSinceMouse < 60 {
            let m = t - c.secondsSinceMouse
            if mouseTimes.last.map({ abs(m - $0) > 0.005 }) ?? true { append(&mouseTimes, m); pointer.append(m) }
        }
        return (keys, pointer)
    }

    private func append(_ a: inout [Double], _ v: Double) {
        a.append(v)
        if a.count > 32 { a.removeFirst(a.count - 32) }
    }
}
