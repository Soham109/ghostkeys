// Lid nudge: the lid is pushed back or pulled forward a little and springs/settles back.
//
// Precise definition:
// - Baseline: the lid angle is "stable" once a reading has been held for 0.5 s (the sensor reports
//   on change, so a reading followed by no new reading for 0.5 s is a held angle). The first reading
//   ever is the initial baseline.
// - An excursion starts with the first reading more than 0.5 degree away from the baseline.
// - It is a nudge if all of these hold:
//     * the deviation from baseline reaches 3 degrees within 0.5 s of the excursion start
//       (slow changes are ignored),
//     * the largest deviation is between 3 and 15 degrees (either direction),
//     * the angle comes back to within 2 degrees of the baseline within 1.5 s of the start.
// - An excursion that does not return in 1.5 s re-baselines at the current angle (the user moved
//   the lid to a new position). An excursion that never reached 3 degrees ends quietly once the
//   angle is back within 0.5 degree of the baseline.

import Foundation

public final class LidGestureDetector {
    public var minDegrees = 3.0
    public var maxDegrees = 15.0
    public var returnDegrees = 2.0
    public var maxDuration = 1.5
    public var maxRiseTime = 0.5
    public var holdForBaseline = 0.5

    private var baseline: Double?
    private var lastAngle: Double = 0
    private var lastChangeT: Double = 0
    private var excursionStart: Double?
    private var peak = 0.0
    private var reachedMinAt: Double?

    public init() {}

    public func reset() { baseline = nil; excursionStart = nil }

    public func ingest(angle: Double, t: Double) -> GestureEvent? {
        guard let base0 = baseline else {
            baseline = angle; lastAngle = angle; lastChangeT = t
            return nil
        }
        var base = base0
        // A reading held long enough becomes the baseline (only when not in an excursion).
        if excursionStart == nil, t - lastChangeT >= holdForBaseline {
            base = lastAngle
            baseline = base
        }
        if angle != lastAngle { lastAngle = angle; lastChangeT = t }
        let dev = angle - base

        guard let start = excursionStart else {
            if abs(dev) > 0.5 {
                excursionStart = t
                peak = dev
                reachedMinAt = abs(dev) >= minDegrees ? t : nil
            }
            return nil
        }

        if abs(dev) > abs(peak) { peak = dev }
        if reachedMinAt == nil, abs(dev) >= minDegrees { reachedMinAt = t }

        if t - start > maxDuration {
            // Did not come back: new resting angle.
            excursionStart = nil
            baseline = angle
            return nil
        }
        if let reached = reachedMinAt {
            guard abs(dev) <= returnDegrees else { return nil }
            // Back near the baseline after a real excursion.
            excursionStart = nil
            guard reached - start <= maxRiseTime, abs(peak) <= maxDegrees else { return nil }
            return GestureEvent(t: t, gesture: "lid_nudge", zone: nil, zones: [], modifiers: [], confidence: 1)
        }
        // Small wobble that never reached 3 degrees: over once it is back at the baseline.
        if abs(dev) <= 0.5 { excursionStart = nil }
        return nil
    }
}
