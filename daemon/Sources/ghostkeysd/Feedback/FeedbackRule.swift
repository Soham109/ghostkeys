import Foundation
import GhostkeysDetection

/// Which candidate `feedback_missed` may learn from. Feedback samples go straight into training, so a wrong one
/// hurts accuracy: the rule prefers adding nothing over adding a doubtful sample.
enum FeedbackRule {
    /// Look back this far before the request...
    static let lookBack = 5.0
    /// ...but skip the last part: the hand was moving to the pointer / keyboard to send the report.
    static let skipRecent = 0.7
    /// Skip onsets with trackpad or mouse activity this close to them (clicks and palm contact look like taps).
    static let mouseGuard = 0.15
    static let otherZoneMax = 0.8

    struct Verdict { var reason: String?; var probability: Double }

    static func peakG(_ f: TapFeatures) -> Double { pow(10, f[.strength]) / 1000 }

    static func check(_ f: DiagnosticsRecorder.Found, zone: String, now: Double, accepted: [Double], mouseTimes: [Double],
                      model: ZoneModel?) -> Verdict {
        func no(_ r: String) -> Verdict { Verdict(reason: r, probability: 0) }
        guard now - f.t >= skipRecent else { return no("within 0.7 s of the request") }
        guard now - f.t <= lookBack else { return no("older than 5 s") }
        if accepted.contains(where: { abs($0 - f.t) < 0.02 }) { return no("it was accepted as a tap") }
        if mouseTimes.contains(where: { abs($0 - f.t) <= mouseGuard }) { return no("trackpad or mouse activity within 150 ms") }
        guard let model, model.labels.contains(zone) else { return no("zone not calibrated") }

        // Strength: at least half this user's gentle (p10) tap in that zone, else 1.5x the onset floor.
        let peak = peakG(f.features)
        if let p10 = model.peakQuantiles?[zone]?.first {
            if peak < 0.5 * p10 { return no(String(format: "too weak (%.4f g < half the zone's p10 %.4f g)", peak, p10)) }
        } else {
            let floor = (model.onsetFloor ?? ZoneModel.onsetFloorRange.upperBound) * 1.5
            if peak < floor { return no(String(format: "too weak (%.4f g < 1.5x onset floor %.4f g)", peak, floor)) }
        }

        // Classifier: the claimed zone must be in the top 2, and no other zone may be confident (>= 0.8).
        let r = model.classifyDetailed(f.features)
        guard r.probabilities.count == model.labels.count, let zi = model.labels.firstIndex(of: zone) else {
            return no("classifier gave no probabilities")
        }
        let ranked = r.probabilities.indices.sorted { r.probabilities[$0] > r.probabilities[$1] }
        if let other = ranked.first(where: { $0 != zi && model.labels[$0] != ZoneModel.noneLabel && r.probabilities[$0] >= otherZoneMax }) {
            return no("classifier is sure it was \(model.labels[other])")
        }
        guard ranked.prefix(2).contains(zi) else { return no("\(zone) is not among the classifier's top 2") }
        return Verdict(reason: nil, probability: r.probabilities[zi])
    }
}
