import Foundation
import Darwin

/// Single-instance lock: flock on ~/Library/Application Support/Ghostkeys/daemon.lock, held for the process lifetime.
/// The kernel drops the lock when the process dies, however it dies, so a stale file never blocks a new daemon.
enum InstanceLock {
    nonisolated(unsafe) private static var fd: Int32 = -1

    /// Takes the lock or exits with code 4 and a clear message.
    static func acquireOrExit(directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("daemon.lock").path
        let f = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o644)
        guard f >= 0 else {
            Log.error("could not open \(path): \(String(cString: strerror(errno)))")
            exit(4)
        }
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            var buf = [UInt8](repeating: 0, count: 32)
            let n = pread(f, &buf, buf.count, 0)
            let other = n > 0 ? String(decoding: buf.prefix(n), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) : "?"
            Log.error("another ghostkeysd is already running (pid \(other)); not starting a second one")
            exit(4)
        }
        ftruncate(f, 0)
        let pid = "\(getpid())\n"
        _ = pid.withCString { pwrite(f, $0, strlen($0), 0) }
        fd = f   // keep open: closing would release the lock
    }
}

/// Shutdown plumbing that never depends on the main thread or the core queue (SAFETY_AUDIT H1): signal handlers and
/// parent watchers run on their own serial queue and restore the sensors directly.
enum Lifetime {
    static let queue = DispatchQueue(label: "ghostkeys.lifetime", qos: .userInteractive)
    nonisolated(unsafe) private static var signalSources: [DispatchSourceSignal] = []

    /// Restores the sensors, kills any process groups started by actions, and exits.
    static func shutdown(_ reason: String, code: Int32 = 0) -> Never {
        Log.info("\(reason); shutting down")
        SPUDriverControl.shared.restore()
        ProcessRunner.killAll()
        exit(code)
    }

    static func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            src.setEventHandler { shutdown("signal \(sig)") }
            src.resume()
            signalSources.append(src)
        }
    }
}

/// Exits the daemon when the app that started it goes away, so the daemon never outlives it unintentionally.
/// Watches `--parent-pid` (kqueue EVFILT_PROC NOTE_EXIT) and the real parent (reparented to launchd = parent died),
/// with a 2 s polling fallback for both.
final class ParentWatch {
    private var sources: [DispatchSourceProtocol] = []
    private let onParentGone: (String) -> Void
    private var fired = false

    init(onParentGone: @escaping (String) -> Void) { self.onParentGone = onParentGone }

    func start(explicitParent: Int32?) {
        let initialPPID = getppid()
        // Launched directly by launchd (ppid 1) means no parent to follow; only --parent-pid applies then.
        let watchPPID = initialPPID != 1

        if let pid = explicitParent {
            guard Self.alive(pid) else { return trigger("parent pid \(pid) is not running") }
            let src = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: Lifetime.queue)
            src.setEventHandler { [weak self] in self?.trigger("parent pid \(pid) exited") }
            src.resume()
            sources.append(src)
        }
        if watchPPID {
            let src = DispatchSource.makeProcessSource(identifier: initialPPID, eventMask: .exit, queue: Lifetime.queue)
            src.setEventHandler { [weak self] in self?.trigger("parent process \(initialPPID) exited") }
            src.resume()
            sources.append(src)
        }

        let timer = DispatchSource.makeTimerSource(queue: Lifetime.queue)
        timer.schedule(deadline: .now() + 2, repeating: 2)
        timer.setEventHandler { [weak self] in
            if watchPPID, getppid() == 1 { self?.trigger("parent process exited (reparented to launchd)") }
            if let pid = explicitParent, !Self.alive(pid) { self?.trigger("parent pid \(pid) is gone") }
        }
        timer.resume()
        sources.append(timer)
    }

    private func trigger(_ reason: String) {
        guard !fired else { return }
        fired = true
        onParentGone(reason)
    }

    static func alive(_ pid: Int32) -> Bool {
        kill(pid, 0) == 0 || errno == EPERM
    }
}
