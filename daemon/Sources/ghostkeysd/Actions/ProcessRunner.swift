import Foundation
import Darwin

/// Runs a program in its own process group with a hard timeout (SAFETY_AUDIT M1).
/// - Output is read on the calling thread with poll(), so no reader thread can be left blocked.
/// - On timeout the whole group is killed (children started with `&` or `nohup` included).
/// - `killAll()` kills every group still alive; it runs at daemon exit.
enum ProcessRunner {
    struct Result { var status: Int32; var stdout: String; var stderr: String; var timedOut: Bool }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var groups = Set<pid_t>()
    private static let outputCap = 64 * 1024

    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 10, stdin: Data? = nil) -> Result {
        var outPipe: [Int32] = [-1, -1], errPipe: [Int32] = [-1, -1], inPipe: [Int32] = [-1, -1]
        guard pipe(&outPipe) == 0, pipe(&errPipe) == 0, pipe(&inPipe) == 0 else {
            return Result(status: -1, stdout: "", stderr: "could not create pipes", timedOut: false)
        }

        var fa: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fa)
        defer { posix_spawn_file_actions_destroy(&fa) }
        posix_spawn_file_actions_adddup2(&fa, inPipe[0], 0)
        posix_spawn_file_actions_adddup2(&fa, outPipe[1], 1)
        posix_spawn_file_actions_adddup2(&fa, errPipe[1], 2)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        defer { posix_spawnattr_destroy(&attr) }
        // Own process group (pgid = child pid) so the whole tree can be killed; close every other inherited fd.
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF))
        posix_spawnattr_setpgroup(&attr, 0)
        var allSignals = sigset_t()
        sigfillset(&allSignals)
        posix_spawnattr_setsigdefault(&attr, &allSignals)   // children must not inherit the daemon's ignored signals

        let argv: [UnsafeMutablePointer<CChar>?] = ([path] + args).map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }

        var pid: pid_t = 0
        let rc = argv.withUnsafeBufferPointer { buf in
            posix_spawn(&pid, path, &fa, &attr, buf.baseAddress, environ)
        }
        close(outPipe[1]); close(errPipe[1]); close(inPipe[0])
        guard rc == 0 else {
            close(outPipe[0]); close(errPipe[0]); close(inPipe[1])
            return Result(status: -1, stdout: "", stderr: "could not start \(path): \(String(cString: strerror(rc)))", timedOut: false)
        }
        lock.lock(); groups.insert(pid); lock.unlock()

        if let stdin, !stdin.isEmpty {
            stdin.withUnsafeBytes { raw in
                var off = 0
                while off < raw.count {
                    let n = write(inPipe[1], raw.baseAddress! + off, raw.count - off)
                    if n <= 0 { break }
                    off += n
                }
            }
        }
        close(inPipe[1])

        var out = Data(), err = Data()
        var open: [Int32: Bool] = [outPipe[0]: true, errPipe[0]: true]
        let deadline = Date().addingTimeInterval(timeout)
        var exited = false, status: Int32 = 0, exitSeenAt: Date?
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)

        while Date() < deadline {
            if !exited {
                var st: Int32 = 0
                if waitpid(pid, &st, WNOHANG) == pid { exited = true; status = st; exitSeenAt = Date() }
            }
            let fds = open.filter(\.value).map(\.key)
            if fds.isEmpty && exited { break }
            // A finished command whose background children still hold the pipes: stop reading shortly after.
            if exited, let at = exitSeenAt, Date().timeIntervalSince(at) > 0.3 { break }
            if fds.isEmpty { usleep(10_000); continue }
            var pfds = fds.map { pollfd(fd: $0, events: Int16(POLLIN), revents: 0) }
            let wait = Int32(max(1, min(100, deadline.timeIntervalSinceNow * 1000)))
            if poll(&pfds, nfds_t(pfds.count), wait) > 0 {
                for p in pfds where p.revents != 0 {
                    let n = read(p.fd, &buffer, buffer.count)
                    if n <= 0 { open[p.fd] = false; continue }
                    if p.fd == outPipe[0] { if out.count < outputCap { out.append(contentsOf: buffer[0..<n]) } }
                    else if err.count < outputCap { err.append(contentsOf: buffer[0..<n]) }
                }
            }
        }
        close(outPipe[0]); close(errPipe[0])

        var timedOut = false
        if !exited {
            timedOut = true
            kill(-pid, SIGTERM)
            let graceEnd = Date().addingTimeInterval(1)
            while Date() < graceEnd {
                var st: Int32 = 0
                if waitpid(pid, &st, WNOHANG) == pid { exited = true; status = st; break }
                usleep(20_000)
            }
            kill(-pid, SIGKILL)
            if !exited { var st: Int32 = 0; waitpid(pid, &st, 0); status = st }
        }
        // The group leader is gone; anything left in the group is a background child. Keep tracking it only while
        // it lives, so it is killed at daemon exit; a timed-out group was already killed.
        lock.lock()
        if timedOut || kill(-pid, 0) != 0 { groups.remove(pid) }
        lock.unlock()

        let code: Int32 = (status & 0x7f) == 0 ? (status >> 8) & 0xff : 128 + (status & 0x7f)
        return Result(status: code,
                      stdout: String(decoding: out, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                      stderr: String(decoding: err, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                      timedOut: timedOut)
    }

    /// Kills every process group this daemon started that is still alive. Async-signal tolerant enough for exit paths.
    static func killAll() {
        lock.lock()
        let all = groups
        groups.removeAll()
        lock.unlock()
        for g in all { kill(-g, SIGKILL) }
    }

    /// Runs AppleScript source out of process (SAFETY_AUDIT H1). The source goes through stdin, not argv.
    static func osascript(_ source: String, timeout: TimeInterval = 5) -> Result {
        run("/usr/bin/osascript", ["-"], timeout: timeout, stdin: Data(source.utf8))
    }
}
