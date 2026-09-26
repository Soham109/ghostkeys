# Ghostkeys presets

A curated library of actions and ready-made layouts for the app and daemon to load. This
folder is self-contained: it only depends on the shapes documented in `../docs/PROTOCOL.md`
and is not wired into the app or daemon by this change.

## Files

- `library.json` : 242 individual presets, one action each, grouped into 22 categories.
- `layouts/*.json` : 6 full layouts, each a ready-to-use set of 8 to 14 gesture bindings.
- `schema.json` : JSON Schema (2020-12) describing both `library.json` and a layout file.
- `validate.mjs` : dependency-free Node script that checks every file in this folder.

Run the validator after any edit:

```
node presets/validate.mjs
```

It checks:

- every `action` object against the exact kinds and required fields in `docs/PROTOCOL.md`
  (including macro step limits: max 50 steps, max 30000ms total delay)
- unique preset ids in `library.json`, unique binding ids within each layout file
- `requires` entries are `"accessibility"` or `"automation:<bundle id>"`
- shell actions never contain `sudo`, a file-modifying command, a redirect to a file, or a
  networking tool
- an action that is structurally destructive per the protocol (an `app` action with
  `op: "quit"`, or a macro containing one) is flagged `"destructive": true`
- layouts bind between 8 and 14 gestures
- palm rest zones (`left-palm`, `right-palm`) are only ever bound with the `double` gesture
- a destructive action is never bound to a single `tap`
- zone and gesture shape agree (`sequence` needs two zones and no `zone`; the zoneless
  gestures `lid_nudge`, `cover`, `cover_hold`, `tilt_left`, `tilt_right` need no zone at all;
  everything else needs exactly one known zone id)
- no string anywhere in either file contains an em dash or en dash

## `library.json`

```jsonc
{
  "version": 1,
  "presets": [
    {
      "id": "vol-up",
      "title": "Volume up",
      "subtitle": "Raises output volume.",
      "category": "Volume & Display",
      "keywords": ["sound", "loud"],
      "action": { "kind": "volume", "step": 6 },
      "destructive": false,
      "requires": [],
      "apps": ["*"]
    }
  ]
}
```

Field notes:

- `action` is exactly one of the action objects from the `docs/PROTOCOL.md` action kinds
  table (`keystroke`, `volume`, `mute`, `media`, `brightness`, `open`, `shell`,
  `applescript`, `shortcut`, `text`, `macro`, `clipboard`, `window`, `app`, `system`).
- `requires` lists permissions the daemon needs before the action can run:
  `"accessibility"` for anything that simulates a keystroke or drives the Accessibility API
  (`keystroke`, `text`, `window`, and the `app` ops `switch-next` / `switch-previous`), or
  `"automation:<bundle id>"` for an AppleScript that drives a specific app (for example
  `"automation:com.spotify.client"` for a preset that tells Spotify what to do).
- `apps` is `["*"]` for anything that makes sense everywhere, or a list of bundle ids for
  presets that only make sense inside a specific app (Excel, Figma, a browser, and so on).
  A preset can list more than one bundle id, for example the Browser category lists Safari,
  Chrome and Arc together since they share the shortcut.
- `verify: true` marks a shortcut that could not be independently confirmed against current
  Apple, Microsoft or Google documentation (a menu-only command, a shortcut that depends on
  a System Settings toggle the user may not have enabled, or one known to drift between app
  versions). Check it in the real app before shipping it to someone else. Every other preset
  is a shortcut that is currently documented and stable.
- `destructive` is `true` when running the action loses state a user would not expect: quitting
  the frontmost app, or leaving a call. The app should confirm before binding one of these,
  and should probably never put one on a single tap.

Shell presets are deliberately narrow: every one of them is read-only (`git status`, `git log`,
`pwd`, `date`, `whoami`, `sw_vers`), most piping into `pbcopy`. None of them write to a file,
use `sudo`, or reach the network; `validate.mjs` checks this with a pattern match as a second
line of defense.

### Categories (22)

Media, Volume & Display, Window, Spaces & Desktop, System, Apps, Browser, Excel,
Google Sheets, PowerPoint, Keynote, Figma, VS Code / Cursor, Terminal, Slack, Zoom / Meet,
Notion, Writing, Finance modeling, Developer, Productivity, Accessibility.

Counts per category are printed by `validate.mjs` on every run.

## `layouts/*.json`

Each layout is a full set of bindings, ready to merge into `Config.bindings` (see
`docs/PROTOCOL.md`). It does not redefine zones: it binds the eight default zone ids
(`left-palm`, `right-palm`, `left-grille`, `right-grille`, `top-strip`, `left-edge`,
`right-edge`, `lid`) that a fresh install already has, plus, where it helps, one of the
zoneless gestures (`lid_nudge`, `cover`, `cover_hold`, `tilt_left`, `tilt_right`) or a
`sequence` across two zones.

```jsonc
{
  "id": "everyday",
  "name": "Everyday",
  "description": "...",
  "bindings": [
    {
      "id": "b1",
      "enabled": true,
      "gesture": "double",
      "zone": "right-palm",
      "zones": null,
      "modifiers": [],
      "app": "*",
      "action": { "kind": "media", "command": "playpause" },
      "label": "Play or pause",
      "presetId": "media-play-pause"
    }
  ]
}
```

Every field except `presetId` is exactly the `Config.bindings` entry shape from
`docs/PROTOCOL.md`, so a layout's `bindings` array can be spliced straight into a config.
`presetId` is the one addition: an optional back-reference to the `library.json` entry the
binding's action was copied from, for traceability. It is not part of the protocol and the
app can ignore it.

Two rules are enforced everywhere in every layout:

- **Palm rests only take double taps.** `left-palm` and `right-palm` sit under your hands
  while you type, so a stray single tap is expected; only the more deliberate double tap is
  bound there.
- **Destructive actions never sit on a single tap.** Where a layout binds something
  consequential (quitting the frontmost app, leaving a call), it is bound to a `triple` tap
  or another gesture that a hand cannot trigger by accident, never a plain `tap`.

Where an app-specific action differs by app (for example a command palette shortcut that
exists in both VS Code and Cursor, or "next slide" in both Keynote and PowerPoint), the same
zone and gesture is bound twice, once per bundle id, using `app` to disambiguate. Ghostkeys
runs the binding whose `app` matches the frontmost app, so both editors, or both presentation
apps, work from the same physical gesture without either one stepping on the other.

### The six layouts

| file | for |
| --- | --- |
| `everyday.json` | General use: media, volume, brightness, window snapping, lock, quit |
| `finance-analyst-excel.json` | Building and auditing a model in Excel for Mac |
| `designer-figma.json` | Tool switching, zoom, grouping and presenting in Figma |
| `developer-cursor-vscode.json` | Editor shortcuts that work in both VS Code and Cursor |
| `music-and-media.json` | Playback, volume and brightness, plus a tilt gesture to skip tracks |
| `presenter-keynote-powerpoint.json` | Driving a slideshow in Keynote or PowerPoint without a clicker |

## Known gaps

A few presets are marked `"verify": true` because the shortcut is menu-only, depends on a
setting the user has to turn on first (for example Mission Control's "Switch to Desktop N"
shortcuts, off by default), or is likely to drift as Slack, Notion, Zoom or Google Sheets
ship UI changes. Re-check those against the current app before relying on them.
