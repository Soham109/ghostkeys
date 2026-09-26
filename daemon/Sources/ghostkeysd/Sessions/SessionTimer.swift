import Foundation

/// Shared bookkeeping for a short hardware session (mic or camera): deadline, reason, periodic ticks.
/// Used only on the daemon's core queue.
final class SessionTimer {
    enum Kind: String { case sound, air, sonar }

    let kind: Kind
    private let queue: DispatchQueue
    private var timer: DispatchSourceTimer?
    private(set) var deadline: Double?          // Clock seconds
    private(set) var reason: String?            // why it started: "request" or "auto:<bundle id>"

    /// Called every second while active, and with `nil` stop reason at start.
    var onTick: (_ secondsLeft: Int) -> Void = { _ in }
    var onExpire: () -> Void = {}

    init(kind: Kind, queue: DispatchQueue) { self.kind = kind; self.queue = queue }

    var active: Bool { deadline != nil }
    var isAuto: Bool { reason?.hasPrefix("auto:") ?? false }
    var secondsLeft: Int { deadline.map { max(0, Int(($0 - Clock.now()).rounded(.up))) } ?? 0 }

    func begin(seconds: Double, reason: String) {
        deadline = Clock.now() + seconds
        self.reason = reason
        timer?.cancel()
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: 1)
        t.setEventHandler { [weak self] in
            guard let self, self.active else { return }
            let left = self.secondsLeft
            if left <= 0 { self.onExpire() } else { self.onTick(left) }
        }
        t.resume()
        timer = t
    }

    func end() {
        timer?.cancel()
        timer = nil
        deadline = nil
        reason = nil
    }
}
