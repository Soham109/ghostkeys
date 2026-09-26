import Foundation
import CryptoKit
import Darwin

/// User-approved powerful actions (SAFETY_AUDIT H4).
///
/// `shell`, `applescript`, `shortcut` and `open` actions only run if the action carries `approvedHash`, that hash equals
/// the SHA-256 of the action's canonical JSON, and the hash is listed in approved.json. approved.json is written only
/// by the daemon, when an authenticated client sends `approve_action` (the app shows a native confirmation first).
final class ApprovalStore: @unchecked Sendable {
    static let gatedKinds: Set<String> = ["shell", "applescript", "shortcut", "open"]
    /// Fields that do not change what an action does and are left out of the hash.
    static let unhashedFields: Set<String> = ["approvedHash", "label", "delayMs"]
    static let maxEntries = 1000

    let url: URL
    private let lock = NSLock()
    private var hashes: Set<String> = []

    init(directory: URL) {
        url = directory.appendingPathComponent("approved.json")
        if let data = try? Data(contentsOf: url),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let list = obj["hashes"] as? [String] {
            hashes = Set(list.filter { $0.count == 64 })
        }
    }

    /// Canonical form: the action object without `approvedHash`, `label` and `delayMs`, keys sorted, no whitespace,
    /// slashes not escaped. The daemon is the only party that computes it; `approve_action` returns the hash.
    static func canonicalJSON(_ action: JSONValue) -> Data? {
        guard case .object(var o) = action else { return nil }
        for f in unhashedFields { o.removeValue(forKey: f) }
        return try? JSONSerialization.data(withJSONObject: JSONValue.object(o).any,
                                           options: [.sortedKeys, .withoutEscapingSlashes, .fragmentsAllowed])
    }

    static func hash(_ action: JSONValue) -> String? {
        guard let data = canonicalJSON(action) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    static func needsApproval(_ action: JSONValue) -> Bool {
        gatedKinds.contains(action["kind"]?.string ?? "")
    }

    /// Nil if the action may run, otherwise the reason it may not.
    func check(_ action: JSONValue) -> String? {
        guard Self.needsApproval(action) else { return nil }
        guard let claimed = action["approvedHash"]?.string else { return "not approved: this action needs approval in the app first" }
        guard let actual = Self.hash(action), SessionToken.constantTimeEqual(claimed, actual) else {
            return "not approved: the action changed since it was approved"
        }
        lock.lock(); defer { lock.unlock() }
        return hashes.contains(actual) ? nil : "not approved: approval was revoked or never given"
    }

    func approve(_ action: JSONValue) throws -> String {
        guard Self.needsApproval(action) else { throw ActionError("only shell, applescript, shortcut and open actions need approval") }
        guard let h = Self.hash(action) else { throw ActionError("invalid action") }
        lock.lock(); defer { lock.unlock() }
        guard hashes.count < Self.maxEntries || hashes.contains(h) else { throw ActionError("too many approved actions") }
        hashes.insert(h)
        try save()
        return h
    }

    /// Revokes by hash. Returns whether it was present.
    func revoke(hash: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let had = hashes.remove(hash) != nil
        if had { try save() }
        return had
    }

    private func save() throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "hashes": hashes.sorted()],
                                              options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: .atomic)
        chmod(url.path, 0o600)
    }
}

/// Second line of defence after approval: refuse obviously dangerous commands even when approved.
/// Text is normalized first (quotes, backslashes, `$'..'` quoting, AppleScript raw codes) so trivial obfuscation
/// such as `su""do` does not slip through. This is a speed bump, not a wall; approval is the real control.
enum CommandFilter {
    private static let patterns: [(String, String)] = [
        (#"(^|[^a-z0-9_])sudo([^a-z0-9_]|$)"#, "sudo"),
        (#"(^|[^a-z0-9_])doas([^a-z0-9_]|$)"#, "doas"),
        (#"(^|[^a-z0-9_])rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|(-r|-f|-rf|-fr|--recursive|--force)\s+(-r|-f|--recursive|--force))"#, "rm -rf"),
        (#"(^|[^a-z0-9_])diskutil([^a-z0-9_]|$)"#, "diskutil"),
        (#"(^|[^a-z0-9_])csrutil([^a-z0-9_]|$)"#, "csrutil"),
        (#"(^|[^a-z0-9_])launchctl([^a-z0-9_]|$)"#, "launchctl"),
        (#"(^|[^a-z0-9_])defaults\s+write([^a-z0-9_]|$)"#, "defaults write"),
        (#"(^|[^a-z0-9_])networksetup([^a-z0-9_]|$)"#, "networksetup"),
        (#"(^|[^a-z0-9_])tmutil([^a-z0-9_]|$)"#, "tmutil"),
        (#"(^|[^a-z0-9_])(curl|wget)([^a-z0-9_].*)?\|\s*(sudo\s+)?(ba|z|k|da|fi)?sh([^a-z0-9_]|$)"#, "curl | sh"),
        (#"with\s+administrator\s+privileges"#, "with administrator privileges"),
        (#"«\s*class\s+badm\s*»"#, "«class badm»"),
        (#"(^|[^a-z0-9_])class\s+badm([^a-z0-9_]|$)"#, "«class badm»"),
        (#"library/launch(agents|daemons)"#, "launch agents"),
    ]

    static func normalize(_ s: String) -> String {
        var t = s.lowercased()
        t = t.replacingOccurrences(of: "<<", with: "«").replacingOccurrences(of: ">>", with: "»")
        // Drop quoting and escaping characters that the shell removes anyway.
        for ch in ["\"", "'", "`", "\\"] { t = t.replacingOccurrences(of: ch, with: "") }
        t = t.replacingOccurrences(of: "$", with: "")
        // Empty expansions such as ${x} or $() leave braces/parens behind; drop them too.
        for ch in ["{", "}", "(", ")"] { t = t.replacingOccurrences(of: ch, with: " ") }
        t = t.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        return t
    }

    /// Returns the name of the first dangerous pattern found, or nil.
    static func dangerous(_ s: String) -> String? {
        let raw = s.lowercased()
        let norm = normalize(s)
        for (re, name) in patterns {
            if raw.range(of: re, options: .regularExpression) != nil || norm.range(of: re, options: .regularExpression) != nil {
                return name
            }
        }
        return nil
    }
}
