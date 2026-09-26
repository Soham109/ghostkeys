import Foundation
import Darwin

/// The same single-instance lock ghostkeysd takes (flock on <config dir>/daemon.lock, default
/// ~/Library/Application Support/Ghostkeys/daemon/daemon.lock),
/// so the lab tool and the daemon never drive the sensor drivers at the same time (SAFETY_AUDIT M2).
/// Held until the process exits; the kernel releases it however the process ends.
enum LabInstanceLock {
    nonisolated(unsafe) private static var fd: Int32 = -1

    static func acquire() throws {
        guard fd < 0 else { return }
        // The sensor lock is machine-wide: always the default daemon directory, like ghostkeysd (never --config-dir).
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        let dir = base.appendingPathComponent("Ghostkeys/daemon", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("daemon.lock").path
        let f = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o644)
        guard f >= 0 else { throw LabError("could not open \(path): \(String(cString: strerror(errno)))") }
        if flock(f, LOCK_EX | LOCK_NB) != 0 {
            var buf = [UInt8](repeating: 0, count: 32)
            let n = pread(f, &buf, buf.count, 0)
            close(f)
            let other = n > 0 ? String(decoding: buf.prefix(n), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) : "?"
            throw LabError("ghostkeysd (or another lab session) is using the sensors (pid \(other)); stop it first")
        }
        ftruncate(f, 0)
        let pid = "\(getpid())\n"
        _ = pid.withCString { pwrite(f, $0, strlen($0), 0) }
        fd = f
    }
}
