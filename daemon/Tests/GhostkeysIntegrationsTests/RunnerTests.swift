import AppKit
import Testing
@testable import GhostkeysIntegrations

// MARK: fakes

final class FakeScripts: ScriptExecutor, @unchecked Sendable {
    struct Call { var source: String; var args: [ScriptValue] }
    private let lock = NSLock()
    private var _calls: [Call] = []
    private var replies: [Result<ScriptValue, IntegrationError>]

    init(_ replies: [Result<ScriptValue, IntegrationError>] = []) { self.replies = replies }

    var calls: [Call] { lock.withLock { _calls } }

    func run(source: String, args: [ScriptValue]) async -> Result<ScriptValue, IntegrationError> {
        lock.withLock {
            _calls.append(Call(source: source, args: args))
            return replies.isEmpty ? .success(.string("ok")) : replies.removeFirst()
        }
    }
}

final class FakeEnv: IntegrationEnvironment, @unchecked Sendable {
    var running: Set<String>
    var installed: Set<String>
    var front: String?
    var clipboard: String?
    var opened: [([URL], String)] = []
    var activated: [String] = []
    var activateSucceeds = true

    init(running: Set<String> = [], installed: Set<String>? = nil, front: String? = nil) {
        self.running = running
        self.installed = installed ?? running
        self.front = front
    }

    func isRunning(bundleId: String) -> Bool { running.contains(bundleId) }
    func isInstalled(bundleId: String) -> Bool { installed.contains(bundleId) }
    func frontmostBundleId() -> String? { front }
    func activate(bundleId: String) async -> Bool { activated.append(bundleId); return activateSucceeds }
    func copyToClipboard(_ text: String) { clipboard = text }
    func open(_ urls: [URL], withBundleId bundleId: String) async -> Bool { opened.append((urls, bundleId)); return true }
}

let allBundles: Set<String> = Set(IntegrationCatalog.apps.compactMap(\.bundleId) + ["com.apple.Terminal"])

// MARK: formats

@Suite struct NumberFormatTests {
    @Test func cycles() {
        var f = "General"
        var seen: [String] = []
        for _ in 0..<5 { f = NumberFormatCycle.next(after: f); seen.append(f) }
        #expect(seen == ["#,##0", "#,##0.0%", "0.0\"x\"", "$#,##0", "General"])
        #expect(NumberFormatCycle.next(after: "0.0x") == "$#,##0")        // Excel may drop the quotes
        #expect(NumberFormatCycle.next(after: "GENERAL") == "#,##0")
        #expect(NumberFormatCycle.next(after: "yyyy-mm-dd") == "#,##0")
    }

    @Test func decimals() {
        #expect(DecimalPlaces.adjust("General", by: 1) == "0.0")
        #expect(DecimalPlaces.adjust("General", by: -1) == "0")
        #expect(DecimalPlaces.adjust("#,##0", by: 1) == "#,##0.0")
        #expect(DecimalPlaces.adjust("#,##0.0%", by: 1) == "#,##0.00%")
        #expect(DecimalPlaces.adjust("#,##0.0%", by: -1) == "#,##0%")
        #expect(DecimalPlaces.adjust("0.0\"x\"", by: 1) == "0.00\"x\"")
        #expect(DecimalPlaces.adjust("$#,##0", by: 1) == "$#,##0.0")
        #expect(DecimalPlaces.adjust("0", by: -1) == "0")
        #expect(DecimalPlaces.adjust("0.00E+00", by: -1) == "0.0E+00")
        #expect(DecimalPlaces.adjust("#,##0.00;[Red](#,##0.00)", by: -1) == "#,##0.0;[Red](#,##0.0)")
        #expect(DecimalPlaces.adjust("\"0.0 units\" 0", by: 1) == "\"0.0 units\" 0.0")
        #expect(DecimalPlaces.adjust("_(#,##0_)", by: 1) == "_(#,##0.0_)")
        #expect(DecimalPlaces.adjust("yyyy-mm-dd", by: 1) == "yyyy-mm-dd")
        #expect(DecimalPlaces.adjust("0." + String(repeating: "0", count: 15), by: 1) == "0." + String(repeating: "0", count: 15))
    }

    @Test func increaseThenDecreaseRoundTrips() {
        for f in ["#,##0", "#,##0.0%", "0.0\"x\"", "$#,##0", "0.00E+00"] {
            #expect(DecimalPlaces.adjust(DecimalPlaces.adjust(f, by: 1), by: -1) == f, "\(f)")
        }
    }

    @Test func markdownLinks() {
        #expect(MarkdownLink.make(title: "Hello", url: "https://a.com") == "[Hello](https://a.com)")
        #expect(MarkdownLink.make(title: "[x] a\\b", url: "https://a.com/(1) x") == "[\\[x\\] a\\\\b](https://a.com/%281%29%20x)")
        #expect(MarkdownLink.make(title: "  ", url: "https://a.com") == "[https://a.com](https://a.com)")
    }

    @Test func urls() {
        #expect(URLArgument.validate("https://example.com/a?b=1")?.absoluteString == "https://example.com/a?b=1")
        #expect(URLArgument.validate("example.com/x")?.absoluteString == "https://example.com/x")
        #expect(URLArgument.validate("javascript:alert(1)") == nil)
        #expect(URLArgument.validate("file:///etc/passwd") == nil)
        #expect(URLArgument.validate("https://a b.com") == nil)
        #expect(URLArgument.validate("") == nil)
    }

    @Test func meetTabs() {
        #expect(MeetTab.isCall("https://meet.google.com/abc-defg-hij"))
        #expect(MeetTab.isCall("https://meet.google.com/abc-defg-hij?authuser=1"))
        #expect(!MeetTab.isCall("https://meet.google.com/"))
        #expect(!MeetTab.isCall("https://meet.google.com/landing"))
        #expect(!MeetTab.isCall("https://evil.com/meet.google.com/abc-defg-hij"))
        let tabs = [
            ChromeTab(windowId: 1, tabIndex: 1, url: "https://meet.google.com/aaa-bbbb-ccc", isActive: false, windowIndex: 1),
            ChromeTab(windowId: 2, tabIndex: 3, url: "https://meet.google.com/ddd-eeee-fff", isActive: true, windowIndex: 2),
            ChromeTab(windowId: 1, tabIndex: 2, url: "https://mail.google.com", isActive: true, windowIndex: 1),
        ]
        #expect(MeetTab.pick(tabs)?.windowId == 2)
        #expect(MeetTab.pick([tabs[0], tabs[2]])?.tabIndex == 1)
        #expect(MeetTab.pick([tabs[2]]) == nil)
    }
}

// MARK: catalog

@Suite struct CatalogTests {
    @Test func everyCommandIsUniqueAndDescribed() {
        let ids = IntegrationCatalog.commands.map(\.id)
        #expect(Set(ids).count == ids.count)
        for c in IntegrationCatalog.commands {
            #expect(IntegrationCatalog.app(c.app) != nil, "\(c.id)")
            #expect(!c.title.isEmpty && !c.summary.isEmpty, "\(c.id)")
            if c.mechanism == .appleScript || c.mechanism == .appleScriptAndKeys {
                #expect(c.automationBundleId != nil, "\(c.id)")
            } else {
                #expect(c.automationBundleId == nil, "\(c.id)")
            }
            #expect(IntegrationCatalog.unsupported[c.id] == nil, "\(c.id) is both listed and unsupported")
        }
    }

    @Test func coversTheRequestedCommands() {
        let want: [String: [String]] = [
            "excel": ["wrap-iferror", "unwrap-iferror", "toggle-absolute", "cycle-number-format", "color-inputs-formulas",
                      "insert-xlookup", "insert-index-match", "insert-sumifs", "paste-values", "fill-down", "fill-right",
                      "autosum", "trace-precedents", "increase-decimals", "decrease-decimals"],
            "chrome": ["new-tab", "close-tab", "reopen-closed-tab", "next-tab", "previous-tab", "duplicate-tab", "copy-url",
                       "copy-markdown-link", "move-tab-to-new-window", "open-url"],
            "safari": ["new-tab", "close-tab", "reopen-closed-tab", "next-tab", "previous-tab", "duplicate-tab", "copy-url",
                       "copy-markdown-link", "move-tab-to-new-window", "open-url"],
            "arc": ["new-tab", "close-tab", "reopen-closed-tab", "next-tab", "previous-tab", "duplicate-tab", "copy-url",
                    "copy-markdown-link", "pin-tab", "open-url"],
            "music": ["play-pause", "next", "previous", "like-current", "volume-up", "volume-down", "now-playing"],
            "spotify": ["play-pause", "next", "previous", "volume-up", "volume-down", "now-playing"],
            "finder": ["new-folder-here", "reveal-desktop", "copy-path-of-selection", "open-terminal-here"],
            "powerpoint": ["next-slide", "previous-slide", "start-presentation", "black-screen", "align-left", "align-center", "align-right"],
            "keynote": ["next-slide", "previous-slide", "start-presentation", "black-screen", "align-left", "align-center", "align-right"],
            "zoom": ["toggle-mute", "toggle-video"], "meet": ["toggle-mute", "toggle-video"],
            "system": ["frontmost-app-bundle-id", "is-app-running"],
        ]
        for (app, cmds) in want {
            #expect(Set(IntegrationCatalog.commands(for: app).map(\.command)) == Set(cmds), "\(app)")
        }
    }

    @Test func jsonIsValid() throws {
        let data = Data(IntegrationCatalog.json.utf8)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        #expect((obj?["commands"] as? [Any])?.count == IntegrationCatalog.commands.count)
    }

    /// Every catalog entry reaches an implementation (fake scripts answer "ok").
    @Test func everyCommandIsImplemented() async {
        for c in IntegrationCatalog.commands {
            let env = FakeEnv(running: allBundles)
            let runner = IntegrationRunner(scripts: FakeScripts(), environment: env)
            var args: [String: String] = [:]
            for a in c.args where a.required {
                args[a.name] = a.kind == .url ? "https://example.com" : "com.apple.Safari"
            }
            let r = await runner.execute(app: c.app, command: c.command, args: args)
            if case .failure(let e) = r {
                switch e {
                case .unknownApp, .unknownCommand, .invalidArgument: Issue.record("\(c.id): \(e)")
                default: break   // e.g. "unexpected reply" from the generic fake is fine here
                }
            }
        }
    }
}

// MARK: runner

@Suite struct RunnerTests {
    let excel = "com.microsoft.Excel"

    @Test func unknownAndUnsupported() async {
        let r = IntegrationRunner(scripts: FakeScripts(), environment: FakeEnv(running: allBundles))
        #expect(await r.execute(app: "word", command: "x").failure == .unknownApp("word"))
        #expect(await r.execute(app: "excel", command: "nope").failure == .unknownCommand(app: "excel", command: "nope"))
        if case .unsupported? = await r.execute(app: "spotify", command: "like-current").failure {} else {
            Issue.record("spotify like-current should be unsupported")
        }
    }

    @Test func neverLaunchesAClosedApp() async {
        let scripts = FakeScripts()
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: []))
        #expect(await r.execute(app: "excel", command: "toggle-absolute").failure == .appNotRunning(bundleId: excel))
        #expect(scripts.calls.isEmpty)
    }

    @Test func toggleAbsoluteReadsTransformsAndWritesChangedCells() async {
        let read: ScriptValue = .list([.string("Model"), .list([
            .list([.string("$B$2"), .string("=A1*$C$1")]),
            .list([.string("$B$3"), .string("=NOW()")]),
            .list([.string("$B$4"), .string("=\"$A$1\"&D4")]),
        ])])
        let scripts = FakeScripts([.success(read), .success(.int(2))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: [excel]))
        let out = await r.execute(app: "excel", command: "toggle-absolute")
        #expect(out.success?.output == "Updated 2 cells")
        #expect(scripts.calls.count == 2)
        #expect(scripts.calls[1].source == Scripts.Excel.writeFormulas)
        #expect(scripts.calls[1].args == [.string("Model"), .list([
            .list([.string("$B$2"), .string("=$A$1*$C$1")]),
            .list([.string("$B$4"), .string("=\"$A$1\"&$D$4")]),
        ])])
    }

    @Test func wrapIfErrorPassesFallbackAsDataOnly() async {
        let hostile = "0\" & do shell script \"rm -rf ~\" & \""
        let read: ScriptValue = .list([.string("S"), .list([.list([.string("$A$1"), .string("=B1/C1")])])])
        let scripts = FakeScripts([.success(read), .success(.int(1))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: [excel]))
        _ = await r.execute(app: "excel", command: "wrap-iferror", args: ["fallback": hostile])
        // Script sources are the fixed templates; the hostile text only appears inside an Excel string literal arg.
        #expect(scripts.calls.map(\.source) == [Scripts.Excel.readFormulas, Scripts.Excel.writeFormulas])
        let written = scripts.calls[1].args[1].list?[0].list?[1].string ?? ""
        #expect(written == "=IFERROR(B1/C1,\"0\"\" & do shell script \"\"rm -rf ~\"\" & \"\"\")")
    }

    @Test func emptySelectionIsReported() async {
        let scripts = FakeScripts([.success(.list([.string("S"), .list([])]))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: [excel]))
        if case .nothingToActOn? = await r.execute(app: "excel", command: "unwrap-iferror").failure {} else {
            Issue.record("expected nothingToActOn")
        }
    }

    @Test func insertTemplateReturnsCursorKeysAndActivatesExcel() async {
        let env = FakeEnv(running: [excel])
        let scripts = FakeScripts()
        let r = IntegrationRunner(scripts: scripts, environment: env)
        let out = await r.execute(app: "excel", command: "insert-xlookup")
        #expect(out.success?.followUpKeys == FormulaTemplate.xlookup.followUpKeys)
        #expect(scripts.calls.first?.args == [.string("=XLOOKUP(,,)"), .bool(false)])
        #expect(env.activated == [excel])
        let json = await r.run(app: "excel", command: "insert-xlookup", args: ["overwrite": "true"])
        #expect(json.success?.contains("\"followUpKeys\":[{\"key\":\"u\",\"modifiers\":[\"ctrl\"]}") == true)
    }

    @Test func keysFailIfAppCannotBeActivated() async {
        let env = FakeEnv(running: ["us.zoom.xos"])
        env.activateSucceeds = false
        let r = IntegrationRunner(scripts: FakeScripts(), environment: env)
        if case .nothingToActOn? = await r.execute(app: "zoom", command: "toggle-mute").failure {} else {
            Issue.record("expected failure when Zoom cannot come forward")
        }
    }

    @Test func numberFormatCycleUsesActiveCell() async {
        let scripts = FakeScripts([.success(.string("#,##0")), .success(.string("ok"))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: [excel]))
        #expect(await r.execute(app: "excel", command: "cycle-number-format").success?.output == "#,##0.0%")
        #expect(scripts.calls[1].args == [.string("#,##0.0%")])
    }

    @Test func tracePrecedentsFallsBackToKeys() async {
        let scripts = FakeScripts([.failure(.scriptFailed(code: -50, message: "nope"))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: [excel]))
        #expect(await r.execute(app: "excel", command: "trace-precedents").success?.followUpKeys == [KeyStroke("[", ["ctrl"])])
    }

    @Test func notAuthorizedNamesTheApp() async {
        let scripts = FakeScripts([.failure(.notAuthorized(bundleId: ""))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: ["com.apple.Music"]))
        #expect(await r.execute(app: "music", command: "play-pause").failure == .notAuthorized(bundleId: "com.apple.Music"))
    }

    @Test func copyMarkdownLinkWritesClipboard() async {
        let env = FakeEnv(running: ["com.google.Chrome"])
        let scripts = FakeScripts([.success(.list([.string("Docs [beta]"), .string("https://x.dev/a b")]))])
        let r = IntegrationRunner(scripts: scripts, environment: env)
        _ = await r.execute(app: "chrome", command: "copy-markdown-link")
        #expect(env.clipboard == "[Docs \\[beta\\]](https://x.dev/a%20b)")
    }

    @Test func openURLValidatesAndDoesNotScript() async {
        let env = FakeEnv(running: [], installed: ["com.apple.Safari"])
        let scripts = FakeScripts()
        let r = IntegrationRunner(scripts: scripts, environment: env)
        if case .invalidArgument? = await r.execute(app: "safari", command: "open-url", args: ["url": "javascript:alert(1)"]).failure {} else {
            Issue.record("javascript: must be rejected")
        }
        #expect(await r.execute(app: "safari", command: "open-url", args: ["url": "example.com"]).success?.output == "https://example.com")
        #expect(env.opened.first?.0 == [URL(string: "https://example.com")!])
        #expect(scripts.calls.isEmpty)
    }

    @Test func volumeStepIsClampedAndSigned() async {
        let scripts = FakeScripts([.success(.int(35))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: ["com.spotify.client"]))
        #expect(await r.execute(app: "spotify", command: "volume-down", args: ["step": "500"]).success?.output == "Volume 35")
        #expect(scripts.calls[0].args == [.int(-100)])
        #expect(scripts.calls[0].source == Scripts.Player.volume("com.spotify.client"))
    }

    @Test func nowPlayingFormatting() {
        #expect(PlayerCommands.describeTrack(.list([.string("Song"), .string("Band")])) == "Song by Band")
        #expect(PlayerCommands.describeTrack(.list([])) == "")
        #expect(PlayerCommands.describeTrack(.list([.string("Song"), .string("")])) == "Song")
    }

    @Test func meetFindsCallTabThenSendsShortcut() async {
        let tabs: ScriptValue = .list([
            .list([.int(7), .int(1), .string("https://news.site"), .bool(true), .int(1)]),
            .list([.int(9), .int(4), .string("https://meet.google.com/abc-defg-hij"), .bool(false), .int(2)]),
        ])
        let env = FakeEnv(running: ["com.google.Chrome"])
        let scripts = FakeScripts([.success(tabs), .success(.string("ok"))])
        let r = IntegrationRunner(scripts: scripts, environment: env)
        let out = await r.execute(app: "meet", command: "toggle-video")
        #expect(out.success?.followUpKeys == [KeyStroke("e", ["cmd"])])
        #expect(scripts.calls[1].args == [.int(9), .int(4)])
        #expect(env.activated == ["com.google.Chrome"])
    }

    @Test func presentationFallsBackToPageKeysOutsideShow() async {
        let scripts = FakeScripts([.success(.string("not-presenting"))])
        let r = IntegrationRunner(scripts: scripts, environment: FakeEnv(running: ["com.microsoft.Powerpoint"]))
        #expect(await r.execute(app: "powerpoint", command: "next-slide").success?.followUpKeys == [KeyStroke("pagedown")])
    }

    @Test func keynoteBlackScreenOnlyWhilePlaying() async {
        let r = IntegrationRunner(scripts: FakeScripts([.success(.bool(false))]),
                                  environment: FakeEnv(running: ["com.apple.Keynote"]))
        if case .nothingToActOn? = await r.execute(app: "keynote", command: "black-screen").failure {} else {
            Issue.record("B must not be typed into the editor")
        }
    }

    @Test func systemHelpers() async {
        let r = IntegrationRunner(scripts: FakeScripts(), environment: FakeEnv(running: ["com.apple.Music"], front: "com.apple.finder"))
        #expect(await r.execute(app: "system", command: "frontmost-app-bundle-id").success?.output == "com.apple.finder")
        #expect(await r.execute(app: "system", command: "is-app-running", args: ["bundleId": "com.apple.Music"]).success?.output == "true")
        #expect(await r.execute(app: "system", command: "is-app-running", args: ["bundleId": "x; rm"]).failure
                == .invalidArgument(name: "bundleId", reason: "not a bundle id"))
        #expect(await r.execute(app: "system", command: "is-app-running").failure == .invalidArgument(name: "bundleId", reason: "required"))
    }

    @Test func argsHelperConvertsJSONTypes() {
        let s = IntegrationArgs.strings(from: ["a": true, "b": 5, "c": "x", "d": 1.5])
        #expect(s == ["a": "true", "b": "5", "c": "x", "d": "1.5"])
    }
}

// MARK: AppleScript plumbing (no app is contacted)

@Suite struct ScriptPlumbingTests {
    @Test func descriptorRoundTrip() {
        let v: ScriptValue = .list([.string("a\"b\\c"), .int(3), .bool(true), .list([.double(1.5), .string("")])])
        #expect(AppleScriptExecutor.value(AppleScriptExecutor.descriptor(v)) == v)
    }

    @Test func errorMapping() {
        func m(_ n: Int) -> IntegrationError {
            AppleScriptExecutor.map([NSAppleScript.errorNumber: n, NSAppleScript.errorMessage: "msg"])
        }
        #expect(m(-1743) == .notAuthorized(bundleId: ""))
        #expect(m(-1712) == .timedOut)
        #expect(m(9001) == .nothingToActOn("msg"))
        #expect(m(9002) == .refused("msg"))
        #expect(m(9003) == .unsupported("msg"))
        #expect(m(-2753) == .scriptFailed(code: -2753, message: "msg"))
    }

    /// Runs a script that talks to no app: proves the handler call and argument passing work end to end.
    @Test func handlerReceivesArgumentsAsData() async {
        let source = """
        on gk_main(args)
        	return {(item 1 of args) & "!", (item 2 of args) + 1, count of args}
        end gk_main
        """
        let r = await AppleScriptExecutor().run(source: source, args: [.string("\" & (do shell script \"id\") & \""), .int(41)])
        #expect(r.success == .list([.string("\" & (do shell script \"id\") & \"!"), .int(42), .int(2)]))
    }

    @Test func scriptErrorsMap() async {
        let r = await AppleScriptExecutor().run(source: "on gk_main(args)\nerror \"No window\" number 9001\nend gk_main", args: [])
        #expect(r.failure == .nothingToActOn("No window"))
    }

    /// Opt in with GHOSTKEYS_COMPILE_SCRIPTS=1. Compiles every script against the dictionaries of apps
    /// that are installed and not running. Compiling reads the app's .sdef from its bundle; nothing is run.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["GHOSTKEYS_COMPILE_SCRIPTS"] == "1"))
    func allScriptsCompile() {
        let exec = AppleScriptExecutor()
        for (name, source) in Scripts.all {
            guard let r = source.range(of: "application id \"[^\"]+\"", options: .regularExpression) else { continue }
            let id = source[r].dropFirst("application id \"".count).dropLast()
            guard NSWorkspace.shared.urlForApplication(withBundleIdentifier: String(id)) != nil else {
                print("skip \(name): \(id) not installed"); continue
            }
            // A running app might be asked for its dictionary over Apple Events; stay hands-off.
            guard NSRunningApplication.runningApplications(withBundleIdentifier: String(id)).isEmpty else {
                print("skip \(name): \(id) is running"); continue
            }
            if case .failure(let e) = exec.compile(source: source) { Issue.record("\(name): \(e)") }
        }
    }
}

extension Result {
    var success: Success? { if case .success(let s) = self { return s } else { return nil } }
    var failure: Failure? { if case .failure(let f) = self { return f } else { return nil } }
}
