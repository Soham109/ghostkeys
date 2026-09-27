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
        keyTimes.removeAll(); keyUpTimes.removeAll(); mouseTimes.removeAll()
        inFlight.removeAll()
        activePulseIndex = nil
    }

    public func ingest(_ s: IMUSample, context: InputContext) -> [DetectorEvent] {
        var out: [DetectorEvent] = []
        let index = history.count
        history.append(s)
        recordInput(context, t: s.t)

        onset.sensitivity = settings.sensitivity
        onset.lightTouch = settings.lightTouch
        onset.learnedFloor = model?.onsetFloor
        onset.captureMode = bypassInputGates
        onset.inputIdle = context.secondsSinceKey > 1 && context.secondsSinceMouse > 1
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

        let features = extractor.extract(history: history, onset: f.info.index, pulseWidth: f.width ?? 0, t: t)
        var out: [DetectorEvent] = [.candidate(features)]
        guard let model else { return out }

        let r = model.classifyDetailed(features)
        guard r.zone != ZoneModel.noneLabel else {
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

    private func recordInput(_ c: InputContext, t: Double) {
        // secondsSinceX is "time since the last event"; turning it into an absolute event time lets us
        // look for key presses that are reported slightly after the vibration they caused.
        if c.secondsSinceKey < 60 {
            let k = t - c.secondsSinceKey
            if keyTimes.last.map({ abs(k - $0) > 0.005 }) ?? true { append(&keyTimes, k) }
        }
        if c.secondsSinceKeyUp < 60 {
            let u = t - c.secondsSinceKeyUp
            if keyUpTimes.last.map({ abs(u - $0) > 0.005 }) ?? true { append(&keyUpTimes, u) }
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
