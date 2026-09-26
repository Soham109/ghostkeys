import Foundation
import AppKit
import CoreGraphics

/// Runs binding actions (PROTOCOL.md "Action kinds") on a background serial queue.
/// Callers must only invoke `run` for a detected gesture or an explicit test_action, and never while paused;
/// the runner re-checks `isPaused` before every step as a second line of defence.
final class ActionRunner: @unchecked Sendable {
    let dryRun: Bool
    /// Returns the daemon's paused flag. Read from the action queue.
    var isPaused: () -> Bool = { false }
    private let queue = DispatchQueue(label: "ghostkeys.actions", qos: .userInitiated)

    static let maxMacroSteps = 50
    static let maxMacroSeconds = 30.0
    static let shellTimeout = 10.0

    init(dryRun: Bool) { self.dryRun = dryRun }

    func run(_ action: JSONValue, completion: @escaping @Sendable (_ ok: Bool, _ error: String?) -> Void) {
        queue.async { [self] in
            do {
                try perform(action, inMacro: false)
                completion(true, nil)
            } catch {
                completion(false, "\(error)")
            }
        }
    }

    // MARK: Dispatch

    private func perform(_ action: JSONValue, inMacro: Bool) throws {
        guard !isPaused() else { throw ActionError("paused") }
        guard let kind = action["kind"]?.string else { throw ActionError("action has no kind") }

        if kind == "macro" {
            guard !inMacro else { throw ActionError("a macro cannot contain another macro") }
            try macro(action)
            return
        }
        try validate(kind, action)
        if dryRun {
            Log.info("dry-run: would run \(Self.describe(action))")
            return
        }
        Log.debug("running \(Self.describe(action))")
        try execute(kind, action)
    }

    /// Checks fields before anything runs, so dry-run reports the same errors a real run would.
    private func validate(_ kind: String, _ a: JSONValue) throws {
        switch kind {
        case "keystroke":
            guard let key = a["key"]?.string, KeyCodes.code(for: key) != nil else { throw ActionError("unknown key: \(a["key"]?.string ?? "none")") }
        case "volume", "brightness":
            guard let step = a["step"]?.double, step.isFinite else { throw ActionError("\(kind) needs a numeric step") }
        case "mute": break
        case "media":
            guard ["playpause", "next", "previous"].contains(a["command"]?.string ?? "") else { throw ActionError("unknown media command") }
        case "open":
            guard let t = a["target"]?.string, !t.isEmpty else { throw ActionError("open needs a target") }
        case "shell":
            guard let c = a["command"]?.string, !c.isEmpty else { throw ActionError("shell needs a command") }
            if Self.mentionsSudo(c) { throw ActionError("refusing to run a command that uses sudo") }
        case "applescript":
            guard let s = a["source"]?.string, !s.isEmpty else { throw ActionError("applescript needs a source") }
            if Self.mentionsSudo(s) || s.range(of: "administrator privileges", options: .caseInsensitive) != nil {
                throw ActionError("refusing an AppleScript that asks for admin rights")
            }
        case "shortcut":
            guard let n = a["name"]?.string, !n.isEmpty else { throw ActionError("shortcut needs a name") }
        case "text", "clipboard":
            guard let t = a["text"]?.string else { throw ActionError("\(kind) needs text") }
            if t.count > 5000 { throw ActionError("text is too long (max 5000 characters)") }
        case "window":
            guard WindowActions.windowOps.contains(a["op"]?.string ?? "") else { throw ActionError("unknown window op") }
        case "app":
            guard WindowActions.appOps.contains(a["op"]?.string ?? "") else { throw ActionError("unknown app op") }
        case "system":
            guard Self.systemOps.contains(a["op"]?.string ?? "") else { throw ActionError("unknown system op") }
        default:
            throw ActionError("unknown action kind: \(kind)")
        }
    }

    private func execute(_ kind: String, _ a: JSONValue) throws {
        switch kind {
        case "keystroke":
            try EventPoster.keystroke(KeyCodes.code(for: a["key"]!.string!)!, flags: KeyCodes.flags(a["modifiers"]?.stringArray ?? []))
        case "volume":
            try volume(step: a["step"]!.double!)
        case "mute":
            try osa("set volume output muted not (output muted of (get volume settings))")
        case "media":
            let key: EventPoster.AuxKey = ["next": .next, "previous": .previous][a["command"]!.string!] ?? .play
            try EventPoster.auxKey(key)
        case "brightness":
            let step = a["step"]!.double!
            // One brightness key press is 1/16 of the range (6.25%).
            let presses = max(1, min(16, Int((abs(step) / 6.25).rounded())))
            for _ in 0..<presses { try EventPoster.auxKey(step >= 0 ? .brightnessUp : .brightnessDown) }
        case "open":
            try open(a["target"]!.string!)
        case "shell":
            let r = ProcessRunner.run("/bin/zsh", ["-lc", a["command"]!.string!], timeout: Self.shellTimeout)
            if r.timedOut { throw ActionError("shell command timed out after \(Int(Self.shellTimeout)) s") }
            if r.status != 0 { throw ActionError("shell exited \(r.status): \(r.stderr.prefix(300))") }
        case "applescript":
            try onMain {
                var err: NSDictionary?
                guard let script = NSAppleScript(source: a["source"]!.string!) else { throw ActionError("invalid AppleScript") }
                script.executeAndReturnError(&err)
                if let err { throw ActionError("AppleScript error: \(err[NSAppleScript.errorMessage] ?? err)") }
            }
        case "shortcut":
            let r = ProcessRunner.run("/usr/bin/shortcuts", ["run", a["name"]!.string!], timeout: 30)
            if r.timedOut { throw ActionError("shortcut timed out") }
            if r.status != 0 { throw ActionError("shortcut failed: \(r.stderr.prefix(300))") }
        case "text":
            try EventPoster.type(a["text"]!.string!)
        case "clipboard":
            let text = a["text"]!.string!
            try onMain {
                let pb = NSPasteboard.general
                pb.clearContents()
                guard pb.setString(text, forType: .string) else { throw ActionError("could not write the clipboard") }
            }
        case "window":
            try onMain { try WindowActions.window(a["op"]!.string!) }
        case "app":
            try onMain { try WindowActions.app(a["op"]!.string!) }
        case "system":
            try system(a["op"]!.string!)
        default:
            throw ActionError("unknown action kind: \(kind)")
        }
    }

    // MARK: Macro

    private func macro(_ a: JSONValue) throws {
        guard let steps = a["steps"]?.array, !steps.isEmpty else { throw ActionError("macro has no steps") }
        guard steps.count <= Self.maxMacroSteps else { throw ActionError("macro has more than \(Self.maxMacroSteps) steps") }
        // Validate everything up front so a bad step 7 does not leave steps 1-6 half applied.
        for (i, step) in steps.enumerated() {
            guard let kind = step["kind"]?.string else { throw ActionError("macro step \(i + 1) has no kind") }
            if kind == "macro" { throw ActionError("a macro cannot contain another macro") }
            do { try validate(kind, step) } catch { throw ActionError("macro step \(i + 1): \(error)") }
        }
        let deadline = Date().addingTimeInterval(Self.maxMacroSeconds)
        for (i, step) in steps.enumerated() {
            let delay = max(0, (step["delayMs"]?.double ?? 0) / 1000)
            if delay > 0 {
                guard Date().addingTimeInterval(delay) < deadline else { throw ActionError("macro exceeded \(Int(Self.maxMacroSeconds)) s") }
                Thread.sleep(forTimeInterval: delay)
            }
            guard Date() < deadline else { throw ActionError("macro exceeded \(Int(Self.maxMacroSeconds)) s") }
            do { try perform(step, inMacro: true) } catch { throw ActionError("macro step \(i + 1): \(error)") }
        }
    }

    // MARK: Kinds

    private func osa(_ source: String) throws {
        let r = ProcessRunner.osascript(source)
        if r.status != 0 { throw ActionError("osascript failed: \(r.stderr.prefix(300))") }
    }

    /// Output volume 0-100, read without changing anything.
    static func readVolume() -> Int? {
        let r = ProcessRunner.osascript("output volume of (get volume settings)")
        return r.status == 0 ? Int(r.stdout) : nil
    }

    private func volume(step: Double) throws {
        guard let current = Self.readVolume() else { throw ActionError("could not read the output volume (digital output?)") }
        let next = max(0, min(100, current + Int(step.rounded())))
        try osa("set volume output volume \(next)")
    }

    private func open(_ target: String) throws {
        var args: [String]
        if target.contains("://") || target.hasPrefix("/") || target.hasPrefix("~") {
            args = [(target as NSString).expandingTildeInPath]
        } else {
            args = ["-a", target]   // an app name
        }
        let r = ProcessRunner.run("/usr/bin/open", args, timeout: 10)
        if r.status != 0 { throw ActionError("open failed: \(r.stderr.prefix(300))") }
    }

    static let systemOps: Set<String> = ["lock", "sleep-display", "screenshot", "screenshot-area", "dnd-toggle",
                                         "mission-control", "launchpad", "show-desktop"]

    private func system(_ op: String) throws {
        switch op {
        case "lock":
            if !Self.lockViaLoginFramework() {
                try EventPoster.keystroke(12, flags: [.maskControl, .maskCommand])   // ctrl+cmd+q
            }
        case "sleep-display":
            let r = ProcessRunner.run("/usr/bin/pmset", ["displaysleepnow"], timeout: 5)
            if r.status != 0 { throw ActionError("pmset failed: \(r.stderr.prefix(200))") }
        case "screenshot", "screenshot-area":
            let file = Self.screenshotPath()
            let args = op == "screenshot" ? [file] : ["-i", file]
            let r = ProcessRunner.run("/usr/sbin/screencapture", args, timeout: op == "screenshot" ? 10 : 120)
            if r.status != 0 { throw ActionError("screencapture failed: \(r.stderr.prefix(200))") }
        case "dnd-toggle":
            let list = ProcessRunner.run("/usr/bin/shortcuts", ["list"], timeout: 10)
            let names = list.stdout.split(separator: "\n").map(String.init)
            let wanted = ["toggle do not disturb", "toggle dnd", "ghostkeys toggle dnd", "toggle focus"]
            guard let name = names.first(where: { wanted.contains($0.lowercased()) }) else {
                throw ActionError("unsupported: create a Shortcut named \"Toggle Do Not Disturb\" to enable this")
            }
            let r = ProcessRunner.run("/usr/bin/shortcuts", ["run", name], timeout: 30)
            if r.status != 0 { throw ActionError("shortcut failed: \(r.stderr.prefix(200))") }
        case "mission-control":
            try open("/System/Applications/Mission Control.app")
        case "launchpad":
            let fm = FileManager.default
            let candidates = ["/System/Applications/Launchpad.app", "/System/Applications/Apps.app"]
            if let path = candidates.first(where: { fm.fileExists(atPath: $0) }) {
                try open(path)
            } else {
                try EventPoster.keystroke(131, flags: [])   // kVK launchpad key
            }
        case "show-desktop":
            try EventPoster.keystroke(103, flags: [])       // F11, the default Show Desktop shortcut
        default:
            throw ActionError("unknown system op: \(op)")
        }
    }

    /// SACLockScreenImmediate from the private login framework (what the Lock Screen menu item uses).
    private static func lockViaLoginFramework() -> Bool {
        guard let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
              let sym = dlsym(h, "SACLockScreenImmediate") else { return false }
        typealias Fn = @convention(c) () -> Int32
        _ = unsafeBitCast(sym, to: Fn.self)()
        return true
    }

    private static func screenshotPath() -> String {
        var dir = (NSHomeDirectory() as NSString).appendingPathComponent("Desktop")
        let r = ProcessRunner.run("/usr/bin/defaults", ["read", "com.apple.screencapture", "location"], timeout: 3)
        if r.status == 0, !r.stdout.isEmpty {
            let custom = (r.stdout as NSString).expandingTildeInPath
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: custom, isDirectory: &isDir), isDir.boolValue { dir = custom }
        }
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return (dir as NSString).appendingPathComponent("Screenshot \(f.string(from: Date())).png")
    }

    private func onMain(_ body: () throws -> Void) throws {
        var thrown: Error?
        DispatchQueue.main.sync {
            do { try body() } catch { thrown = error }
        }
        if let thrown { throw thrown }
    }

    static func mentionsSudo(_ s: String) -> Bool {
        s.range(of: #"(^|[^A-Za-z0-9_])sudo([^A-Za-z0-9_]|$)"#, options: .regularExpression) != nil
    }

    static func describe(_ a: JSONValue) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: a.any, options: [.sortedKeys]) else { return "action" }
        return String(decoding: data, as: UTF8.self)
    }
}
