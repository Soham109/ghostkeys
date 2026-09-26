# GhostkeysIntegrations

Context-aware commands for the `integration` action kind (see `docs/PROTOCOL.md`). A binding such as
`{ "kind": "integration", "app": "excel", "command": "toggle-absolute", "args": {} }` ends up here.

## API

```swift
// Result is JSON: {"followUpKeys":[{"key":"u","modifiers":["ctrl"]}],"output":"..."}
let r: Result<String, IntegrationError> = await IntegrationRunner.run(app: "excel", command: "wrap-iferror", args: ["fallback": "0"])

// Structured form of the same thing.
let s: Result<IntegrationResult, IntegrationError> = await IntegrationRunner.shared.execute(app: "chrome", command: "copy-url")

// Everything the app needs to list commands (titles, args, destructive flag, bundle id needing Automation).
IntegrationCatalog.commands      // [IntegrationCommandSpec]
IntegrationCatalog.json          // same, as JSON, plus `apps` and `unsupported`

// Automation permission, checked without showing the prompt (the app must be running).
IntegrationRunner.automationPermission(bundleId: "com.microsoft.Excel")

// Loosely typed JSON args (numbers, booleans) to the [String: String] the runner takes.
IntegrationArgs.strings(from: jsonObject)
```

**What the daemon does with a result.** If `followUpKeys` is not empty, the runner has already brought the
target app to the front; the daemon posts the keys in order, exactly like `keystroke` actions (same key and
modifier names as `KeyCodes`). That needs Accessibility permission. Everything else is already done.

**Errors** (`IntegrationError`): `unknownApp`, `unknownCommand`, `invalidArgument`, `appNotRunning`,
`appNotInstalled`, `notAuthorized` (Automation permission missing), `unsupported`, `nothingToActOn` (no window,
no selection, no Meet tab...), `refused` (would lose data, or selection too large), `timedOut`, `scriptFailed`.

## Safety rules built in

- **No string injection.** Every script is a fixed string in `Scripts/Scripts.swift` defining
  `on gk_main(args)`. The runner calls that handler with a subroutine Apple Event and passes arguments as
  Apple Event data, so user text never becomes script source. Text that ends up inside an Excel formula
  (the IFERROR fallback) is turned into a quoted Excel string literal unless it is a plain number or TRUE/FALSE.
- **Never launches an app.** Commands fail with `appNotRunning` if the app is closed. The one exception is
  `open-url`, which opens the page through NSWorkspace.
- **Bounded.** Every script runs inside `with timeout`. Excel commands clip the selection to the used range and
  refuse more than 5,000 cells.
- **One AppleScript at a time.** All scripts run on one process-wide serial queue. Two NSAppleScript instances
  on different threads were seen to corrupt each other's results in tests.
- **Excel undo.** Excel does not record edits made over Apple Events in its undo history. Those commands are
  flagged `undoable: false`; the formula ones have an inverse (`unwrap-iferror`, more `toggle-absolute`
  presses). `fill-down`, `fill-right` and `autosum` use Excel's own shortcuts so they stay undoable.
  `insert-*` refuses a non-empty cell unless `overwrite` is true. `paste-values` is marked destructive.
- `finder/toggle-hidden-files` is deliberately left out: it rewrites Finder's preferences and restarts Finder.

## Pure logic (unit tested, no apps involved)

- `A1Formula` / `A1Reference`: tokenizer for A1 formulas. Handles cross-sheet refs (`'My Sheet'!A1`,
  `Sheet1!A1`, `[Book.xlsx]Sheet1!A1`, 3-D `Jan:Mar!B2`), ranges, whole columns `A:A` and rows `1:1`,
  string literals with `$` inside, function names that look like cells (`LOG10(`), structured references,
  error literals. R1C1 is not supported and is left untouched. Joining the tokens always gives back the input.
- `toggle-absolute`: every reference moves to the next state after the *first* reference's state
  ($A$1 -> A$1 -> $A1 -> A1 -> $A$1), so a mixed selection lines up after one press. Whole columns and rows
  only have one anchor, so they toggle.
- `IfErrorTransform`: wrap is idempotent (an already wrapped formula is left alone); unwrap only removes an
  IFERROR that spans the whole formula; unwrap(wrap(f)) == f.
- `NumberFormatCycle`, `DecimalPlaces` (Excel's Increase/Decrease Decimal on format codes, all sections,
  skipping quoted text, `[Red]`, `_x`, `*x`), `MarkdownLink`, `URLArgument` (http/https only), `MeetTab`.

## Catalog

### excel (Microsoft Excel, `com.microsoft.Excel`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `wrap-iferror` | Wraps each formula in the selection in IFERROR(formula, fallback). Already wrapped formulas are left alone. | script | no (no undo) | `fallback` = 0 |
| `unwrap-iferror` | Removes an IFERROR wrapper that spans the whole formula, in each selected cell. | script | no (no undo) |  |
| `toggle-absolute` | Cycles every reference in the selected formulas through $A$1, A$1, $A1, A1, like F4. | script | no (no undo) |  |
| `cycle-number-format` | Steps the selection through General, #,##0, #,##0.0%, 0.0x, $#,##0. | script | no (no undo) |  |
| `increase-decimals` | Adds one decimal place to the selection's number format (based on the active cell). | script | no (no undo) |  |
| `decrease-decimals` | Removes one decimal place from the selection's number format (based on the active cell). | script | no (no undo) |  |
| `color-inputs-formulas` | Blue font for hard-coded numbers, black for formulas, in the selection. | script | no (no undo) | `includeText` = false |
| `insert-xlookup` | Puts =XLOOKUP(,,) in the active cell and leaves the cursor on the first argument. | script + keys | no | `overwrite` = false |
| `insert-index-match` | Puts =INDEX(,MATCH(,,0)) in the active cell and leaves the cursor on the first argument. | script + keys | no | `overwrite` = false |
| `insert-sumifs` | Puts =SUMIFS(,,) in the active cell and leaves the cursor on the first argument. | script + keys | no | `overwrite` = false |
| `paste-values` | Pastes the clipboard into the selection as values only. | script | yes |  |
| `fill-down` | Copies the top row of the selection down (Command-D). | keys | no |  |
| `fill-right` | Copies the left column of the selection right (Command-R). | keys | no |  |
| `autosum` | Inserts a SUM of the adjacent range (Command-Shift-T). | keys | no |  |
| `trace-precedents` | Draws arrows to the active cell's direct precedents. | script + keys | no |  |

### chrome (Google Chrome, `com.google.Chrome`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `new-tab` | Opens a new tab in the front window. | script | no |  |
| `close-tab` | Closes the active tab. | script | no |  |
| `reopen-closed-tab` | Reopens the last closed tab (Command-Shift-T). | keys | no |  |
| `next-tab` | Switches to the next tab, wrapping around. | script | no |  |
| `previous-tab` | Switches to the previous tab, wrapping around. | script | no |  |
| `duplicate-tab` | Opens the active tab's page again in a new tab. | script | no |  |
| `copy-url` | Copies the active tab's address. | script | no |  |
| `copy-markdown-link` | Copies [title](url) for the active tab. | script | no |  |
| `open-url` | Opens an address in this browser. | native | no | `url` (required) |
| `move-tab-to-new-window` | Closes the active tab and opens its address in a new window. | script | no |  |

### arc (Arc, `company.thebrowser.Browser`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `new-tab` | Opens a new tab in the front window. | keys | no |  |
| `close-tab` | Closes the active tab. | keys | no |  |
| `reopen-closed-tab` | Reopens the last closed tab (Command-Shift-T). | keys | no |  |
| `next-tab` | Switches to the next tab, wrapping around. | keys | no |  |
| `previous-tab` | Switches to the previous tab, wrapping around. | keys | no |  |
| `duplicate-tab` | Opens the active tab's page again in a new tab. | script | no |  |
| `copy-url` | Copies the active tab's address. | script | no |  |
| `copy-markdown-link` | Copies [title](url) for the active tab. | script | no |  |
| `open-url` | Opens an address in this browser. | native | no | `url` (required) |
| `pin-tab` | Pins or unpins the active tab (Command-D). | keys | no |  |

### safari (Safari, `com.apple.Safari`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `new-tab` | Opens a new tab in the front window. | script | no |  |
| `close-tab` | Closes the active tab. | script | no |  |
| `reopen-closed-tab` | Reopens the last closed tab (Command-Shift-T). | keys | no |  |
| `next-tab` | Switches to the next tab, wrapping around. | script | no |  |
| `previous-tab` | Switches to the previous tab, wrapping around. | script | no |  |
| `duplicate-tab` | Opens the active tab's page again in a new tab. | script | no |  |
| `copy-url` | Copies the active tab's address. | script | no |  |
| `copy-markdown-link` | Copies [title](url) for the active tab. | script | no |  |
| `open-url` | Opens an address in this browser. | native | no | `url` (required) |
| `move-tab-to-new-window` | Closes the active tab and opens its address in a new window. | script | no |  |

### music (Music, `com.apple.Music`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `play-pause` | Toggles playback. | script | no |  |
| `next` | Skips to the next track. | script | no |  |
| `previous` | Goes to the previous track. | script | no |  |
| `volume-up` | Raises the app's own volume. | script | no | `step` = 10 |
| `volume-down` | Lowers the app's own volume. | script | no | `step` = 10 |
| `now-playing` | Returns "Title by Artist", or an empty string when stopped. | script | no |  |
| `like-current` | Marks the playing track as a favorite. | script | no |  |

### spotify (Spotify, `com.spotify.client`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `play-pause` | Toggles playback. | script | no |  |
| `next` | Skips to the next track. | script | no |  |
| `previous` | Goes to the previous track. | script | no |  |
| `volume-up` | Raises the app's own volume. | script | no | `step` = 10 |
| `volume-down` | Lowers the app's own volume. | script | no | `step` = 10 |
| `now-playing` | Returns "Title by Artist", or an empty string when stopped. | script | no |  |

### finder (Finder, `com.apple.finder`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `new-folder-here` | Creates "untitled folder" in the front Finder window (or the Desktop) and selects it. | script + keys | no | `rename` = true |
| `reveal-desktop` | Shows the Desktop folder in the front Finder window. | script | no |  |
| `copy-path-of-selection` | Copies the POSIX paths of the selected items (one per line), or of the front folder. | script | no |  |
| `open-terminal-here` | Opens a terminal window at the front Finder folder. | script | no | `terminal` = com.apple.Terminal |

### powerpoint (Microsoft PowerPoint, `com.microsoft.Powerpoint`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `next-slide` | Advances the running slide show; outside a show moves to the next slide (Page Down). | script + keys | no |  |
| `previous-slide` | Goes back in the running slide show; outside a show Page Up. | script + keys | no |  |
| `start-presentation` | Plays the front presentation. | script | no |  |
| `black-screen` | Toggles a black screen during the slide show. | script | no |  |
| `align-left` | Left-aligns the selected text (Command-L / E / R). | keys | no |  |
| `align-center` | Centers the selected text (Command-L / E / R). | keys | no |  |
| `align-right` | Right-aligns the selected text (Command-L / E / R). | keys | no |  |

### keynote (Keynote, `com.apple.Keynote`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `next-slide` | Advances the running slide show; outside a show moves to the next slide (Page Down). | script + keys | no |  |
| `previous-slide` | Goes back in the running slide show; outside a show Page Up. | script + keys | no |  |
| `start-presentation` | Plays the front presentation. | script | no |  |
| `black-screen` | Toggles a black screen during the slide show. | script + keys | no |  |
| `align-left` | Left-aligns the selected text (Command-{ / \| / }). | keys | no |  |
| `align-center` | Centers the selected text (Command-{ / \| / }). | keys | no |  |
| `align-right` | Right-aligns the selected text (Command-{ / \| / }). | keys | no |  |

### zoom (Zoom, `us.zoom.xos`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `toggle-mute` | Zoom's Command-Shift-A, sent to the Zoom window. | keys | no |  |
| `toggle-video` | Zoom's Command-Shift-V, sent to the Zoom window. | keys | no |  |

### meet (Google Meet (in Chrome), `com.google.Chrome`)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `toggle-mute` | Finds the Meet call tab in Chrome, brings it forward, sends Command-D. | script + keys | no |  |
| `toggle-video` | Finds the Meet call tab in Chrome, brings it forward, sends Command-E. | script + keys | no |  |

### system (System)

| command | what it does | how | destructive | args |
| --- | --- | --- | --- | --- |
| `frontmost-app-bundle-id` | Returns the bundle id of the frontmost app. | native | no |  |
| `is-app-running` | Returns "true" or "false". | native | no | `bundleId` (required) |

"script" needs Automation permission for the app. "keys" needs Accessibility (the daemon posts them).
"native" needs neither. "no (no undo)" means the change skips the app's undo history.

### Not supported (the runner answers `unsupported`)

| command | why |
| --- | --- |
| `spotify/like-current` | Spotify's scripting dictionary has no way to like or save a track |
| `chrome/pin-tab`, `safari/pin-tab` | no scripting command and no default shortcut |
| `arc/move-tab-to-new-window` | no scripting command and no default shortcut |
| `finder/toggle-hidden-files` | left out on purpose (changes Finder preferences) |

### Shortcuts relied on

Excel for Mac: Control-U (edit cell), Command-D, Command-R, Command-Shift-T (AutoSum), Control-[ (select
direct precedents, fallback only). Browsers: Command-Shift-T. Arc: Command-T, Command-W, Command-Option-Down/Up,
Command-D. PowerPoint: Command-L/E/R. Keynote: Command-{ | }, B during a show. Zoom: Command-Shift-A,
Command-Shift-V. Meet: Command-D, Command-E. Outside a slide show, next/previous slide falls back to
Page Down / Page Up.

## Testing

```sh
cd daemon
swift build --scratch-path .build-integrations --target GhostkeysIntegrations
swift test  --scratch-path .build-integrations --filter GhostkeysIntegrationsTests
GHOSTKEYS_COMPILE_SCRIPTS=1 swift test ...   # also compiles every script against installed, closed apps
```

Unit tests fake the script executor and the system (`FakeScripts`, `FakeEnv`), so they never contact an app.
The only real AppleScript they run is a handler with no `tell` block, to prove arguments arrive as data.

Not verified against live apps yet (by design during development): anything that sends events to Excel,
browsers, players, Finder, PowerPoint, Keynote. Scripts for Excel, PowerPoint, Keynote, Music and Safari
compile against those apps' real dictionaries; Chrome, Spotify and Finder scripts compile against copies of
their dictionaries. Arc is not installed on the dev machine, so its two scripts are unchecked.
