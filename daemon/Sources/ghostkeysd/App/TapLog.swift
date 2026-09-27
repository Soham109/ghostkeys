import Foundation
import GhostkeysDetection

/// `--log-taps`: one stderr line per tap candidate and what became of it, so a missed or wrong tap can be traced in
/// the terminal. A tap is either too soft to trigger at all, rejected by a gate (typing, trackpad, motion, burst),
/// rejected because the classifier was not sure enough, or accepted; then the gesture either runs a binding or
/// explains why nothing ran. Owned and called only on the daemon's core queue.
struct TapLog {
    let enabled: Bool

    /// A spike that reaches this fraction of the trigger threshold but never the threshold itself is reported as
    /// "too soft". 0.4 of the default 17.5 mg is 7 mg, above the 1 to 4 mg desk noise measured on real recordings.
    static let softFraction = 0.4
    /// Spikes within this long after a detected pulse are its ringing tail, not a separate soft tap.
    static let tailSeconds = 0.3

    private var softPeak = 0.0
    private var softStart = 0.0
    private var softLastAbove = 0.0
    private var lastAboveThreshold = -Double.infinity

    init(enabled: Bool) { self.enabled = enabled }

    // MARK: Spikes that never trigger

    /// Called for every sample. `inputBusy`: a key or the trackpad was just used, so small spikes are expected.
    mutating func track(level: Double, threshold: Double, t: Double, inputBusy: Bool) {
        guard enabled else { return }
        if level >= threshold {
            lastAboveThreshold = t
            softPeak = 0
            return
        }
        if level >= Self.softFraction * threshold, !inputBusy, t - lastAboveThreshold > Self.tailSeconds {
            if softPeak == 0 { softStart = t }
            softPeak = max(softPeak, level)
            softLastAbove = t
        } else if softPeak > 0, t - softLastAbove > 0.05 {
            Self.write(softStart, "too soft     peak \(Self.mg(softPeak)) below the \(Self.mg(threshold)) trigger; "
                       + "never classified (tap firmer, or raise sensitivity)")
            softPeak = 0
        }
    }

    // MARK: Candidates

    func accepted(_ tap: TapEvent, peakMg: Double?, detail: ZoneModel.Result?, labels: [String], minConfidence: Double) {
        guard enabled else { return }
        let weak = tap.confidence < minConfidence
        let guess = detail.map { Self.guess($0, labels) } ?? "\(tap.zone) \(Self.c(tap.confidence))"
        Self.write(tap.t, "ACCEPTED     \(Self.peak(peakMg))  \(guess)"
                   + (weak ? "  (weak: counts only as the 2nd/3rd tap of a multi-tap in \(tap.zone))" : ""))
    }

    func rejected(t: Double, reason: RejectReason, peakMg: Double?, detail: ZoneModel.Result?, labels: [String],
                  minConfidence: Double, sinceKey: Double, sinceMouse: Double, hasModel: Bool) {
        guard enabled else { return }
        let why: String
        switch reason {
        case .low_confidence where detail?.zone == ZoneModel.noneLabel: why = "classifier says this is not a tap"
        case .low_confidence: why = "not sure enough (needs \(Self.c(minConfidence)))"
        case .typing: why = "typing gate (key \(Self.ms(sinceKey)) ago)"
        case .trackpad: why = "trackpad gate (pointer \(Self.ms(sinceMouse)) ago)"
        case .motion: why = "laptop moving, or the pulse lasted too long for a tap"
        case .burst: why = "burst lockout (4+ spikes within 0.5 s)"
        case .paused: why = "paused"
        }
        let guess = detail.map { "  " + Self.guess($0, labels) } ?? (hasModel ? "" : "  (no model: calibrate)")
        Self.write(t, "REJECTED     \(Self.peak(peakMg))\(guess)  -> \(why)")
    }

    /// A candidate the live engine made no decision on (calibration capture, or no model yet).
    func undecided(t: Double, peakMg: Double?, calibrating: Bool, hasModel: Bool) {
        guard enabled else { return }
        let why = calibrating ? "captured for calibration" : hasModel ? "no decision from the live engine" : "no model: calibrate first"
        Self.write(t, "CANDIDATE    \(Self.peak(peakMg))  -> " + why)
    }

    // MARK: Gestures

    func gesture(_ g: GestureEvent, app: String?, _ outcome: String) {
        guard enabled else { return }
        let place = g.gesture == "sequence" ? g.zones.joined(separator: " > ") : (g.zone ?? "-")
        let mods = g.modifiers.isEmpty ? "" : " +" + g.modifiers.sorted().joined(separator: "+")
        Self.write(g.t, "GESTURE      \(g.gesture) on \(place)\(mods) in \(app ?? "?")  -> \(outcome)")
    }

    func action(_ label: String, ok: Bool, error: String?) {
        guard enabled else { return }
        Self.write(Clock.now(), "ACTION       \(label): " + (ok ? "ran" : "failed: \(error ?? "unknown")"))
    }

    // MARK: Formatting

    /// "right-palm 0.91 (next right-edge 0.06)", or why the classifier said none.
    private static func guess(_ r: ZoneModel.Result, _ labels: [String]) -> String {
        let ranked = zip(labels, r.probabilities).sorted { $0.1 > $1.1 }
        let next = ranked.first { $0.0 != r.zone }.map { " (next \($0.0) \(c($0.1)))" } ?? ""
        if r.outOfDistribution { return "none: unlike every calibrated zone (distance \(String(format: "%.1f", r.distance)))" + next }
        if r.zone == ZoneModel.noneLabel { return "none: looks like typing or a click \(c(r.confidence))" + next }
        return "\(r.zone) \(c(r.confidence))" + next
    }

    private static func write(_ t: Double, _ s: String) {
        Log.info("tap \(String(format: "%9.3f", t - Clock.start))s  " + s)
    }
    private static func c(_ v: Double) -> String { String(format: "%.2f", v) }
    private static func mg(_ g: Double) -> String { String(format: "%.1f mg", g * 1000) }
    private static func ms(_ s: Double) -> String { s > 60 ? "long" : String(format: "%.0f ms", s * 1000) }
    private static func peak(_ mg: Double?) -> String { mg.map { String(format: "peak %6.1f mg", $0) } ?? "peak      ? mg" }
}
