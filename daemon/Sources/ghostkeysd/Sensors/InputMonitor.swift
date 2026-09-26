import Foundation
import AppKit
import CoreGraphics

/// Keyboard / pointer idle times, held modifiers and the frontmost app.
/// `snapshot` is called for every IMU sample (about 800 Hz), so the system queries are refreshed at most every few
/// milliseconds and aged forward in between.
final class InputMonitor: @unchecked Sendable {
    private let lock = NSLock()
    private var frontmost: String?
    private var observer: NSObjectProtocol?

    // Cache (only touched from the caller's serial queue).
    private var cachedAt: Double = -1
    private var keyIdle: Double = 99
    private var mouseIdle: Double = 99
    private var modifiers: Set<String> = []
    private static let refreshInterval = 0.004

    func start() {
        let update: @Sendable () -> Void = { [weak self] in
            let id = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            self?.lock.lock(); self?.frontmost = id; self?.lock.unlock()
        }
        update()
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            let id = app?.bundleIdentifier ?? NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            self?.lock.lock(); self?.frontmost = id; self?.lock.unlock()
        }
    }

    var frontmostBundleID: String? {
        lock.lock(); defer { lock.unlock() }
        return frontmost
    }

    /// Returns (secondsSinceKey, secondsSinceMouse, modifiers) at time `now` (seconds, mach clock).
    func snapshot(now: Double) -> (key: Double, mouse: Double, modifiers: Set<String>) {
        if cachedAt < 0 || now - cachedAt >= Self.refreshInterval || now < cachedAt {
            let src = CGEventSourceStateID.combinedSessionState
            keyIdle = CGEventSource.secondsSinceLastEventType(src, eventType: .keyDown)
            mouseIdle = min(CGEventSource.secondsSinceLastEventType(src, eventType: .mouseMoved),
                            CGEventSource.secondsSinceLastEventType(src, eventType: .leftMouseDown),
                            CGEventSource.secondsSinceLastEventType(src, eventType: .scrollWheel))
            modifiers = Self.modifierNames(CGEventSource.flagsState(src))
            cachedAt = now
            return (keyIdle, mouseIdle, modifiers)
        }
        let age = now - cachedAt
        return (keyIdle + age, mouseIdle + age, modifiers)
    }

    static func modifierNames(_ flags: CGEventFlags) -> Set<String> {
        var s = Set<String>()
        if flags.contains(.maskShift) { s.insert("shift") }
        if flags.contains(.maskControl) { s.insert("control") }
        if flags.contains(.maskAlternate) { s.insert("option") }
        if flags.contains(.maskCommand) { s.insert("command") }
        if flags.contains(.maskSecondaryFn) { s.insert("fn") }
        return s
    }

    /// Current modifiers, uncached (for lid/light gestures).
    static func currentModifiers() -> Set<String> {
        modifierNames(CGEventSource.flagsState(.combinedSessionState))
    }
}
