# Ghostkeys for Raycast

A Raycast extension for [Ghostkeys](../../README.md): check daemon/sensor status, pause or resume
detection, search and edit gesture bindings, bind presets, watch gestures live, and apply zone
layouts, all from Raycast.

It talks to the local `ghostkeysd` daemon over `ws://127.0.0.1:47823/` using
[`@ghostkeys/sdk`](../sdk) (a `file:../sdk` dependency), which implements the protocol in
[`docs/PROTOCOL.md`](../../docs/PROTOCOL.md). It never talks to anything else, and it never writes
to `~/Library/Application Support/Ghostkeys/` directly, only to the daemon over that socket.
`src/lib/client.ts` is a thin adapter over the SDK's `GhostkeysClient` (always injects `ws`'s
`WebSocket` explicitly rather than relying on a runtime's global `WebSocket`, and adds a
`withGhostkeysClient` helper for one-shot connect/do-something/disconnect flows).

## Commands

| Command | Mode | What it does |
| --- | --- | --- |
| Ghostkeys Status | view | Sensors, paused/calibrated state, IMU rate, and a live feed of the most recent gestures. |
| Pause / Resume Ghostkeys | no-view | Toggles pause based on current daemon state; shows a HUD. |
| Search Bindings | view | Search bindings by gesture, zone, app, or action. Toggle enabled, dry-test (preview only, never runs the action), or copy the binding as JSON. |
| Bind a Preset | view | Pick a preset action, choose a zone and gesture in a form, confirm, and it's added as a new binding. |
| Watch Gestures | view | Live-updating feed of taps, gestures, rejections, and action results as they happen. |
| Apply Layout | view | Pick a zone layout from `presets/layouts/`, preview a diff against the daemon's current zones, confirm, and apply. |

## Presets and layouts

- **Bind a Preset** reads `presets/library.json` at the repo root if it exists (an array of
  presets, or `{ "presets": [...] }`, each needing at least `name` and `action`). If that file
  doesn't exist yet, it falls back to a small built-in preset list (`src/lib/presets.ts`) so the
  command still does something useful. Once `presets/library.json` exists, it's used instead of
  the built-ins.
- **Apply Layout** reads every `*.json` file in `presets/layouts/` (each needing `name` and
  `zones`, matching the zone shape in `docs/PROTOCOL.md`). If that directory has no layouts, the
  command shows an empty state instead of erroring.

Both paths are resolved by walking up from wherever the code actually runs (`src/lib/paths.ts`)
until it finds a directory containing both `presets/` and `daemon/`, so it works the same whether
running via `ray develop`, a bundled `ray build`, or the test suite. Set `GHOSTKEYS_REPO_ROOT` to
override (used by tests).

## Safety choices worth knowing about

- **Search Bindings**'s "Test Action (Dry)" never sends `test_action` to the daemon. It only shows
  what the action would do (label + JSON). This avoids firing something destructive (like `app`
  `quit`, a `shell` command, or an `applescript`) straight from a list item.
- **Bind a Preset** and **Apply Layout** both show a native confirmation dialog
  (`confirmAlert`) before sending `config_set`, on top of the form/diff-preview step itself.
- **Apply Layout**'s diff calls out any existing bindings that reference a zone the new layout
  removes, so you know before applying that they'd stop matching.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm test            # runs the fake-daemon test suite (node's built-in test runner via tsx)
npm run build       # ray build -e dist -o dist
```

`ray build` worked locally without a Raycast install or login (it only warns, non-fatally, that it
can't notify a running Raycast app to refresh). If that ever isn't true in some other environment,
fall back to `npm run typecheck`, which checks the same command source.

`ray lint` also runs locally, but its `validate package.json` step calls Raycast's API to check
that `author` is a real, registered Raycast store username, which `sohamaggarwal` (a placeholder)
isn't. That only matters for store submission; update `author` in `package.json` to a real
Raycast/GitHub handle before publishing.

Note: `@raycast/api` asks for Node `>=22.22.2`; this machine has `22.22.0`, so `npm install` prints
an `EBADENGINE` warning. It hasn't caused any actual problem (install, typecheck, tests, and
`ray build` all pass), but a real machine on a slightly newer Node patch won't even see the
warning.

### Testing without touching the real daemon or config

`test/fake-daemon.ts` is a tiny in-memory stand-in for `ghostkeysd`: it binds to an ephemeral
loopback port, speaks just enough of the protocol (`hello`/`status`/`config` greet burst on
connect, `config_get`/`config_set`, `pause`/`resume`, and lets a test `emit()` arbitrary frames
like `gesture` or `tap`), and is torn down after each test. Nothing in `test/` ever points at
`ws://127.0.0.1:47823/` or `~/Library/Application Support/Ghostkeys/`. Run it with `npm test`.

### Two things worth flagging upstream in `@ghostkeys/sdk`

Found while writing these tests; neither affects this extension's actual behavior (see below), but
both are real bugs in the SDK:

1. **Orphaned hello-wait timer on early connection failure.** `GhostkeysClient.openSocket()`
   creates its hello-wait promise (with its own `setTimeout`) before awaiting the "did the socket
   open" gate. If that gate rejects first (a `ws` `'error'`/`'close'` before `'open'` — e.g. the
   port refuses the connection), the function throws without ever awaiting or cancelling the
   hello-wait promise. Its timer still fires later and rejects an orphaned promise, surfacing as an
   `unhandledRejection` well after `connect()` already rejected for a different reason. We route
   around this in tests by only exercising the "socket opens, hello never arrives" timeout path
   (via `FakeGhostkeysDaemon.start({ greetOnConnect: false })`), not "nothing is listening at all".
2. **`getConfig()` can resolve on an unrelated `config` broadcast.** `getConfig()` calls
   `awaitEvent('config', () => true, ...)`, which matches the *next* `config` message, not
   specifically the reply to the `config_get` it's about to send. The real daemon's `greet()` (and
   the fake's) pushes an unsolicited `config` right after `hello` on every connection; if that
   frame is still in flight when `getConfig()` is called immediately after `connect()` (a natural
   pattern — this extension's `withGhostkeysClient` does exactly that), `getConfig()` can resolve
   against the greet's `config` instead of a true round trip. The SDK's own code comment already
   flags the "another client's concurrent `config_set`" version of this race as out of scope; this
   is the same class of issue but triggered by the same connection's own greet, which is far more
   likely to actually happen. It doesn't corrupt anything for this extension (the greet's `config`
   is just as current as an explicit reply would be, and the revision returned alongside it is
   consistent with whatever data you act on), but it did make one of our tests flaky (~1 in 6 runs)
   until we added a short settle delay after `connect()` before calling `getConfig()` — see the
   comment on that test in `test/client.test.ts`.

## Icon

`assets/icon.png` is copied from `assets/icon/AppIcon.iconset/icon_512x512.png` at the repo root
(the same Ghostkeys mark used elsewhere), so the extension icon matches the rest of the project.
