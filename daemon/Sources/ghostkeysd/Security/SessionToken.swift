import Foundation
import Security
import Darwin

/// Per-launch secret for the WebSocket handshake (SAFETY_AUDIT C1, PROTOCOL.md "Authentication").
/// 32 random bytes, hex encoded, written to ~/Library/Application Support/Ghostkeys/token with mode 0600 on every
/// launch. A parent may also pass its own token in the GHOSTKEYS_TOKEN environment variable; both are accepted.
final class SessionToken: @unchecked Sendable {
    let fileToken: String
    let envToken: String?
    let url: URL

    init(directory: URL) throws {
        url = directory.appendingPathComponent("token")
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ActionError("could not generate a session token")
        }
        fileToken = bytes.map { String(format: "%02x", $0) }.joined()
        let env = ProcessInfo.processInfo.environment["GHOSTKEYS_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        // A weak token from the environment would weaken the whole scheme; require at least 128 bits of hex/text.
        envToken = (env?.count ?? 0) >= 32 ? env : nil
        if env != nil && envToken == nil { Log.error("ignoring GHOSTKEYS_TOKEN: shorter than 32 characters") }
        try write(directory: directory)
    }

    private func write(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Replace atomically-ish: unlink, then create exclusively with 0600 so no other mode ever exists.
        unlink(url.path)
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw ActionError("could not write \(url.path): \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        fchmod(fd, 0o600)
        let line = fileToken + "\n"
        let n = line.withCString { Darwin.write(fd, $0, strlen($0)) }
        guard n == line.utf8.count else { throw ActionError("short write to \(url.path)") }
    }

    /// Constant-time comparison against both accepted tokens.
    func accepts(_ candidate: String?) -> Bool {
        guard let candidate = candidate?.trimmingCharacters(in: .whitespaces), !candidate.isEmpty else { return false }
        var ok = Self.constantTimeEqual(candidate, fileToken)
        if let envToken { ok = Self.constantTimeEqual(candidate, envToken) || ok }
        return ok
    }

    static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let x = Array(a.utf8), y = Array(b.utf8)
        var diff = UInt8(x.count == y.count ? 0 : 1)
        for i in 0..<max(x.count, y.count) {
            diff |= (i < x.count ? x[i] : 0) ^ (i < y.count ? y[i] : 0)
        }
        return diff == 0
    }
}
