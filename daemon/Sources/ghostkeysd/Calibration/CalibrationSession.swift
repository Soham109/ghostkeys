import Foundation
import GhostkeysDetection

/// State of one calibration run. Owned and mutated only on the daemon's core queue.
final class CalibrationSession {
    enum Phase: Equatable {
        case idle                                   // started, waiting for calibration_zone / _doubles / _negatives
        case capturing(zone: String)
        case doubles(zone: String, target: Int)     // the user double-taps in their own rhythm
        case negatives(until: Double)               // mach-clock seconds
    }

    static let postures: Set<String> = ["desk", "lap", "stand"]
    static let strengths: Set<String> = ["soft", "firm"]

    let zones: [String]
    let target: Int
    /// Where the laptop was during this session: stored with every sample (per-posture models later).
    let posture: String
    /// Soft / firm label for the taps of the current zone phase (nil = not said).
    private(set) var strength: String?
    let trainer = Trainer()
    private(set) var phase: Phase = .idle
    private(set) var counts: [String: Int] = [:]
    private(set) var samples: [ConfigStore.LabeledSample] = []

    // Doubles: the unpaired first tap, pairs per zone, and every measured gap (seconds).
    private var pendingFirst: (t: Double, zone: String)?
    private(set) var pairs: [String: Int] = [:]
    private(set) var gaps: [Double] = []
    static let maxDoubleGap = 0.7

    init(zones: [String], target: Int, posture: String) {
        self.zones = zones
        self.target = max(1, min(500, target))
        self.posture = posture
    }

    func beginZone(_ zone: String, strength: String?) {
        phase = .capturing(zone: zone)
        self.strength = strength
    }

    func beginDoubles(_ zone: String, target: Int) {
        phase = .doubles(zone: zone, target: max(1, min(50, target)))
        pendingFirst = nil
        strength = nil
    }

    func beginNegatives(seconds: Double, now: Double) {
        phase = .negatives(until: now + max(1, min(600, seconds)))
        strength = nil
    }

    func endPhase() { phase = .idle; pendingFirst = nil }

    /// A zone tap (single). Returns the zone's new count, or nil if that zone already reached its target.
    func addZoneTap(_ f: TapFeatures, zone: String) -> Int? {
        let c = counts[zone, default: 0]
        guard c < target else { return nil }
        add(f, label: zone, kind: "single")
        return c + 1
    }

    /// A tap during the doubles phase. Both taps of a pair become samples of the zone (the second rides on the
    /// first one's ringing, so it looks different and is worth learning). Returns the pair count and, when this tap
    /// completed a pair, its gap.
    func addDoubleTap(_ f: TapFeatures, zone: String, t: Double) -> (pairs: Int, gap: Double?) {
        if let first = pendingFirst, first.zone == zone, t - first.t >= 0.05, t - first.t <= Self.maxDoubleGap {
            let gap = t - first.t
            pendingFirst = nil
            gaps.append(gap)
            pairs[zone, default: 0] += 1
            add(f, label: zone, kind: "double2")
            return (pairs[zone]!, gap)
        }
        pendingFirst = (t, zone)
        add(f, label: zone, kind: "double1")
        return (pairs[zone, default: 0], nil)
    }

    /// A candidate during negatives (everything is "none").
    func addNegative(_ f: TapFeatures, now: Double) -> Bool {
        guard case .negatives(let until) = phase, now < until else { return false }
        add(f, label: "none", kind: "negative")
        return true
    }

    /// The user's double-tap window: 90th percentile of their gaps plus 80 ms, clamped to 250...500 ms.
    var suggestedDoubleWindowMs: Double? {
        guard gaps.count >= 3 else { return nil }
        let sorted = gaps.sorted()
        let p90 = sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * 0.9).rounded(.up)))]
        return min(500, max(250, (p90 * 1000 + 80).rounded()))
    }

    private func add(_ f: TapFeatures, label: String, kind: String) {
        trainer.add(f, label: label)
        counts[label, default: 0] += 1
        samples.append(.init(label: label, features: f, posture: posture, strength: label == "none" ? nil : strength, kind: kind))
    }
}
