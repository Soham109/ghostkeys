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

Modifiers held at gesture time: any of `shift`, `control`, `option`, `command`, `fn`.

## Daemon to app

```jsonc
{ "type": "hello", "version": "0.1.0", "device": { "model": "Mac17,8", "chip": "Apple M5 Pro", "family": "macbook-pro-14" },
  "sensors": { "imu": true, "gyro": true, "lid": true, "light": true }, "permissions": { "accessibility": false } }
{ "type": "status", "paused": false, "calibrated": true, "zones": ["left-palm", "..."], "imuHz": 797 }
{ "type": "imu", "t": 1234.5, "a": [0.01, -0.02, -0.99], "g": [0.1, 0.0, -0.2] }      // only when subscribed; ~60 Hz decimated
{ "type": "lid", "t": 1234.5, "angle": 112 }                                               // only when subscribed; on change
{ "type": "light", "t": 1234.5, "value": 0.42 }                                            // only when subscribed; 0..1 normalized
{ "type": "tap", "t": 1234.5, "zone": "right-grille", "confidence": 0.93, "x": 0.91, "y": 0.2, "strength": 0.6 }  // every accepted tap
{ "type": "rejected", "t": 1234.5, "reason": "typing" }        // reason: typing | trackpad | motion | low_confidence | burst | paused
{ "type": "gesture", "t": 1234.5, "gesture": "double", "zone": "right-grille", "zones": ["right-grille"], "modifiers": ["shift"], "confidence": 0.91, "app": "com.microsoft.Excel" }
{ "type": "action", "t": 1234.5, "bindingId": "b1", "label": "Volume up", "ok": true, "error": null }
{ "type": "calibration", "phase": "capturing", "zone": "left-palm", "count": 7, "target": 20 }
{ "type": "calibration", "phase": "negatives", "secondsLeft": 42 }
{ "type": "calibration", "phase": "done", "accuracy": { "left-palm": 0.97 }, "overall": 0.95, "confusion": [[...]], "labels": ["..."] }
{ "type": "config", "config": { /* full config, see below */ } }
{ "type": "error", "message": "..." }
```

## App to daemon

```jsonc
{ "type": "subscribe", "streams": ["imu", "lid", "light", "taps"] }
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
      "label": "Volume up" }
  ],
  "settings": { "sensitivity": 0.5, "typingGateMs": 450, "doubleWindowMs": 350, "minConfidence": 0.8, "hud": true, "haptics": false }
}
```

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
| `system` | `op`: `lock`, `sleep-display`, `screenshot`, `screenshot-area`, `dnd-toggle`, `mission-control`, `launchpad`, `show-desktop` | built-in macOS commands, never anything that needs admin rights |

Samples and models live in `~/Library/Application Support/Ghostkeys/model/`.
