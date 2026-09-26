# Ghostkeys protocol and shared contract

This file is the contract between the Swift daemon (`daemon/`) and the Electron app (`app/`).
Change it only together with both sides.

## Processes

- `ghostkeysd` (Swift, SwiftPM executable in `daemon/`): reads sensors, detects gestures, runs actions, serves a WebSocket.
- `Ghostkeys.app` (Electron + React in `app/`): UI, onboarding, zone editor, bindings, visualizer, HUD. In dev it spawns
  `daemon/.build/debug/ghostkeysd` (or `release`) as a child process and kills it on quit.

WebSocket: `ws://127.0.0.1:47823/` (bind to loopback only, never 0.0.0.0). Text frames, one JSON object per frame.
Every message has `"type"`. Timestamps `t` are milliseconds since daemon start (double).

## Safety rules (both sides)

- Never use sudo, never install kernel extensions, launch daemons or login items, never change System Settings.
- The daemon may set `ReportInterval`, `SensorPropertyReportingState`, `SensorPropertyPowerState` on `AppleSPUHIDDriver`
  services (needed to stream the motion sensor). It must remember the original values it read and restore them on exit
  (SIGINT, SIGTERM, normal exit). These reset on reboot anyway.
- Actions only run in response to a detected gesture or an explicit `test_action` from the UI.
- `paused` is honored everywhere: when paused, no action runs.
- Config lives in `~/Library/Application Support/Ghostkeys/` only. Nothing else on disk is written.
- No network except the loopback WebSocket.

## Authentication

The daemon only accepts WebSocket handshakes from the app, never from a browser page.

- Token: on every launch the daemon generates 32 random bytes, hex encoded (64 characters), and writes them to
  `~/Library/Application Support/Ghostkeys/token` with mode 0600, replacing the previous one. If the parent passes
  `GHOSTKEYS_TOKEN` in the daemon's environment (at least 32 characters), that value is accepted too.
- Handshake: the client must send the header `X-Ghostkeys-Token: <token>`. A missing or wrong token is rejected.
- Any handshake that carries an `Origin` header is rejected (browsers always send one; the app must not).
- Limits: at most 8 clients; more than 200 messages per second from one client disconnects it; at most 2
  `test_action` per second per client. A client that stops reading first loses stream frames (`imu`, `light`, `lid`,
  `taps`), then is disconnected once about 1 MB is waiting.
- Approval of powerful actions: `shell`, `applescript`, `shortcut` and `open` actions (also as macro steps) only run if
  they carry `approvedHash` and that hash is in the daemon's `approved.json`. The app shows a native confirmation with
  the exact command, then sends `approve_action`; the daemon replies with the hash, which the app stores in the action as
  `approvedHash`. The hash is SHA-256 over the action without `approvedHash`, `label` and `delayMs`, computed by the
  daemon only, so changing the command invalidates it. `approved.json` is written only by the daemon. Even approved,
  commands using `sudo`, `rm -rf`, `diskutil`, `csrutil`, `launchctl`, `defaults write`, `networksetup`, `curl | sh`,
  or AppleScript admin privileges are refused.

## Surfaces and zones

Laptop top view, normalized coordinates: x from 0 (left edge of the base) to 1 (right edge), y from 0 (hinge) to 1 (front lip).

```json
{ "id": "right-grille", "name": "Right grille", "surface": "base", "rect": { "x": 0.88, "y": 0.08, "w": 0.1, "h": 0.45 }, "color": "#7C5CFF" }
```

`surface` is one of `base`, `lid`, `edge-left`, `edge-right`, `front`. Zones are what the classifier learns: each calibrated zone
is a class. The special class `none` means "rejected".

Default zones (MacBook Pro): `left-palm`, `right-palm`, `left-grille`, `right-grille`, `top-strip`, `left-edge`, `right-edge`, `lid`.

## Gestures

| gesture | meaning |
| --- | --- |
| `tap` | one tap in a zone |
| `double` | two taps, same zone, 80 to 350 ms apart |
| `triple` | three taps |
| `sequence` | two taps in different zones within 500 ms; `zones` holds both in order |
| `rhythm` | tap, pause 350 to 900 ms, double tap in the same zone |
| `lid_nudge` | lid angle moves back 3 to 15 degrees and returns within 1.5 s |
| `cover` | ambient light drops over 70% within 0.5 s and recovers within 2 s |
| `cover_hold` | ambient light stays covered over 1.2 s |
| `tilt_left` / `tilt_right` | laptop rolled over 8 degrees and back while held |

Optional sound mode (GhostkeysAcoustics, mic sessions only):

| gesture | meaning |
| --- | --- |
| `knock_knuckle` | a tap in a zone that sound classifies as a knuckle (a fingertip tap stays `tap`) |
| `rub` / `rub_left` / `rub_right` | fingertip rub or swipe on a palm rest or grille; left/right only when direction confidence >= 0.7 |
| `wave_toward` / `wave_away` / `wave_sweep` | hand movement above the keyboard, via an inaudible 20 kHz pilot tone (built-in speakers only) |

Optional camera add-on (GhostkeysVision, camera sessions only), sent with `"zone": "air"` plus `hand`, `x`, `y`:

| gesture | meaning |
| --- | --- |
| `air_tap` | pinch and release in under 250 ms |
| `pinch_drag_left` / `_right` / `_up` / `_down` | pinch, move, release |
| `palm_swipe_left` / `palm_swipe_right` | open palm sweep |
| `circle_cw` / `circle_ccw` | one step per 30 degrees of a drawn circle |

Continuous camera gestures (`pinch_hold` with dx/dy, `two_hand_zoom` with scale, `point` with x/y) arrive as
`{ "type": "air", "phase": "began|changed|ended", "gesture": "...", ... }`. Sessions: app sends `air_session_start` /
`air_session_stop` and `sound_session_start` / `sound_session_stop`; daemon replies `{ "type": "session", "kind": "air|sound", "active": true, "secondsLeft": 30 }`.
`hello.sensors` gains `sound` and `camera` booleans. `tap` may carry `"tapType": "fingertip|knuckle|nail"` and `"source": "imu|camera"`.

Modifiers held at gesture time: any of `shift`, `control`, `option`, `command`, `fn`.

## Daemon to app

```jsonc
{ "type": "hello", "version": "0.1.0", "device": { "model": "Mac17,8", "chip": "Apple M5 Pro", "family": "macbook-pro-14" },
  "sensors": { "imu": true, "gyro": true, "lid": true, "light": true, "sound": true, "camera": true },
  "permissions": { "accessibility": false, "microphone": "authorized", "camera": "not_determined" } }
  // sensors.sound / camera: the hardware exists (checked without opening it). microphone / camera permission:
  // "authorized" | "denied" | "not_determined" (not_determined: only a session the app starts may show the macOS prompt)
{ "type": "status", "paused": false, "pausedReason": null, "calibrated": true, "zones": ["left-palm", "..."], "imuHz": 797,
  "detector": { "noiseFloorMg": 1.2, "thresholdMg": 17.5, "level": 3.1 } }   // pausedReason: "user" | "rate_limit" | null
{ "type": "imu", "t": 1234.5, "a": [0.01, -0.02, -0.99], "g": [0.1, 0.0, -0.2] }      // only when subscribed; ~60 Hz decimated
{ "type": "lid", "t": 1234.5, "angle": 112 }                                               // only when subscribed; on change
{ "type": "light", "t": 1234.5, "value": 0.42 }                                            // only when subscribed; 0..1 normalized
{ "type": "tap", "t": 1234.5, "zone": "right-grille", "confidence": 0.93, "x": 0.91, "y": 0.2, "strength": 0.6, "source": "imu" }  // every accepted tap
  // "taps" stream. source: "imu" (motion sensor) or "camera" (desk mode touch confirmed by an IMU tap).
  // tapType: "fingertip" | "knuckle" | "nail", only while a sound session with a tap-type model runs (the message may
  // then arrive up to 150 ms late, while the sound is classified).
{ "type": "air", "t": 1234.5, "gesture": "pinch_hold", "phase": "changed", "hand": "right", "x": 0.5, "y": 0.4, "dx": 0.0, "dy": -0.004, "confidence": 0.9 }
  // "air" stream: continuous camera gestures (pinch_hold with dx/dy, two_hand_zoom with scale, point with x/y);
  // phase: began | changed | ended. Discrete camera gestures arrive as "gesture" messages with zone "air" plus hand/x/y.
{ "type": "session", "kind": "sound", "active": true, "secondsLeft": 30, "trigger": "request", "sonar": false, "tapTypes": true }
  // kind: "sound" | "air". Sent on start, stop, every 5 s while active, and to each new client on connect.
  // trigger (active only): "request" (app asked) | "auto" (pinned app in settings). reason (on stop): "timeout" |
  // "requested" | "paused" | "app_changed" | "no_hand" | "lid_closed" | "error" (then "error": "...").
  // sound only: sonar (pilot tone playing), tapTypes (tap-type model loaded). simulated: true under --no-hardware-sessions.
{ "type": "rejected", "t": 1234.5, "reason": "typing" }        // reason: typing | trackpad | motion | low_confidence | burst | paused
{ "type": "gesture", "t": 1234.5, "gesture": "double", "zone": "right-grille", "zones": ["right-grille"], "modifiers": ["shift"], "confidence": 0.91, "app": "com.microsoft.Excel" }
{ "type": "action", "t": 1234.5, "bindingId": "b1", "label": "Volume up", "ok": true, "error": null }
{ "type": "calibration", "phase": "capturing", "zone": "left-palm", "count": 7, "target": 20 }
{ "type": "calibration", "phase": "negatives", "secondsLeft": 42 }
{ "type": "calibration", "phase": "done", "accuracy": { "left-palm": 0.97 }, "overall": 0.95, "confusion": [[...]], "labels": ["..."] }
{ "type": "calibration", "phase": "taptype_capturing", "tapType": "knuckle", "count": 4, "target": 15, "types": ["fingertip", "knuckle", "nail"] }
  // tap-type calibration: make `target` taps of `tapType`; the daemon moves to the next type by itself.
  // "missed": true means the motion sensor felt a tap but the microphone heard no clear onset (not counted).
{ "type": "calibration", "phase": "taptype_training" }
{ "type": "calibration", "phase": "taptype_done", "accuracy": 0.93, "counts": { "fingertip": 15, "knuckle": 15, "nail": 15 }, "types": ["..."] }
  // accuracy: leave-one-out over the captured taps. The model is saved to model/tap-types.json and used at once.
{ "type": "calibration", "phase": "taptype_failed", "error": "..." }   // also: "taptype_cancelled" with "reason"
{ "type": "config", "config": { /* full config, see below */ } }
{ "type": "error", "message": "..." }
{ "type": "approved", "hash": "<64 hex>", "kind": "shell" }  // reply to approve_action, only to the requester
{ "type": "revoked", "hash": "<64 hex>", "found": true }     // reply to revoke_action, only to the requester
{ "type": "catalog", "catalog": { "apps": [...], "commands": [...], "unsupported": { } } }  // reply to catalog_get
```

## App to daemon

```jsonc
{ "type": "subscribe", "streams": ["imu", "lid", "light", "taps", "air"] }
{ "type": "unsubscribe", "streams": ["imu"] }
{ "type": "pause" }  { "type": "resume" }
{ "type": "calibration_start", "zones": ["left-palm", "right-palm"], "target": 20 }
{ "type": "calibration_zone", "zone": "left-palm" }        // following taps are labeled with this zone
{ "type": "calibration_negatives", "seconds": 45 }          // user types/uses the trackpad; everything is labeled none
{ "type": "calibration_finish" }                             // train, save, reply with calibration done
{ "type": "calibration_cancel" }
{ "type": "config_get" }
{ "type": "config_set", "config": { } }                      // daemon saves and replies with config
{ "type": "test_action", "action": { } }
{ "type": "request_permission", "which": "accessibility" }   // daemon calls AXIsProcessTrustedWithOptions(prompt: true)
{ "type": "approve_action", "action": { "kind": "shell", "command": "..." } }  // only after the user confirmed natively
{ "type": "revoke_action", "hash": "<64 hex>" }              // or { "action": { ... } }
{ "type": "catalog_get" }                                    // daemon replies { "type": "catalog", "catalog": IntegrationCatalog.json }
{ "type": "sound_session_start", "seconds": 30 }             // opens the mic (orange dot) for up to 120 s; seconds defaults to settings.sound.sessionSeconds
{ "type": "sound_session_stop" }
{ "type": "air_session_start", "camera": "front", "seconds": 30 }  // camera: "front" | "desk_view" (desk_view needs settings.camera.deskMode)
{ "type": "air_session_stop" }
{ "type": "calibration_taptype_start", "types": ["fingertip", "knuckle", "nail"], "target": 15 }
  // needs an active sound session (extended to 120 s); taps are labeled in the order of `types`, target 3...50
{ "type": "calibration_taptype_cancel" }
// Test-only, accepted only when the daemon runs with --no-hardware-sessions (simulated sessions):
// { "type": "sim_tap", "zone": "right-grille" }  { "type": "sim_tap_type", "tapType": "knuckle" }
// { "type": "sim_air", "phase": "began|changed|ended", "dx": 0.05, "dy": 0 }
```

## Config file (`~/Library/Application Support/Ghostkeys/config.json`)

```jsonc
{
  "version": 1,
  "zones": [ /* zone objects */ ],
  "bindings": [
    { "id": "b1", "enabled": true, "gesture": "double", "zone": "right-grille", "zones": null,
      "modifiers": [], "app": "*",                     // "*" or a bundle id; app-specific wins over "*"
      "action": { "kind": "volume", "step": 6 } ,
      "label": "Volume up" },
    { "id": "k1", "enabled": true, "gesture": "pinch_hold", "zone": "air", "zones": null, "modifiers": [], "app": "*",
      "action": { "kind": "volume", "step": 2 }, "label": "Volume knob",
      "knob": { "axis": "y", "stepPx": 24, "inverse": { "kind": "volume", "step": -2 } } }
  ],
  "settings": { "sensitivity": 0.5, "typingGateMs": 450, "doubleWindowMs": 350, "minConfidence": 0.8, "hud": true, "haptics": false,
    "sound":  { "enabled": false, "sessionSeconds": 30, "autoApps": [] },
    "camera": { "enabled": false, "sessionSeconds": 30, "autoApps": [], "deskMode": false } }
}
```

- `knob` (only on `pinch_hold` bindings): while the pinch is held, `action` runs once per `stepPx` of travel along
  `axis` (camera pixels at 640x480, so 24 px is 5% of the frame height). Positive travel is right (`x`) or up (`y`);
  travel the other way runs `inverse` if present. The hold itself does not fire the action. Steps go through the
  action limits but never auto-pause: a step over 5/s or 60/min, or with 3 steps of that binding still queued, is dropped.
- `settings.sound` / `settings.camera`: sessions never start at launch. They start when the app sends
  `sound_session_start` / `air_session_start`, or, when `enabled` is true, automatically while an app listed in
  `autoApps` (bundle ids) is frontmost and a binding for sound (or camera) gestures exists; they stop when that app
  loses focus. Sessions end after `sessionSeconds` (max 120), on pause, and (camera) after 10 s without a hand or when
  the lid closes. `deskMode` allows `"camera": "desk_view"` sessions (experimental).
- Knuckle taps: while a sound session with a tap-type model runs, an IMU `tap` gesture in a zone that has a
  `knock_knuckle` binding waits up to 150 ms for the sound; exactly one of `tap` or `knock_knuckle` is emitted.

Action kinds:

| kind | fields | how the daemon runs it |
| --- | --- | --- |
| `keystroke` | `key` (e.g. `"v"`, `"f4"`, `"left"`), `modifiers` | CGEvent keyboard events (needs Accessibility) |
| `volume` | `step` (+/- percent) | `osascript -e 'set volume output volume ...'` relative to current |
| `mute` | | toggle output mute |
| `media` | `command`: `playpause`, `next`, `previous` | NX system-defined media key events |
| `brightness` | `step` | media key events for brightness up/down |
| `open` | `target` (app name, path or URL) | `/usr/bin/open` |
| `shell` | `command` | `/bin/zsh -lc` with 10 s timeout, never with sudo |
| `applescript` | `source` | NSAppleScript |
| `shortcut` | `name` | `/usr/bin/shortcuts run` |
| `text` | `text` | types the text via CGEvent unicode events |
| `macro` | `steps` (array of any actions above, each may carry `delayMs` to wait before it) | runs steps in order on a background queue; stops at the first failure; max 50 steps, max 30 s total |
| `clipboard` | `text` | puts text on the pasteboard |
| `window` | `op`: `left`, `right`, `top`, `bottom`, `maximize`, `center`, `next-display`, `minimize`, `fullscreen` | moves or resizes the frontmost window via the Accessibility API |
| `app` | `op`: `hide`, `quit`, `switch-next`, `switch-previous` | acts on the frontmost app (quit is destructive: the UI must confirm when binding it) |
| `integration` | `app` (e.g. `excel`, `chrome`, `safari`, `arc`, `music`, `spotify`, `finder`, `powerpoint`, `keynote`, `zoom`), `command`, `args` | context-aware command implemented by the GhostkeysIntegrations module (e.g. excel `wrap-iferror`, `toggle-absolute`, `cycle-number-format`, `insert-xlookup`); needs Automation permission for that app |
| `system` | `op`: `lock`, `sleep-display`, `screenshot`, `screenshot-area`, `dnd-toggle`, `mission-control`, `launchpad`, `show-desktop` | built-in macOS commands, never anything that needs admin rights |

Samples and models live in `~/Library/Application Support/Ghostkeys/model/`.
