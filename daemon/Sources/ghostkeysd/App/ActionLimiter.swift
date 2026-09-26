import Foundation

/// Action rate limits (SAFETY_AUDIT H5). Used only on the daemon's core queue.
/// - Per binding: a cooldown after each run (300 ms; 1500 ms for cover, cover_hold, lid_nudge and tilt gestures) and at
///   most one run waiting or in progress. Sound gestures (rub, wave) and palm swipes also use 1500 ms.
/// - Globally: at most 5 actions per second and 60 per minute. Tripping a global limit auto-pauses the daemon.
struct ActionLimiter {
    enum Verdict: Equatable { case ok, cooldown, tripped(String) }

    static let defaultCooldown = 0.300
    static let slowGestureCooldown = 1.5
    static let slowGestures: Set<String> = ["cover", "cover_hold", "lid_nudge", "tilt_left", "tilt_right",
                                            "rub", "rub_left", "rub_right", "wave_toward", "wave_away", "wave_sweep",
                                            "palm_swipe_left", "palm_swipe_right", "sweep_left", "sweep_right", "push", "pull"]
    static let perSecond = 5
    static let perMinute = 60

    private var lastRun: [String: Double] = [:]
    private var running: Set<String> = []
    private var knobInFlight: [String: Int] = [:]
    static let maxKnobInFlight = 3
    private var recent: [Double] = []

    mutating func admit(bindingId: String, gesture: String, now: Double) -> Verdict {
        let cooldown = Self.slowGestures.contains(gesture) ? Self.slowGestureCooldown : Self.defaultCooldown
        if running.contains(bindingId) { return .cooldown }
        if let last = lastRun[bindingId], now - last < cooldown { return .cooldown }
        let g = admitGlobal(now: now)
        guard g == .ok else { return g }
        lastRun[bindingId] = now
        running.insert(bindingId)
        return .ok
    }

    /// Counts one action against the global limits.
    mutating func admitGlobal(now: Double) -> Verdict {
        recent = recent.filter { now - $0 < 60 }
        if recent.filter({ now - $0 < 1 }).count >= Self.perSecond { return .tripped("more than \(Self.perSecond) actions per second") }
        if recent.count >= Self.perMinute { return .tripped("more than \(Self.perMinute) actions per minute") }
        recent.append(now)
        return .ok
    }

    mutating func finished(bindingId: String) {
        if let n = knobInFlight[bindingId], n > 0 { knobInFlight[bindingId] = n - 1 } else { running.remove(bindingId) }
    }

    /// One knob step. Steps never trip the auto-pause: a step that would exceed a global limit, or that finds 3 steps of
    /// the same binding still queued or running, is dropped instead.
    mutating func admitKnobStep(bindingId: String, now: Double) -> Bool {
        guard knobInFlight[bindingId, default: 0] < Self.maxKnobInFlight else { return false }
        recent = recent.filter { now - $0 < 60 }
        guard recent.filter({ now - $0 < 1 }).count < Self.perSecond, recent.count < Self.perMinute else { return false }
        recent.append(now)
        knobInFlight[bindingId, default: 0] += 1
        return true
    }

    /// On resume: start counting afresh (running bindings stay tracked until they finish).
    mutating func reset() { recent.removeAll() }
}
