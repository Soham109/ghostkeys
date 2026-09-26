import Foundation

/// Runs a program with a timeout and collects its output (both pipes drained concurrently so a chatty child never
/// blocks).
enum ProcessRunner {
    struct Result { var status: Int32; var stdout: String; var stderr: String; var timedOut: Bool }

    static func run(_ path: String, _ args: [String], timeout: TimeInterval = 10) -> Result {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err

        let lock = NSLock()
        var outData = Data(), errData = Data()
        let group = DispatchGroup()
        for (pipe, isOut) in [(out, true), (err, false)] {
            group.enter()
            DispatchQueue.global().async {
                let d = pipe.fileHandleForReading.readDataToEndOfFile()
                lock.lock()
                if isOut { outData = d.prefix(64 * 1024) } else { errData = d.prefix(64 * 1024) }
                lock.unlock()
                group.leave()
            }
        }

        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        do { try p.run() } catch {
            out.fileHandleForWriting.closeFile(); err.fileHandleForWriting.closeFile()
            return Result(status: -1, stdout: "", stderr: "could not start \(path): \(error.localizedDescription)", timedOut: false)
        }
        var timedOut = false
        if done.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            p.terminate()
            if done.wait(timeout: .now() + 1) == .timedOut {
                kill(p.processIdentifier, SIGKILL)
                done.wait()
            }
        }
        _ = group.wait(timeout: .now() + 2)
        lock.lock(); defer { lock.unlock() }
        return Result(status: p.terminationStatus,
                      stdout: String(decoding: outData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                      stderr: String(decoding: errData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines),
                      timedOut: timedOut)
    }

    static func osascript(_ source: String) -> Result {
        run("/usr/bin/osascript", ["-e", source], timeout: 5)
    }
}
