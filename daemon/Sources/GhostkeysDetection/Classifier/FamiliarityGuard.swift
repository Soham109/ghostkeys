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
// calibration distance) of the last `window` classified candidates from the last `memory` seconds, and when their
// median exceeds `unfamiliarRatio` it switches to strict mode: a tap then needs confidence >= `strictConfidence`
// and distance <= `strictDistanceRatio` typical distances. Measured on the real calibrations with the live
// decision rule: cross-session false accepts 0.031 -> 0.020 per candidate on top of the tighter reject distance,
// in-session recall unchanged (strict mode never engaged in-session).
//
// Clear-cut taps still pass in strict mode, so when the user goes back to the calibrated posture the median
// recovers within a few taps. The daemon can show `isUnfamiliar` ("taps don't look like your calibration:
// recalibrate in this position?").

import Foundation

public struct FamiliarityGuard: Sendable {
    public var window = 8
    public var memory = 600.0
    public var unfamiliarRatio = 1.8
    public var strictConfidence = 0.9
    public var strictDistanceRatio = 3.0

    private var recent: [(t: Double, ratio: Double)] = []

    public init() {}

    public mutating func reset() { recent.removeAll() }

    /// Median distance ratio of the remembered candidates (nil until 3 are known).
    public var medianRatio: Double? {
        recent.count >= 3 ? Stats.median(recent.map(\.ratio)) : nil
    }

    /// True while recent candidates sit far from the calibration.
    public var isUnfamiliar: Bool { (medianRatio ?? 0) > unfamiliarRatio }

    /// Records one classified candidate (made at time `t`) and returns whether a tap with this result may fire.
    /// Models without `typicalDistance` (call `ZoneModel.upgraded()` first) are always admitted.
    public mutating func admit(_ r: ZoneModel.Result, model: ZoneModel, t: Double) -> Bool {
        guard let typical = model.typicalDistance, typical > 0, r.distance.isFinite else { return true }
        let ratio = r.distance / typical
        recent.append((t, ratio))
        recent.removeAll { t - $0.t > memory }
        if recent.count > window { recent.removeFirst(recent.count - window) }
        guard isUnfamiliar else { return true }
        return r.confidence >= strictConfidence && ratio <= strictDistanceRatio
    }
}
