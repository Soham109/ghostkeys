// Turns accepted taps into gestures.
//
// Rules (times are tap onset times; gaps are onset to onset):
// - Zones NOT in `zonesNeedingMultiTap`: every tap is emitted as gesture "tap" at once (lowest
//   latency). Such zones never produce double/triple/rhythm.
// - Zones in `zonesNeedingMultiTap`: taps are grouped. A tap joins the open group of the same zone
//   if the gap is 80 ms ... doubleWindow. Gaps under 80 ms are treated as one tap (bounce).
//   The group closes when doubleWindow has passed since its last tap (and no spike that started
//   inside that window is still being analysed), emitting "tap" (1) or "double" (2). A third tap
//   emits "triple" immediately.
// - "rhythm": a single tap, a pause of 350...900 ms (from the single tap to the first tap of the
//   double), then a double in the same zone. It is emitted instead of that "double". The leading
//   single tap has already been emitted as "tap" by then.
// - "sequence": a lone tap in zone A, then a tap in a different zone B within 500 ms. Emits
//   "sequence" with zones [A, B]. Pending (not yet emitted) taps that form the sequence are consumed;
//   taps in immediate zones have already been emitted as "tap" and are emitted anyway.
//
// The daemon should put a zone in `zonesNeedingMultiTap` when any binding for it uses double,
// triple, rhythm or sequence, so those taps do not also fire a plain "tap".

import Foundation

struct GestureGrammar {
    var zonesNeedingMultiTap: Set<String> = []
    var doubleWindow = 0.350
    var minGap = 0.080
    var sequenceWindow = 0.500
    var rhythmPause: ClosedRange<Double> = 0.350...0.900

    private struct Group {
        var zone: String
        var times: [Double]
        var confidences: [Double]
        var modifiers: Set<String>
    }
    private var pending: Group?
    /// Last tap that could start a sequence (a lone tap), with its confidence and modifiers.
    private var lastLone: (zone: String, t: Double, confidence: Double, modifiers: Set<String>)?
    /// Last group that closed as a single tap, for rhythm.
    private var lastSingle: (zone: String, t: Double)?

    var hasPending: Bool { pending != nil }
    /// When the pending group would close if nothing else arrives.
    var pendingDeadline: Double? { pending.map { $0.times.last! + doubleWindow } }

    mutating func reset() { pending = nil; lastLone = nil; lastSingle = nil }

    mutating func accept(_ tap: TapEvent) -> [GestureEvent] {
        var out: [GestureEvent] = []
        let z = tap.zone, t = tap.t
        let multi = zonesNeedingMultiTap.contains(z)

        // Bounce: a second trigger under 80 ms in the same zone is the same tap.
        if let p = pending, p.zone == z, let last = p.times.last, t - last < minGap { return out }
        if let l = lastLone, l.zone == z, t - l.t < minGap, !multi { return out }

        // Sequence: lone tap in another zone shortly before.
        if let l = lastLone, l.zone != z, t - l.t <= sequenceWindow {
            let pendingIsThatTap = pending.map { $0.zone == l.zone && $0.times.count == 1 } ?? false
            let otherPending = pending != nil && !pendingIsThatTap
            if !otherPending {
                if pendingIsThatTap { pending = nil }
                if !multi { out.append(gesture("tap", zone: z, zones: [z], t: t, confidence: tap.confidence, modifiers: tap.modifiers)) }
                out.append(gesture("sequence", zone: nil, zones: [l.zone, z], t: t,
                                   confidence: min(l.confidence, tap.confidence), modifiers: l.modifiers.union(tap.modifiers)))
                lastLone = nil
                lastSingle = nil
                return out
            }
        }

        // A different zone (or an expired group) closes the open group first.
        if let p = pending, p.zone != z || t - p.times.last! > doubleWindow {
            out += close()
        }

        if !multi {
            out.append(gesture("tap", zone: z, zones: [z], t: t, confidence: tap.confidence, modifiers: tap.modifiers))
            lastLone = (z, t, tap.confidence, tap.modifiers)
            return out
        }

        if var p = pending {
            p.times.append(t)
            p.confidences.append(tap.confidence)
            if p.times.count >= 3 {
                out.append(gesture("triple", zone: z, zones: [z], t: t, confidence: p.confidences.min()!, modifiers: p.modifiers))
                pending = nil
                lastSingle = nil
            } else {
                pending = p
            }
            lastLone = nil
        } else {
            pending = Group(zone: z, times: [t], confidences: [tap.confidence], modifiers: tap.modifiers)
            lastLone = (z, t, tap.confidence, tap.modifiers)
        }
        return out
    }

    /// Closes the open group once its window has passed. `oldestInFlight` is the onset time of the
    /// oldest spike still being analysed (its tap would arrive later but may belong to the group).
    mutating func tick(now: Double, oldestInFlight: Double?) -> [GestureEvent] {
        guard let deadline = pendingDeadline, now > deadline else { return [] }
        if let o = oldestInFlight, o <= deadline { return [] }
        return close()
    }

    private mutating func close() -> [GestureEvent] {
        guard let p = pending else { return [] }
        pending = nil
        let conf = p.confidences.min() ?? 0
        switch p.times.count {
        case 1:
            lastSingle = (p.zone, p.times[0])
            return [gesture("tap", zone: p.zone, zones: [p.zone], t: p.times[0], confidence: conf, modifiers: p.modifiers)]
        case 2:
            var name = "double"
            if let s = lastSingle, s.zone == p.zone, rhythmPause.contains(p.times[0] - s.t) { name = "rhythm" }
            lastSingle = nil
            return [gesture(name, zone: p.zone, zones: [p.zone], t: p.times[1], confidence: conf, modifiers: p.modifiers)]
        default:
            lastSingle = nil
            return []
        }
    }

    private func gesture(_ name: String, zone: String?, zones: [String], t: Double, confidence: Double,
                         modifiers: Set<String>) -> GestureEvent {
        GestureEvent(t: t, gesture: name, zone: zone, zones: zones, modifiers: modifiers, confidence: confidence)
    }
}
