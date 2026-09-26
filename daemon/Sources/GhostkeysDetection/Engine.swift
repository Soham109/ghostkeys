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
// Pulses that ring longer than 80 ms delay the decision until they end (max 120 ms + 15 ms quiet).

import Foundation

/// Streaming tap detector + classifier + gesture grammar. Feed every IMU sample in order.
public final class TapEngine {
    public var settings: DetectionSettings
    public var model: ZoneModel?

    /// Zones that have a binding needing more than one tap (double, triple, rhythm, sequence).
    /// Taps in other zones emit gesture "tap" immediately; taps in these zones wait for the
    /// double-tap window to close. See GestureGrammar.swift for the exact rules.
    public var zonesNeedingMultiTap: Set<String> {
        get { grammar.zonesNeedingMultiTap }
        set { grammar.zonesNeedingMultiTap = newValue }
    }

    /// Calibration capture: skips the typing, trackpad and burst gates so keystrokes and clicks can
    /// be captured as "none" negatives. The paused and motion gates still apply.
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
    private var mouseTimes: [Double] = []
    /// Key events can be delivered a little after the vibration they caused.
    private let lateInputTolerance = 0.08
    private let trackpadGate = 0.15

    private struct InFlight {
        var info: OnsetInfo
        var width: Double?
        var tooLong = false
        var gravityAtOnset: SIMD3<Double>
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
        keyTimes.removeAll(); mouseTimes.removeAll()
        inFlight.removeAll()
        activePulseIndex = nil
    }

    public func ingest(_ s: IMUSample, context: InputContext) -> [DetectorEvent] {
        var out: [DetectorEvent] = []
        let index = history.count
        history.append(s)
        recordInput(context, t: s.t)

        onset.sensitivity = settings.sensitivity
        grammar.doubleWindow = settings.doubleWindowMs / 1000

        // Gravity, motion and tilt.
        if gravity.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t), tiltEnabled {
            if let name = tilt.process(gravity: gravity.gravity, t: s.t), !context.paused {
                out.append(.gesture(GestureEvent(t: s.t, gesture: name, zone: nil, zones: [], modifiers: context.modifiers, confidence: 1)))
            }
        }

        // Onset detection and pulse tracking.
        if let o = onset.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t, index: index) {
            switch o {
            case .onset(let info):
                inFlight.append(InFlight(
                    info: info, gravityAtOnset: gravity.gravity, movingAtOnset: gravity.wasMoving(at: s.t),
                    typingAtOnset: context.secondsSinceKey * 1000 < settings.typingGateMs,
                    trackpadAtOnset: context.secondsSinceMouse < trackpadGate,
                    modifiers: context.modifiers))
                activePulseIndex = index
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
            if f.typingAtOnset || keyTimes.contains(where: { $0 >= t - gate && $0 <= t + lateInputTolerance }) {
                return reject(.typing)
            }
            if f.trackpadAtOnset || mouseTimes.contains(where: { $0 >= t - trackpadGate && $0 <= t + lateInputTolerance }) {
                return reject(.trackpad)
            }
            if f.info.burst { return reject(.burst) }
        }
        if f.tooLong || f.movingAtOnset || GravityMonitor.angle(f.gravityAtOnset, gravity.gravity) > gravity.motionDegrees {
            return reject(.motion)
        }

        let features = extractor.extract(history: history, onset: f.info.index, pulseWidth: f.width ?? 0, t: t)
        var out: [DetectorEvent] = [.candidate(features)]
        guard let model else { return out }

        let r = model.classify(features)
        guard r.zone != ZoneModel.noneLabel, r.confidence >= settings.minConfidence else {
            out.append(.rejected(t: t, reason: .low_confidence))
            return out
        }
        // Strength 0...1: 0 at the trigger threshold, 1 at 20x the threshold (log scale).
        let peakMg = pow(10, features[.strength])
        let thrMg = max(f.info.threshold * 1000, 1e-3)
        let strength = Stats.clamp(log10(max(peakMg / thrMg, 1e-9)) / log10(20), 0, 1)
        let tap = TapEvent(t: t, zone: r.zone, confidence: r.confidence, x: r.x, y: r.y, strength: strength, modifiers: f.modifiers)
        out.append(.tap(tap))
        for g in grammar.accept(tap) { out.append(.gesture(g)) }
        return out
    }

    private func recordInput(_ c: InputContext, t: Double) {
        // secondsSinceX is "time since the last event"; turning it into an absolute event time lets us
        // look for key presses that are reported slightly after the vibration they caused.
        if c.secondsSinceKey < 60 {
            let k = t - c.secondsSinceKey
            if keyTimes.last.map({ abs(k - $0) > 0.005 }) ?? true { append(&keyTimes, k) }
        }
        if c.secondsSinceMouse < 60 {
            let m = t - c.secondsSinceMouse
            if mouseTimes.last.map({ abs(m - $0) > 0.005 }) ?? true { append(&mouseTimes, m) }
        }
    }

    private func append(_ a: inout [Double], _ v: Double) {
        a.append(v)
        if a.count > 32 { a.removeFirst(a.count - 32) }
    }
}
