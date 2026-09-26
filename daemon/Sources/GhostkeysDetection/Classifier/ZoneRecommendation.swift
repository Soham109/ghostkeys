// Which calibrated zones to keep enabled by default.
//
// Every extra zone is one more class that the others can be confused with. On the first real
// calibration (8 zones), left-edge scored 0.29 and lid 0.65; with both removed, the other zones'
// taps accepted at minConfidence 0.8 went from 0.70 to 0.91 of all taps (left-grille 0.75 to 0.96),
// cross-validated. So weak zones are not just unreliable themselves, they cost the good ones.
//
// Two helpers:
// - `recommendedZones(_ report:)` looks only at a calibration report (what the app has on screen).
// - `Trainer.recommendedZones()` retrains without the weakest zone, re-measures, and repeats, which
//   shows how the remaining zones do once the weak ones are gone.

import Foundation

public struct ZoneRecommendation: Codable, Sendable {
    /// Zones to keep enabled.
    public var keep: [String]
    /// Zones to disable by default, with a short human-readable reason each.
    public var drop: [String: String]
    /// Pairs of zones that are mostly confused with each other: candidates to merge into one zone
    /// (bind the same action to both) instead of dropping.
    public var merge: [[String]]
    /// Expected accuracy per kept zone (from the report, or re-measured without the dropped zones).
    public var expectedAccuracy: [String: Double]
    public init(keep: [String], drop: [String: String], merge: [[String]], expectedAccuracy: [String: Double]) {
        self.keep = keep; self.drop = drop; self.merge = merge; self.expectedAccuracy = expectedAccuracy
    }
}

/// Recommends zones from a calibration report alone.
/// - A zone is dropped if its held-out accuracy is under `minAccuracy`, or if fewer than
///   `minSamples` of its taps were captured (the detector hardly hears that spot).
/// - Two zones are suggested for merging when at least `mergeShare` of one's taps went to the other
///   and they would be fine together (their combined accuracy, counting confusion between them as
///   correct, reaches `minAccuracy`).
public func recommendedZones(_ report: CalibrationReport, minAccuracy: Double = 0.8, minSamples: Int = 8,
                             mergeShare: Double = 0.25) -> ZoneRecommendation {
    let labels = report.labels
    let zones = labels.filter { $0 != ZoneModel.noneLabel }
    var keep: [String] = [], drop: [String: String] = [:], expected: [String: Double] = [:]
    func row(_ z: String) -> [Int] {
        guard let i = labels.firstIndex(of: z), i < report.confusion.count else { return [] }
        return report.confusion[i]
    }
    for z in zones {
        let r = row(z)
        let n = r.reduce(0, +)
        let acc = report.accuracy[z] ?? 0
        if n < minSamples {
            drop[z] = "only \(n) taps were detected during calibration; the sensor barely hears this spot"
        } else if acc < minAccuracy {
            drop[z] = "recognised \(Int((acc * 100).rounded()))% of the time (needs \(Int((minAccuracy * 100).rounded()))%)"
        } else {
            keep.append(z)
            expected[z] = acc
        }
    }
    var merge: [[String]] = []
    for (a, b) in zones.enumerated().flatMap({ (i, a) in zones.dropFirst(i + 1).map { (a, $0) } }) {
        guard let ia = labels.firstIndex(of: a), let ib = labels.firstIndex(of: b) else { continue }
        let ra = row(a), rb = row(b)
        let na = ra.reduce(0, +), nb = rb.reduce(0, +)
        guard na > 0, nb > 0, ib < ra.count, ia < rb.count else { continue }
        let aToB = Double(ra[ib]) / Double(na), bToA = Double(rb[ia]) / Double(nb)
        guard max(aToB, bToA) >= mergeShare else { continue }
        let together = Double(ra[ia] + ra[ib] + rb[ib] + rb[ia]) / Double(na + nb)
        if together >= minAccuracy { merge.append([a, b]) }
    }
    return ZoneRecommendation(keep: keep, drop: drop, merge: merge, expectedAccuracy: expected)
}

extension Trainer {
    /// Drops the weakest zone under `minAccuracy` (or with too few samples), retrains, re-measures,
    /// and repeats until every remaining zone passes. Keeps at least one zone.
    public func recommendedZones(minAccuracy: Double = 0.8, minSamples: Int = 8) -> ZoneRecommendation {
        var dropped: [String: String] = [:]
        var current = self
        var first: ZoneRecommendation?
        while true {
            let report = current.train().1
            let rec = GhostkeysDetection.recommendedZones(report, minAccuracy: minAccuracy, minSamples: minSamples)
            if first == nil { first = rec }
            let zones = report.labels.filter { $0 != ZoneModel.noneLabel }
            guard !rec.drop.isEmpty, zones.count > 1 else {
                return ZoneRecommendation(keep: rec.keep, drop: dropped.merging(rec.drop) { a, _ in a },
                                          merge: first?.merge ?? [], expectedAccuracy: rec.expectedAccuracy)
            }
            // Drop only the single weakest zone per round: removing it may rescue the others.
            let worst = rec.drop.keys.min { (report.accuracy[$0] ?? 0) < (report.accuracy[$1] ?? 0) }!
            dropped[worst] = rec.drop[worst]
            let next = Trainer()
            for (f, l) in current.samples where l != worst { next.add(f, label: l) }
            current = next
        }
    }
}
