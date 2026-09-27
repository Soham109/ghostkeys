// Notices when taps stop looking like the calibration, and then only lets clear-cut taps through.
//
// Why: a zone model describes the machine as it was during calibration (posture, surface, how hard the user
// tapped). On the user's three real calibrations (26 Sep 2026), a model from one session applied to another
// session's taps picked the right zone 0 to 56% of the time, yet still accepted 6.8% of all candidates as a
// confident wrong zone or a typing spike (analysis/bench, "cross"). The confidence is calibrated inside the
// session, so it cannot know the session changed.
//
// What gives it away is distance: taps from the calibrated session sit at a median 0.16 to 0.33 of the reject
// distance from their zone mean, taps from a different session at 0.40 to 1.21, for nearly every tap. One tap is
// ambiguous; eight in a row are not. So the guard keeps the distance (in units of the model's typical
// calibration distance) of the last `window` pieces of evidence from the last `memory` seconds, and when their
// median exceeds `unfamiliarRatio` it switches to strict mode: a tap then needs confidence >= `strictConfidence`
// and distance <= `strictDistanceRatio` typical distances. Measured with daemon/analysis/bench: cross-session false
// accepts 0.055 -> 0.033 per candidate on top of the tighter reject distance. That is the guard's only measured
// win; the end of false taps while handling the machine came from the onset tail-guard fix, and the saved-model
// win from `ZoneModel.upgraded()` (docs/review/VERIFY_07_DETECTION.md, finding 1).
//
// What counts as evidence (round 2, 27 Sep 2026, docs/review/DETECTION_ROUND2.md): only candidates the classifier
// is at least `evidenceConfidence` sure are a tap of some zone, judged before the reject distance. That is a zone it
// accepted with that confidence, or a candidate the reject distance turned away although the zone vote alone was that
// sure (a tap that looks like a zone but sits too far from it: the typical symptom of a changed posture). A spike the
// classifier already calls "none" or only half believes is junk (a palm landing, a bump), not a sign that the
// user's taps changed. The guard used to count every candidate, so a few such spikes switched strict mode on:
// with the live model (calib2), one typing spike that got past the gates before each tap made 61% of taps arrive in
// strict mode, two made 91%; now 0% with a freshly trained model and 9% / 42% with the upgraded saved model (which is
// confident about more typing spikes). Cross-session false accepts stay at 0.034 (0.033 before; one candidate).
//
// Clear-cut taps still pass in strict mode, so when the user goes back to the calibrated posture the median
// recovers within a few taps. The daemon can show `isUnfamiliar` ("taps don't look like your calibration:
// recalibrate in this position?").

import Foundation

public struct FamiliarityGuard: Sendable {
    /// Which classified candidates feed the guard.
    public enum Evidence: String, Sendable, Codable {
        /// Candidates the classifier is at least `evidenceConfidence` sure are a tap of some zone (default).
        case confidentTaps
        /// Every classified candidate, junk included (the 27 Sep 2026 behaviour, kept for comparison).
        case everyCandidate
    }

    public var window = 8
    public var memory = 600.0
    public var unfamiliarRatio = 1.8
    public var strictConfidence = 0.9
    public var strictDistanceRatio = 3.0
    public var evidence = Evidence.confidentTaps
    /// How sure the classifier must be that a candidate is a tap for it to count as evidence. The default equals the
    /// default `DetectionSettings.minConfidence`: evidence is what would fire as a tap.
    public var evidenceConfidence = 0.8

    private var recent: [(t: Double, ratio: Double)] = []

    public init() {}

    public mutating func reset() { recent.removeAll() }

    /// Median distance ratio of the remembered evidence (nil until 3 are known).
    public var medianRatio: Double? {
        recent.count >= 3 ? Stats.median(recent.map(\.ratio)) : nil
    }

    /// True while recent evidence sits far from the calibration.
    public var isUnfamiliar: Bool { (medianRatio ?? 0) > unfamiliarRatio }

    /// Whether a classified candidate says something about the user's taps (see the file header).
    public func isEvidence(_ r: ZoneModel.Result) -> Bool {
        switch evidence {
        case .everyCandidate: return true
        case .confidentTaps:
            if r.zone != ZoneModel.noneLabel { return r.confidence >= evidenceConfidence }
            return r.outOfDistribution && (r.zoneConfidence ?? 0) >= evidenceConfidence
        }
    }

    /// Looks at one classified candidate (made at time `t`), remembers it if it is evidence, and returns whether a
    /// tap with this result may fire. Models without `typicalDistance` (call `ZoneModel.upgraded()` first) are
    /// always admitted.
    public mutating func admit(_ r: ZoneModel.Result, model: ZoneModel, t: Double) -> Bool {
        guard let typical = model.typicalDistance, typical > 0, r.distance.isFinite else { return true }
        let ratio = r.distance / typical
        if isEvidence(r) { recent.append((t, ratio)) }
        recent.removeAll { t - $0.t > memory }
        if recent.count > window { recent.removeFirst(recent.count - window) }
        guard isUnfamiliar else { return true }
        return r.confidence >= strictConfidence && ratio <= strictDistanceRatio
    }
}
