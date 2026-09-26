import Foundation

/// One key press for the daemon to post after a command, in the same shape as a `keystroke` action:
/// `key` uses the daemon's key names ("u", "left", "tab", "f5"), `modifiers` uses "cmd", "shift", "ctrl", "option".
public struct KeyStroke: Codable, Equatable, Sendable {
    public var key: String
    public var modifiers: [String]

    public init(_ key: String, _ modifiers: [String] = []) {
        self.key = key
        self.modifiers = modifiers
    }
}

/// What a command produced.
public struct IntegrationResult: Codable, Equatable, Sendable {
    /// Human readable result ("Copied https://...", "Song by Artist", "true").
    public var output: String
    /// Keys the daemon should post, in order, to the frontmost app once the command returns.
    /// The runner has already brought the target app to the front when this is non-empty.
    public var followUpKeys: [KeyStroke]

    public init(output: String, followUpKeys: [KeyStroke] = []) {
        self.output = output
        self.followUpKeys = followUpKeys
    }

    /// `{"output": "...", "followUpKeys": [{"key": "u", "modifiers": ["ctrl"]}]}` with sorted keys.
    public var json: String {
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard let data = try? enc.encode(self), let s = String(data: data, encoding: .utf8) else {
            return "{\"followUpKeys\":[],\"output\":\"\"}"
        }
        return s
    }
}

public enum IntegrationError: Error, Equatable, Sendable, CustomStringConvertible {
    case unknownApp(String)
    case unknownCommand(app: String, command: String)
    case invalidArgument(name: String, reason: String)
    /// The app is not open. Commands never launch an app (except open-url).
    case appNotRunning(bundleId: String)
    case appNotInstalled(bundleId: String)
    /// The user has not allowed Ghostkeys to control this app (System Settings > Privacy > Automation).
    case notAuthorized(bundleId: String)
    /// The app cannot do this (for example Spotify has no scriptable "like").
    case unsupported(String)
    /// Nothing to act on: no window, no selection, no playing track, no Meet tab, ...
    case nothingToActOn(String)
    /// Refused to avoid losing data, e.g. inserting a template over a non-empty cell.
    case refused(String)
    case timedOut
    case scriptFailed(code: Int, message: String)

    public var description: String {
        switch self {
        case .unknownApp(let a): return "unknown integration app '\(a)'"
        case .unknownCommand(let a, let c): return "'\(a)' has no command '\(c)'"
        case .invalidArgument(let n, let r): return "argument '\(n)': \(r)"
        case .appNotRunning(let b): return "\(b) is not running"
        case .appNotInstalled(let b): return "\(b) is not installed"
        case .notAuthorized(let b): return "Ghostkeys is not allowed to control \(b) (System Settings > Privacy & Security > Automation)"
        case .unsupported(let s): return "unsupported: \(s)"
        case .nothingToActOn(let s): return s
        case .refused(let s): return "refused: \(s)"
        case .timedOut: return "the app did not answer in time"
        case .scriptFailed(let code, let m): return "script error \(code): \(m)"
        }
    }
}

/// A value passed into or returned from a script, converted to and from Apple Event descriptors.
public indirect enum ScriptValue: Equatable, Sendable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case list([ScriptValue])
    case missing

    public var string: String? {
        switch self {
        case .string(let s): return s
        case .int(let i): return String(i)
        case .double(let d): return String(d)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }

    public var list: [ScriptValue]? { if case .list(let l) = self { return l } else { return nil } }

    public var bool: Bool? {
        switch self {
        case .bool(let b): return b
        case .string(let s): return s == "true" ? true : (s == "false" ? false : nil)
        default: return nil
        }
    }
}

/// Runs one generated script. The script's source is static; everything variable arrives as `args`,
/// bound to the parameter of `on gk_main(args)`. Nothing the user types is ever spliced into source.
public protocol ScriptExecutor: Sendable {
    func run(source: String, args: [ScriptValue]) async -> Result<ScriptValue, IntegrationError>
}

/// Everything the runner needs from the system besides scripts, so tests can fake it.
public protocol IntegrationEnvironment: Sendable {
    func isRunning(bundleId: String) -> Bool
    func isInstalled(bundleId: String) -> Bool
    func frontmostBundleId() -> String?
    /// Brings the app to the front and waits briefly until it is frontmost. Returns false if it did not come forward.
    func activate(bundleId: String) async -> Bool
    func copyToClipboard(_ text: String)
    /// Opens URLs (web pages or folders) with the given app. Launches it if needed.
    func open(_ urls: [URL], withBundleId bundleId: String) async -> Bool
}
