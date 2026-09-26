import Foundation

typealias Ctx = IntegrationRunner.Context
typealias CommandResult = Result<IntegrationResult, IntegrationError>

private func keys(_ output: String, _ k: KeyStroke...) -> CommandResult {
    .success(IntegrationResult(output: output, followUpKeys: k))
}

private func done(_ output: String) -> (ScriptValue) -> IntegrationResult {
    { _ in IntegrationResult(output: output) }
}

// MARK: browsers

enum BrowserCommands {
    static func run(_ app: String, _ command: String, _ c: Ctx) async -> CommandResult {
        // Shared by all three browsers.
        switch command {
        case "reopen-closed-tab": return keys("Reopened tab", KeyStroke("t", ["cmd", "shift"]))
        case "open-url":
            let urlString = c.args.string("url")
            guard let url = URL(string: urlString) else { return .failure(.invalidArgument(name: "url", reason: "invalid")) }
            let ok = await c.runner.env.open([url], withBundleId: c.bundleId)
            return ok ? .success(IntegrationResult(output: urlString)) : .failure(.nothingToActOn("could not open \(urlString)"))
        case "copy-url", "copy-markdown-link":
            let source = app == "chrome" ? Scripts.Chrome.activeTabInfo
                : app == "safari" ? Scripts.Safari.activeTabInfo : Scripts.Arc.activeTabInfo
            switch await c.script(source) {
            case .failure(let e): return .failure(e)
            case .success(let v):
                let parts = v.list ?? []
                let title = parts.first?.string ?? ""
                let url = parts.dropFirst().first?.string ?? ""
                guard !url.isEmpty else { return .failure(.nothingToActOn("The active tab has no address.")) }
                let text = command == "copy-url" ? url : MarkdownLink.make(title: title, url: url)
                c.runner.env.copyToClipboard(text)
                return .success(IntegrationResult(output: text))
            }
        default: break
        }

        switch (app, command) {
        case ("chrome", "new-tab"): return await c.script(Scripts.Chrome.newTab).map(done("New tab"))
        case ("chrome", "close-tab"): return await c.script(Scripts.Chrome.closeTab).map(done("Closed tab"))
        case ("chrome", "next-tab"): return await c.script(Scripts.Chrome.stepTab, [.int(1)]).map(done("Next tab"))
        case ("chrome", "previous-tab"): return await c.script(Scripts.Chrome.stepTab, [.int(-1)]).map(done("Previous tab"))
        case ("chrome", "duplicate-tab"): return await c.script(Scripts.Chrome.duplicateTab).map(done("Duplicated tab"))
        case ("chrome", "move-tab-to-new-window"):
            return await c.script(Scripts.Chrome.moveTabToNewWindow).map(done("Moved tab to a new window"))

        case ("safari", "new-tab"): return await c.script(Scripts.Safari.newTab).map(done("New tab"))
        case ("safari", "close-tab"): return await c.script(Scripts.Safari.closeTab).map(done("Closed tab"))
        case ("safari", "next-tab"): return await c.script(Scripts.Safari.stepTab, [.int(1)]).map(done("Next tab"))
        case ("safari", "previous-tab"): return await c.script(Scripts.Safari.stepTab, [.int(-1)]).map(done("Previous tab"))
        case ("safari", "duplicate-tab"): return await c.script(Scripts.Safari.duplicateTab).map(done("Duplicated tab"))
        case ("safari", "move-tab-to-new-window"):
            return await c.script(Scripts.Safari.moveTabToNewWindow).map(done("Moved tab to a new window"))

        // Arc's scripting dictionary is thin, so most Arc commands are its own shortcuts.
        case ("arc", "new-tab"): return keys("New tab", KeyStroke("t", ["cmd"]))
        case ("arc", "close-tab"): return keys("Closed tab", KeyStroke("w", ["cmd"]))
        case ("arc", "next-tab"): return keys("Next tab", KeyStroke("down", ["cmd", "option"]))
        case ("arc", "previous-tab"): return keys("Previous tab", KeyStroke("up", ["cmd", "option"]))
        case ("arc", "pin-tab"): return keys("Toggled pin", KeyStroke("d", ["cmd"]))
        case ("arc", "duplicate-tab"): return await c.script(Scripts.Arc.duplicateTab).map(done("Duplicated tab"))
        default: return .failure(.unknownCommand(app: app, command: command))
        }
    }
}

// MARK: Music / Spotify

enum PlayerCommands {
    static func run(_ app: String, _ command: String, _ c: Ctx) async -> CommandResult {
        let id = c.bundleId
        switch command {
        case "play-pause": return await c.script(Scripts.Player.playPause(id)).map(done("Play/pause"))
        case "next": return await c.script(Scripts.Player.next(id)).map(done("Next track"))
        case "previous": return await c.script(Scripts.Player.previous(id)).map(done("Previous track"))
        case "volume-up", "volume-down":
            let step = Int(max(1, min(100, c.args.number("step"))).rounded())
            let delta = command == "volume-up" ? step : -step
            return await c.script(Scripts.Player.volume(id), [.int(delta)]).map { v in
                IntegrationResult(output: "Volume \(v.string ?? "?")")
            }
        case "now-playing":
            return await c.script(Scripts.Player.nowPlaying(id)).map { IntegrationResult(output: describeTrack($0)) }
        case "like-current" where app == "music":
            return await c.script(Scripts.Player.musicLike).map { IntegrationResult(output: "Favorited " + describeTrack($0)) }
        default:
            return .failure(.unknownCommand(app: app, command: command))
        }
    }

    /// {name, artist} -> "Name by Artist"; {} -> "".
    static func describeTrack(_ v: ScriptValue) -> String {
        let parts = v.list ?? []
        let name = parts.first?.string ?? ""
        let artist = parts.dropFirst().first?.string ?? ""
        if name.isEmpty { return "" }
        return artist.isEmpty ? name : "\(name) by \(artist)"
    }
}

// MARK: Finder

enum FinderCommands {
    static func run(_ command: String, _ c: Ctx) async -> CommandResult {
        switch command {
        case "new-folder-here":
            return await c.script(Scripts.Finder.newFolderHere).map { v in
                IntegrationResult(output: v.string ?? "",
                                  followUpKeys: c.args.bool("rename") ? [KeyStroke("return")] : [])
            }
        case "reveal-desktop":
            let r = await c.script(Scripts.Finder.revealDesktop)
            if case .success = r { _ = await c.runner.env.activate(bundleId: c.bundleId) }
            return r.map { IntegrationResult(output: $0.string ?? "Desktop") }
        case "copy-path-of-selection":
            switch await c.script(Scripts.Finder.selectionPaths) {
            case .failure(let e): return .failure(e)
            case .success(let v):
                let paths = (v.list ?? []).compactMap(\.string)
                guard !paths.isEmpty else { return .failure(.nothingToActOn("Nothing selected in Finder.")) }
                let text = paths.joined(separator: "\n")
                c.runner.env.copyToClipboard(text)
                return .success(IntegrationResult(output: text))
            }
        case "open-terminal-here":
            let terminal = c.args.string("terminal")
            guard c.runner.env.isInstalled(bundleId: terminal) else { return .failure(.appNotInstalled(bundleId: terminal)) }
            switch await c.script(Scripts.Finder.frontFolderPath) {
            case .failure(let e): return .failure(e)
            case .success(let v):
                guard let path = v.string, !path.isEmpty else { return .failure(.nothingToActOn("No Finder folder.")) }
                let ok = await c.runner.env.open([URL(fileURLWithPath: path, isDirectory: true)], withBundleId: terminal)
                return ok ? .success(IntegrationResult(output: path)) : .failure(.nothingToActOn("could not open \(terminal)"))
            }
        default:
            return .failure(.unknownCommand(app: "finder", command: command))
        }
    }
}

// MARK: PowerPoint / Keynote

enum PresentationCommands {
    static func run(_ app: String, _ command: String, _ c: Ctx) async -> CommandResult {
        let ppt = app == "powerpoint"
        switch command {
        case "start-presentation":
            return await c.script(ppt ? Scripts.PowerPoint.start : Scripts.Keynote.start).map(done("Presenting"))
        case "next-slide", "previous-slide":
            let forward = command == "next-slide"
            let source = ppt ? Scripts.PowerPoint.step : Scripts.Keynote.step
            return await c.script(source, [.int(forward ? 1 : -1)]).map { v in
                if v.string == "not-presenting" {
                    // Outside a slide show: move between slides in the editor.
                    return IntegrationResult(output: forward ? "Next slide" : "Previous slide",
                                             followUpKeys: [KeyStroke(forward ? "pagedown" : "pageup")])
                }
                return IntegrationResult(output: forward ? "Next slide" : "Previous slide")
            }
        case "black-screen":
            if ppt {
                return await c.script(Scripts.PowerPoint.blackScreen).map { v in
                    IntegrationResult(output: v.string == "black" ? "Black screen" : "Resumed")
                }
            }
            switch await c.script(Scripts.Keynote.isPlaying) {
            case .failure(let e): return .failure(e)
            case .success(let v):
                // "B" only means black screen while playing; in the editor it would type a letter.
                guard v.bool == true else { return .failure(.nothingToActOn("No slideshow is playing.")) }
                return keys("Toggled black screen", KeyStroke("b"))
            }
        case "align-left":
            return ppt ? keys("Align left", KeyStroke("l", ["cmd"])) : keys("Align left", KeyStroke("[", ["cmd", "shift"]))
        case "align-center":
            return ppt ? keys("Align center", KeyStroke("e", ["cmd"])) : keys("Align center", KeyStroke("\\", ["cmd", "shift"]))
        case "align-right":
            return ppt ? keys("Align right", KeyStroke("r", ["cmd"])) : keys("Align right", KeyStroke("]", ["cmd", "shift"]))
        default:
            return .failure(.unknownCommand(app: app, command: command))
        }
    }
}

// MARK: Zoom / Meet

struct ChromeTab: Equatable {
    var windowId: Int
    var tabIndex: Int
    var url: String
    var isActive: Bool
    var windowIndex: Int

    static func parse(_ v: ScriptValue) -> [ChromeTab] {
        (v.list ?? []).compactMap { row in
            guard let r = row.list, r.count == 5, let wid = r[0].string.flatMap({ Int($0) }),
                  let ti = r[1].string.flatMap({ Int($0) }), let url = r[2].string,
                  let widx = r[4].string.flatMap({ Int($0) }) else { return nil }
            return ChromeTab(windowId: wid, tabIndex: ti, url: url, isActive: r[3].bool ?? false, windowIndex: widx)
        }
    }
}

enum MeetTab {
    /// A Meet call URL: https://meet.google.com/abc-defg-hij (the landing page does not count).
    static func isCall(_ url: String) -> Bool {
        guard let u = URL(string: url), u.scheme == "https", u.host == "meet.google.com" else { return false }
        let code = u.path.split(separator: "/").first.map(String.init) ?? ""
        let groups = code.split(separator: "-", omittingEmptySubsequences: false).map(\.count)
        return groups == [3, 4, 3] && code.allSatisfy { $0 == "-" || ($0.isASCII && $0.isLowercase) }
    }

    /// Prefers a call tab that is already active, then the frontmost window's.
    static func pick(_ tabs: [ChromeTab]) -> ChromeTab? {
        tabs.filter { isCall($0.url) }
            .sorted { ($0.isActive ? 0 : 1, $0.windowIndex, $0.tabIndex) < ($1.isActive ? 0 : 1, $1.windowIndex, $1.tabIndex) }
            .first
    }
}

enum CallCommands {
    static func run(_ app: String, _ command: String, _ c: Ctx) async -> CommandResult {
        let mute = command == "toggle-mute"
        guard mute || command == "toggle-video" else { return .failure(.unknownCommand(app: app, command: command)) }
        if app == "zoom" {
            return mute ? keys("Toggled mute", KeyStroke("a", ["cmd", "shift"]))
                        : keys("Toggled video", KeyStroke("v", ["cmd", "shift"]))
        }
        // Meet in Chrome: find the call tab, bring it forward, then its shortcut.
        let tabs: [ChromeTab]
        switch await c.script(Scripts.Chrome.listTabs) {
        case .failure(let e): return .failure(e)
        case .success(let v): tabs = ChromeTab.parse(v)
        }
        guard let tab = MeetTab.pick(tabs) else { return .failure(.nothingToActOn("No Google Meet call is open in Chrome.")) }
        if case .failure(let e) = await c.script(Scripts.Chrome.focusTab, [.int(tab.windowId), .int(tab.tabIndex)]) {
            return .failure(e)
        }
        return mute ? keys("Toggled mute", KeyStroke("d", ["cmd"])) : keys("Toggled camera", KeyStroke("e", ["cmd"]))
    }
}

// MARK: system

enum SystemCommands {
    static func run(_ command: String, _ c: Ctx) -> CommandResult {
        switch command {
        case "frontmost-app-bundle-id":
            return .success(IntegrationResult(output: c.runner.env.frontmostBundleId() ?? ""))
        case "is-app-running":
            return .success(IntegrationResult(output: c.runner.env.isRunning(bundleId: c.args.string("bundleId")) ? "true" : "false"))
        default:
            return .failure(.unknownCommand(app: "system", command: command))
        }
    }
}
