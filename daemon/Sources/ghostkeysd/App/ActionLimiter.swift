import Foundation

/// Action rate limits (SAFETY_AUDIT H5). Used only on the daemon's core queue.
/// - Per binding: a cooldown after each run (300 ms; 1500 ms for cover, cover_hold, lid_nudge and tilt gestures) and at
///   most one run waiting or in progress.
/// - Globally: at most 5 actions per second and 60 per minute. Tripping a global limit auto-pauses the daemon.
struct ActionLimiter {
    enum Verdict: Equatable { case ok, cooldown, tripped(String) }

    static let defaultCooldown = 0.300
    static let slowGestureCooldown = 1.5
    static let slowGestures: Set<String> = ["cover", "cover_hold", "lid_nudge", "tilt_left", "tilt_right"]
    static let perSecond = 5
    static let perMinute = 60

    private var lastRun: [String: Double] = [:]
    private var running: Set<String> = []
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

    mutating func finished(bindingId: String) { running.remove(bindingId) }

    /// On resume: start counting afresh (running bindings stay tracked until they finish).
    mutating func reset() { recent.removeAll() }
}
