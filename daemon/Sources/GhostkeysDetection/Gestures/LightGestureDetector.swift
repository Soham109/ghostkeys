// Cover the ambient light sensor with a hand.
//
// Precise definition:
// - Baseline: exponential average of the light value with a 5 s time constant, updated only while
//   not covered. Ignored entirely while the baseline is below 0.05 (a dark room: covering changes
//   nothing measurable).
// - Covered: the value falls below 30% of the baseline (a drop of more than 70%) and some reading
//   in the previous 0.5 s was still at 60% of the baseline or more (a fast drop; dimming lights or
//   a cloud are slow).
// - "cover": the value comes back above 50% of the pre-cover baseline within 2 s, and "cover_hold"
//   was not emitted for this cover.
// - "cover_hold": still covered 1.2 s after the drop. Emitted once per cover; the release after a
//   hold emits nothing (so one hand gesture never fires two actions).
// - Covered for more than 10 s: treated as a lighting change; re-baseline.
//
// The sensor may only report on change, so call `poll(t:)` periodically (every 100 ms or so) for
// cover_hold to fire on time. `ingest` also runs the same timing check.

import Foundation

public final class LightGestureDetector {
    public var dropFraction = 0.30
    public var fastDropWindow = 0.5
    public var recoverFraction = 0.5
    public var coverMaxDuration = 2.0
    public var holdAfter = 1.2
    public var darkBaseline = 0.05
    public var baselineSeconds = 5.0

    private var baseline: Double?
    private var lastT: Double?
    private var history: [(t: Double, v: Double)] = []
    private var coverStart: Double?
    private var coverBaseline = 0.0
    private var holdEmitted = false

    public init() {}

    public func reset() { baseline = nil; lastT = nil; history.removeAll(); coverStart = nil }

    public func ingest(value: Double, t: Double) -> GestureEvent? {
        let v = Stats.clamp(value, 0, 1)
        defer { lastT = t }
        guard let base = baseline else {
            baseline = v
            history.append((t, v))
            return nil
        }

        if let start = coverStart {
            if v >= recoverFraction * coverBaseline {
                coverStart = nil
                history.removeAll()
                history.append((t, v))
                if !holdEmitted && t - start <= coverMaxDuration { return event("cover", t) }
                return nil
            }
            if t - start > 10 {
                coverStart = nil
                baseline = v
                history.removeAll()
                return nil
            }
            return poll(t: t)
        }

        // Not covered.
        history.append((t, v))
        while let first = history.first, t - first.t > fastDropWindow { history.removeFirst() }
        if base >= darkBaseline, v < dropFraction * base,
           history.contains(where: { $0.v >= 0.6 * base }) {
            coverStart = t
            coverBaseline = base
            holdEmitted = false
            return nil
        }
        let dt = lastT.map { max(0, t - $0) } ?? 0
        baseline = base + min(1, dt / baselineSeconds) * (v - base)
        return nil
    }

    /// Time-based check for cover_hold when no new readings arrive.
    public func poll(t: Double) -> GestureEvent? {
        guard let start = coverStart, !holdEmitted, t - start >= holdAfter else { return nil }
        holdEmitted = true
        return event("cover_hold", t)
    }

    private func event(_ name: String, _ t: Double) -> GestureEvent {
        GestureEvent(t: t, gesture: name, zone: nil, zones: [], modifiers: [], confidence: 1)
    }
}
