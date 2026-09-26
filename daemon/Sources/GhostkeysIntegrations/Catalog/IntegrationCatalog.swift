import Foundation

public struct IntegrationArgSpec: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case string, number, bool, url, bundleId }

    public var name: String
    public var kind: Kind
    public var required: Bool
    public var defaultValue: String?
    public var help: String

    public init(_ name: String, _ kind: Kind, required: Bool = false, default defaultValue: String? = nil, help: String) {
        self.name = name; self.kind = kind; self.required = required; self.defaultValue = defaultValue; self.help = help
    }
}

public struct IntegrationApp: Codable, Equatable, Sendable {
    /// The `app` value used in bindings, e.g. "excel".
    public var key: String
    public var name: String
    /// The app commands act on (Meet lives in Chrome). Nil for `system`.
    public var bundleId: String?
}

public struct IntegrationCommandSpec: Codable, Equatable, Sendable {
    /// How the command does its work, which decides the permissions it needs.
    public enum Mechanism: String, Codable, Sendable {
        case appleScript          // Apple Events only: needs Automation permission for the app
        case keystrokes           // followUpKeys only: needs Accessibility (the daemon posts the keys)
        case appleScriptAndKeys   // both
        case native               // NSWorkspace / NSPasteboard, no special permission
    }

    public var app: String
    public var command: String
    public var title: String
    public var summary: String
    public var args: [IntegrationArgSpec]
    /// True when the command can lose work (the UI should confirm before binding it).
    public var destructive: Bool
    /// False when the change skips the app's own undo. Excel edits made over Apple Events do not enter
    /// Excel's undo history.
    public var undoable: Bool
    /// Bundle id that needs Automation permission, nil when the command sends no Apple Events.
    public var automationBundleId: String?
    public var mechanism: Mechanism
    public var notes: String?

    public var needsAccessibility: Bool { mechanism == .keystrokes || mechanism == .appleScriptAndKeys }
    public var id: String { "\(app)/\(command)" }
}

public enum IntegrationCatalog {

    public static let apps: [IntegrationApp] = [
        IntegrationApp(key: "excel", name: "Microsoft Excel", bundleId: "com.microsoft.Excel"),
        IntegrationApp(key: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome"),
        IntegrationApp(key: "arc", name: "Arc", bundleId: "company.thebrowser.Browser"),
        IntegrationApp(key: "safari", name: "Safari", bundleId: "com.apple.Safari"),
        IntegrationApp(key: "music", name: "Music", bundleId: "com.apple.Music"),
        IntegrationApp(key: "spotify", name: "Spotify", bundleId: "com.spotify.client"),
        IntegrationApp(key: "finder", name: "Finder", bundleId: "com.apple.finder"),
        IntegrationApp(key: "powerpoint", name: "Microsoft PowerPoint", bundleId: "com.microsoft.Powerpoint"),
        IntegrationApp(key: "keynote", name: "Keynote", bundleId: "com.apple.Keynote"),
        IntegrationApp(key: "zoom", name: "Zoom", bundleId: "us.zoom.xos"),
        IntegrationApp(key: "meet", name: "Google Meet (in Chrome)", bundleId: "com.google.Chrome"),
        IntegrationApp(key: "system", name: "System", bundleId: nil),
    ]

    /// Commands that exist for some apps but cannot work for these ones. The runner answers `.unsupported`.
    public static let unsupported: [String: String] = [
        "spotify/like-current": "Spotify's scripting dictionary has no way to like or save a track",
        "chrome/pin-tab": "Chrome has neither a scripting command nor a default shortcut for pinning a tab",
        "safari/pin-tab": "Safari has neither a scripting command nor a default shortcut for pinning a tab",
        "arc/move-tab-to-new-window": "Arc has no scripting command or default shortcut for moving a tab to a new window",
        "finder/toggle-hidden-files": "left out on purpose: it rewrites Finder's preferences and restarts Finder",
    ]

    public static func app(_ key: String) -> IntegrationApp? { apps.first { $0.key == key } }

    public static func command(app: String, command: String) -> IntegrationCommandSpec? {
        commands.first { $0.app == app && $0.command == command }
    }

    public static func commands(for app: String) -> [IntegrationCommandSpec] { commands.filter { $0.app == app } }

    /// The whole catalog as JSON: {"apps": [...], "commands": [...], "unsupported": {...}}.
    public static var json: String {
        struct Doc: Encodable {
            let apps: [IntegrationApp]
            let commands: [IntegrationCommandSpec]
            let unsupported: [String: String]
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        let data = (try? enc.encode(Doc(apps: apps, commands: commands, unsupported: unsupported))) ?? Data()
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    // MARK: the list

    private static let excelNoUndo = "Excel does not record edits made over Apple Events in its undo history."

    public static let commands: [IntegrationCommandSpec] = excel + browsers + players + finder + presenters + calls + system

    private static func spec(_ app: String, _ command: String, _ title: String, _ summary: String,
                             args: [IntegrationArgSpec] = [], destructive: Bool = false, undoable: Bool = true,
                             mechanism: IntegrationCommandSpec.Mechanism, notes: String? = nil) -> IntegrationCommandSpec {
        let bundle = IntegrationCatalog.app(app)?.bundleId
        let needsAE = mechanism == .appleScript || mechanism == .appleScriptAndKeys
        return IntegrationCommandSpec(app: app, command: command, title: title, summary: summary, args: args,
                                      destructive: destructive, undoable: undoable,
                                      automationBundleId: needsAE ? bundle : nil, mechanism: mechanism, notes: notes)
    }

    private static let overwriteArg = IntegrationArgSpec("overwrite", .bool, default: "false",
                                                         help: "Replace the active cell even when it is not empty")

    private static let excel: [IntegrationCommandSpec] = [
        spec("excel", "wrap-iferror", "Wrap in IFERROR",
             "Wraps each formula in the selection in IFERROR(formula, fallback). Already wrapped formulas are left alone.",
             args: [IntegrationArgSpec("fallback", .string, default: "0",
                                       help: "Value shown on error: a number, TRUE/FALSE, 'blank' for \"\", or text")],
             undoable: false, mechanism: .appleScript, notes: excelNoUndo + " Reverse with unwrap-iferror."),
        spec("excel", "unwrap-iferror", "Remove IFERROR",
             "Removes an IFERROR wrapper that spans the whole formula, in each selected cell.",
             undoable: false, mechanism: .appleScript, notes: excelNoUndo),
        spec("excel", "toggle-absolute", "Cycle $ anchors",
             "Cycles every reference in the selected formulas through $A$1, A$1, $A1, A1, like F4.",
             undoable: false, mechanism: .appleScript, notes: excelNoUndo + " Press three more times to get back."),
        spec("excel", "cycle-number-format", "Cycle number format",
             "Steps the selection through General, #,##0, #,##0.0%, 0.0x, $#,##0.",
             undoable: false, mechanism: .appleScript, notes: excelNoUndo),
        spec("excel", "increase-decimals", "Increase decimals",
             "Adds one decimal place to the selection's number format (based on the active cell).",
             undoable: false, mechanism: .appleScript, notes: excelNoUndo),
        spec("excel", "decrease-decimals", "Decrease decimals",
             "Removes one decimal place from the selection's number format (based on the active cell).",
             undoable: false, mechanism: .appleScript, notes: excelNoUndo),
        spec("excel", "color-inputs-formulas", "Color inputs and formulas",
             "Blue font for hard-coded numbers, black for formulas, in the selection.",
             args: [IntegrationArgSpec("includeText", .bool, default: "false", help: "Also turn text constants blue")],
             undoable: false, mechanism: .appleScript, notes: excelNoUndo + " At most 5,000 cells."),
        spec("excel", "insert-xlookup", "Insert XLOOKUP",
             "Puts =XLOOKUP(,,) in the active cell and leaves the cursor on the first argument.",
             args: [overwriteArg], mechanism: .appleScriptAndKeys,
             notes: "Refuses a non-empty cell unless overwrite is true. Edit mode is entered with Control-U."),
        spec("excel", "insert-index-match", "Insert INDEX/MATCH",
             "Puts =INDEX(,MATCH(,,0)) in the active cell and leaves the cursor on the first argument.",
             args: [overwriteArg], mechanism: .appleScriptAndKeys,
             notes: "Refuses a non-empty cell unless overwrite is true."),
        spec("excel", "insert-sumifs", "Insert SUMIFS",
             "Puts =SUMIFS(,,) in the active cell and leaves the cursor on the first argument.",
             args: [overwriteArg], mechanism: .appleScriptAndKeys,
             notes: "Refuses a non-empty cell unless overwrite is true."),
        spec("excel", "paste-values", "Paste values",
             "Pastes the clipboard into the selection as values only.",
             destructive: true, undoable: false, mechanism: .appleScript,
             notes: "Overwrites the selection and cannot be undone in Excel."),
        spec("excel", "fill-down", "Fill down", "Copies the top row of the selection down (Command-D).",
             mechanism: .keystrokes),
        spec("excel", "fill-right", "Fill right", "Copies the left column of the selection right (Command-R).",
             mechanism: .keystrokes),
        spec("excel", "autosum", "AutoSum", "Inserts a SUM of the adjacent range (Command-Shift-T).",
             mechanism: .keystrokes),
        spec("excel", "trace-precedents", "Trace precedents",
             "Draws arrows to the active cell's direct precedents.", mechanism: .appleScriptAndKeys,
             notes: "If Excel refuses the script, falls back to Control-[ which selects the direct precedents."),
    ]

    private static let tabArgsURL = [IntegrationArgSpec("url", .url, required: true, help: "http or https address")]

    private static let browsers: [IntegrationCommandSpec] = {
        var out: [IntegrationCommandSpec] = []
        for app in ["chrome", "arc", "safari"] {
            let scripted: IntegrationCommandSpec.Mechanism = app == "arc" ? .keystrokes : .appleScript
            out += [
                spec(app, "new-tab", "New tab", "Opens a new tab in the front window.", mechanism: scripted),
                spec(app, "close-tab", "Close tab", "Closes the active tab.", mechanism: scripted,
                     notes: "Not marked destructive: reopen-closed-tab brings it back."),
                spec(app, "reopen-closed-tab", "Reopen closed tab", "Reopens the last closed tab (Command-Shift-T).",
                     mechanism: .keystrokes),
                spec(app, "next-tab", "Next tab", "Switches to the next tab, wrapping around.", mechanism: scripted),
                spec(app, "previous-tab", "Previous tab", "Switches to the previous tab, wrapping around.", mechanism: scripted),
                spec(app, "duplicate-tab", "Duplicate tab", "Opens the active tab's page again in a new tab.",
                     mechanism: .appleScript),
                spec(app, "copy-url", "Copy URL", "Copies the active tab's address.", mechanism: .appleScript),
                spec(app, "copy-markdown-link", "Copy Markdown link", "Copies [title](url) for the active tab.",
                     mechanism: .appleScript),
                spec(app, "open-url", "Open URL", "Opens an address in this browser.", args: tabArgsURL,
                     mechanism: .native, notes: "The only command that launches the app when it is closed."),
            ]
            if app != "arc" {
                out.append(spec(app, "move-tab-to-new-window", "Move tab to new window",
                                "Closes the active tab and opens its address in a new window.", mechanism: .appleScript,
                                notes: "The page reloads, so its back history and unsaved form input are lost."))
            }
            if app == "arc" {
                out.append(spec(app, "pin-tab", "Pin tab", "Pins or unpins the active tab (Command-D).", mechanism: .keystrokes))
            }
        }
        return out
    }()

    private static let volumeStep = IntegrationArgSpec("step", .number, default: "10", help: "Percentage points, 1 to 100")

    private static let players: [IntegrationCommandSpec] = ["music", "spotify"].flatMap { app -> [IntegrationCommandSpec] in
        var list = [
            spec(app, "play-pause", "Play/pause", "Toggles playback.", mechanism: .appleScript),
            spec(app, "next", "Next track", "Skips to the next track.", mechanism: .appleScript),
            spec(app, "previous", "Previous track", "Goes to the previous track.", mechanism: .appleScript),
            spec(app, "volume-up", "Volume up", "Raises the app's own volume.", args: [volumeStep], mechanism: .appleScript),
            spec(app, "volume-down", "Volume down", "Lowers the app's own volume.", args: [volumeStep], mechanism: .appleScript),
            spec(app, "now-playing", "Now playing", "Returns \"Title by Artist\", or an empty string when stopped.",
                 mechanism: .appleScript),
        ]
        if app == "music" {
            list.append(spec(app, "like-current", "Favorite current track", "Marks the playing track as a favorite.",
                             mechanism: .appleScript))
        }
        return list
    }

    private static let finder: [IntegrationCommandSpec] = [
        spec("finder", "new-folder-here", "New folder here",
             "Creates \"untitled folder\" in the front Finder window (or the Desktop) and selects it.",
             args: [IntegrationArgSpec("rename", .bool, default: "true", help: "Press Return afterwards to start renaming")],
             mechanism: .appleScriptAndKeys),
        spec("finder", "reveal-desktop", "Show Desktop folder", "Shows the Desktop folder in the front Finder window.",
             mechanism: .appleScript),
        spec("finder", "copy-path-of-selection", "Copy path",
             "Copies the POSIX paths of the selected items (one per line), or of the front folder.", mechanism: .appleScript),
        spec("finder", "open-terminal-here", "Open terminal here", "Opens a terminal window at the front Finder folder.",
             args: [IntegrationArgSpec("terminal", .bundleId, default: "com.apple.Terminal",
                                       help: "Bundle id of the terminal app (e.g. com.googlecode.iterm2)")],
             mechanism: .appleScript, notes: "The terminal itself is opened natively; only Finder is scripted."),
    ]

    private static let presenters: [IntegrationCommandSpec] = {
        var out: [IntegrationCommandSpec] = []
        for app in ["powerpoint", "keynote"] {
            let alignKeys = app == "powerpoint" ? "Command-L / E / R" : "Command-{ / | / }"
            out += [
                spec(app, "next-slide", "Next slide", "Advances the running slide show; outside a show moves to the next slide (Page Down).",
                     mechanism: .appleScriptAndKeys),
                spec(app, "previous-slide", "Previous slide", "Goes back in the running slide show; outside a show Page Up.",
                     mechanism: .appleScriptAndKeys),
                spec(app, "start-presentation", "Start presentation", "Plays the front presentation.", mechanism: .appleScript),
                spec(app, "black-screen", "Black screen", "Toggles a black screen during the slide show.",
                     mechanism: app == "powerpoint" ? .appleScript : .appleScriptAndKeys),
                spec(app, "align-left", "Align text left", "Left-aligns the selected text (\(alignKeys)).", mechanism: .keystrokes),
                spec(app, "align-center", "Align text center", "Centers the selected text (\(alignKeys)).", mechanism: .keystrokes),
                spec(app, "align-right", "Align text right", "Right-aligns the selected text (\(alignKeys)).", mechanism: .keystrokes),
            ]
        }
        return out
    }()

    private static let calls: [IntegrationCommandSpec] = [
        spec("zoom", "toggle-mute", "Mute/unmute", "Zoom's Command-Shift-A, sent to the Zoom window.", mechanism: .keystrokes,
             notes: "Zoom is brought to the front first; its last active window receives the keys."),
        spec("zoom", "toggle-video", "Video on/off", "Zoom's Command-Shift-V, sent to the Zoom window.", mechanism: .keystrokes),
        spec("meet", "toggle-mute", "Mute/unmute", "Finds the Meet call tab in Chrome, brings it forward, sends Command-D.",
             mechanism: .appleScriptAndKeys),
        spec("meet", "toggle-video", "Camera on/off", "Finds the Meet call tab in Chrome, brings it forward, sends Command-E.",
             mechanism: .appleScriptAndKeys),
    ]

    private static let system: [IntegrationCommandSpec] = [
        spec("system", "frontmost-app-bundle-id", "Frontmost app", "Returns the bundle id of the frontmost app.",
             mechanism: .native),
        spec("system", "is-app-running", "Is app running", "Returns \"true\" or \"false\".",
             args: [IntegrationArgSpec("bundleId", .bundleId, required: true, help: "e.g. com.microsoft.Excel")],
             mechanism: .native),
    ]
}
