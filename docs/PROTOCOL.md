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
- The daemon writes only inside its config directory (see "Config paths"). Nothing else on disk is written.
- No network except the loopback WebSocket.

## Config paths

The daemon keeps every file it owns in one directory:

- Default: `~/Library/Application Support/Ghostkeys/daemon/` (mode 0700). The parent
  `~/Library/Application Support/Ghostkeys/` is the Electron app's own profile (`userData`); the daemon never writes there.
- Override: `--config-dir <path>`, else the environment variable `GHOSTKEYS_CONFIG_DIR`. The lab tool follows the same
  rule for its lock.
- Contents: `config.json` (+ `config.json.bak`, `config.json.bad`), `migrations.json` (one-time config migrations
  already applied), `token`, `approved.json`, `diagnostics/`, and
  `model/` (`zone-model.json`, `calibration-report.json`, `samples.json`, `confirmed.json`, `raw/*.gkrec`, `tap-types.json`, `tap-type-samples.json`,
  `*.bak`).
- Machine-wide, always in the default directory whatever `--config-dir` says (the sensors belong to the machine, not
  to a config): `daemon.lock` (one daemon or lab session on the sensors at a time) and `spu-originals.json` (sensor
  settings to restore after a crash), and `mic.active` (the pid of a daemon whose microphone session is open;
  `ghostkeys-lab sonar-bench` refuses to run while it names a live process). A daemon started with `--simulate-sensors` (test mode: synthetic motion data,
  no hardware) takes no sensor lock; it only locks its own config directory.
- Migration: with the default location, on first start a newer daemon moves exactly those entries (only those names)
  from `~/Library/Application Support/Ghostkeys/` into `daemon/`. `token` and `daemon.lock` are recreated rather than
  moved, an entry that already exists in `daemon/` is left in place, and the daemon refuses to start (exit 4) while an
  older daemon still holds the old `daemon.lock`.

## Authentication

The daemon only accepts WebSocket handshakes from the app, never from a browser page.

- Token: on every launch the daemon generates 32 random bytes, hex encoded (64 characters), and writes them to
  `<config dir>/token` (default `~/Library/Application Support/Ghostkeys/daemon/token`) with mode 0600, replacing the
  previous one. If the parent passes
  `GHOSTKEYS_TOKEN` in the daemon's environment (at least 32 characters), that value is accepted too.
- Handshake: the client must send the header `X-Ghostkeys-Token: <token>`. A missing or wrong token is rejected.
- Any handshake that carries an `Origin` header is rejected (browsers always send one; the app must not).
- Each connection's upgrade request is checked on its own (the daemon implements the WebSocket handshake and
  framing itself), so simultaneous connections never wait for each other. A connection must send its first bytes within
  0.5 s and a complete request (at most 8 KB of headers) within 2 s, else it is closed (408 / 431). Unauthenticated
  connections never count against authenticated ones: at most 64 may wait, and when full the one idle longest is
  closed. Rejections: 400 (no or wrong token, `Origin` present, not a WebSocket upgrade), 503 (already 8 clients).
- Numbers in messages are clamped to their documented ranges (for example `calibration_negatives.seconds` 1 to 600,
  `calibration_start.target` 1 to 500, `calibration_doubles.count` 1 to 50, volume steps -100 to 100); a number that is
  not finite is refused with an `error`.
- Messages: at most 1 MB (close 1009) and at most 64 levels of JSON nesting (objects and arrays together; deeper
  messages are refused with an `error` before parsing). Each refused deep message counts heavily toward the rate
  limit, and the third one closes the connection (1008). Invalid JSON just gets an `error` reply.
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
{ "id": "right-grille", "name": "Right grille", "surface": "base", "rect": { "x": 0.88, "y": 0.08, "w": 0.1, "h": 0.45 }, "color": "#7C5CFF", "enabled": true }
```

`enabled` (default true): a disabled zone is left out of the zone model (its calibration samples stay on disk and come
back when it is re-enabled) and never fires bindings. Changing it with `config_set` retrains the model from the saved
samples.

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

Optional stereo sonar (GhostkeysAcoustics SonarField, while `settings.sonar.enabled` is on: two inaudible tones,
19.5 kHz left and 20.25 kHz right, -30 dBFS combined, built-in speakers only). Discrete gestures carry `side` ("left" | "right") and
`distanceMm` where meaningful, and `source: "sonar"`:

| gesture | zone | meaning |
| --- | --- | --- |
| `push` / `pull` | `air` | quick hand motion down toward / up away from a speaker; `side` says which |
| `sweep_left` / `sweep_right` | `air` | hand passed across above the keyboard, right to left / left to right |
| `finger_slide_left` / `_right` / `_up` / `_down` | the grille on that side (`left-grille` / `right-grille`), none if the Mac has no grilles | a finger slid while touching (confirmed by friction sound); up = toward the hinge |

Continuous sonar values arrive as `air` messages (below): `hover_level` (a hand raised or lowered above one speaker;
`value` = displacement / 150 mm, -1...1, positive = raised; `displacementMm` since `began`) and `finger_slide`
(`dxMm` positive right, `dyMm` positive toward the hinge, `value` = dyMm / 40 mm). An `ended` with `cancelled: true`
was abandoned (typing, interference, contact). The daemon holds sonar detection off for 0.45 s after every keystroke
(the typing gate) and while the laptop itself is moving (the motion gate: the low-passed gravity direction turning by
more than 3 degrees within 0.5 s for 150 ms), plus 0.3 s after. Resting wrists and a soft lap do not pause it; knocks
and clicks are handled inside SonarField.

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
  "detector": { "noiseFloorMg": 1.2, "thresholdMg": 17.5, "level": 3.1, "unfamiliar": false } }   // pausedReason: "user" | "rate_limit" | null
{ "type": "imu", "t": 1234.5, "a": [0.01, -0.02, -0.99], "g": [0.1, 0.0, -0.2] }      // only when subscribed; ~60 Hz decimated
{ "type": "lid", "t": 1234.5, "angle": 112 }                                               // only when subscribed; on change
{ "type": "light", "t": 1234.5, "value": 0.42 }                                            // only when subscribed; 0..1 normalized
{ "type": "tap", "t": 1234.5, "zone": "right-grille", "confidence": 0.93, "x": 0.91, "y": 0.2, "strength": 0.6, "source": "imu" }  // every accepted tap
  // "taps" stream. source: "imu" (motion sensor) or "camera" (desk mode touch confirmed by an IMU tap).
  // tapType: "fingertip" | "knuckle" | "nail", only while a sound session with a tap-type model runs (the message may
  // then arrive up to 150 ms late, while the sound is classified).
{ "type": "air", "t": 1234.5, "gesture": "pinch_hold", "phase": "changed", "hand": "right", "x": 0.5, "y": 0.4, "dx": 0.0, "dy": -0.004, "confidence": 0.9 }
  // "air" stream: continuous camera gestures (pinch_hold with dx/dy, two_hand_zoom with scale, point with x/y) and
  // sonar ones (hover_level with side/value/displacementMm, finger_slide with dxMm/dyMm/value; source "sonar");
  // phase: began | changed | ended. Discrete camera gestures arrive as "gesture" messages with zone "air" plus hand/x/y.
{ "type": "session", "kind": "sound", "active": true, "secondsLeft": 30, "trigger": "request", "sonar": false, "tapTypes": true }
  // kind: "sound" | "sonar" | "air". Sent on start, stop, every 5 s while active, and to each new client on connect.
  // "sonar" is not a timed session: it is the microphone session with SonarField on (stereo tones), and it runs for
  // as long as settings.sonar.enabled is true (continuous: true, secondsLeft 0, trigger "setting"). It also does
  // everything "sound" does. There is one microphone session at a time: turning sonar on restarts a running sound
  // session in sonar mode; a sound_session_start while sonar is on starts nothing and replies kind "sound", active
  // false, reason "sonar_on", coveredBy "sonar"; a sound_session_stop leaves sonar running.
  // sonar also carries: enabled (the setting); waiting ("paused" | "asleep" | "display_asleep" | "lid_closed": enabled
  // but held, mic closed, tones off; it resumes by itself); sonarField (the tones are playing); tonesOff (active, but
  // why the tones are off, for example "output is headphones": they come back by themselves on the built-in
  // speakers). sonar stop reasons: "turned_off" | "paused" | "asleep" | "display_asleep" | "lid_closed" | "error".
  // trigger (active only): "request" (app asked) | "auto" (pinned app in settings) | "setting" (sonar). reason (on
  // stop): "timeout" | "requested" | "paused" | "app_changed" | "no_hand" | "lid_closed" | "error" (then "error": "...").
  // sound only: sonar (pilot tone playing), tapTypes (tap-type model loaded). simulated: true under --no-hardware-sessions.
{ "type": "rejected", "t": 1234.5, "reason": "typing", "zone": "right-grille", "confidence": 0.62, "strength": 1.4 }
  // "taps" stream. reason: typing | trackpad | motion | low_confidence | burst | paused. zone / confidence: the
  // classifier's best guess for the dropped tap (only when calibrated); strength: log10 of the peak in milli-g.
  // A motion rejection has no features, so no zone / confidence / strength.
{ "type": "candidate", "t": 1234.5, "zone": "right-grille", "confidence": 0.62, "strength": 1.4, "outcome": "typing" }
  // "debug" stream: every tap onset the detector analysed, before the typing / trackpad / burst gates.
  // outcome: "accepted" | a rejection reason | "pending" (calibrating or paused). zone is null until calibrated.
{ "type": "feedback", "kind": "missed", "zone": "right-palm", "found": true, "retrained": true, "diagnostic": "<path>.gkrec",
  "candidate": { "t": 1234.5, "zone": "right-palm", "confidence": 0.7, "probability": 0.62, "strength": 1.2, "droppedBecause": "low_confidence" },
  "candidates": [ { "t": 1233.9, "strength": 1.1, "skipped": "trackpad or mouse activity within 150 ms" }, { "t": 1234.5, "strength": 1.2, "probability": 0.62 } ],
  "counts": { "right-palm": 21, "none": 30 }, "overall": 0.94 }
{ "type": "feedback", "kind": "false", "zone": "left-grille", "t": 1234.5, "retrained": true, "counts": { }, "overall": 0.95 }
  // replies to feedback_missed / feedback_false, only to the requester. retrained false comes with "reason"
  // (not calibrated yet, zone not calibrated, no onset found, no recent tap).
{ "type": "adaptation", "kept": true, "confirmed": 14, "accuracyBefore": 0.93, "accuracyAfter": 0.94 }
  // learn-from-use retrain result (see "Feedback loop"); kept false comes with "reason" (confirmed taps discarded)
{ "type": "diagnostics", "path": "<config dir>/diagnostics/20260926-181500-123.gkrec", "samples": 7970, "seconds": 10 }
{ "type": "gesture", "t": 1234.5, "gesture": "double", "zone": "right-grille", "zones": ["right-grille"], "modifiers": ["shift"], "confidence": 0.91, "app": "com.microsoft.Excel", "bound": true }
  // bound: an enabled binding matched and fires (false while calibrating, for disabled zones, or when nothing is bound).
  // The HUD shows only bound gestures; the Sensors screen shows all (or the HUD shows all behind a testing toggle).
{ "type": "detection_state", "unfamiliar": true }
  // sent when it changes: taps no longer look like the calibration (other posture, surface...); only clear taps fire
  // until they look familiar again. Also in status.detector.unfamiliar.
{ "type": "action", "t": 1234.5, "bindingId": "b1", "label": "Volume up", "ok": true, "error": null }
{ "type": "calibration", "phase": "capturing", "zone": "left-palm", "count": 7, "target": 20 }
{ "type": "calibration", "phase": "negatives", "secondsLeft": 42 }
{ "type": "calibration", "phase": "failed", "reason": "the new calibration could not be saved (permission denied); the previous model is still in use" }
  // "done" also carries "recalibrated": the zones this session captured. Recalibrating some zones replaces only their
  // samples; every other zone keeps its calibration (and what learn-from-use confirmed for it).
  // calibration_finish when the model could not be saved (read-only folder, full disk): nothing changes
{ "type": "calibration", "phase": "done", "accuracy": { "left-palm": 0.97 }, "overall": 0.95, "confusion": [[...]], "labels": ["..."],
  "peaks": { "left-palm": { "p10": 0.021, "p50": 0.048, "p90": 0.11 } },
  "recommendation": { "keep": ["left-palm"], "drop": { "lid": "recognised 56% of the time (needs 80%)" },
                      "merge": [["left-grille", "left-edge"]], "expectedAccuracy": { "left-palm": 0.97 } } }
  // peaks (also in "done"): { "left-palm": { "p10": 0.021, "p50": 0.048, "p90": 0.11 } }: per zone, the 10th / 50th /
  // 90th percentile of the calibration taps' peak acceleration in g (how hard this user taps there; the gentlest
  // zone's p10 sets the learned onset floor). Empty object for a model trained before this existed.
  // recommendation: zones to keep, zones to disable (with a plain reason), pairs that are mostly confused with each
  // other (bind the same action to both instead of dropping), expected accuracy of the kept zones.
{ "type": "calibration", "phase": "recommendation_applied", "disabled": ["lid"], "keep": ["left-palm"],
  "mergeSuggested": [["left-grille", "left-edge"]], "overall": 0.97, "accuracy": { }, "labels": ["..."] }
  // reply to calibration_apply_recommendation (a config message is sent too). Weak zones that are part of a merge
  // pair are NOT disabled; they stay listed in mergeSuggested for calibration_apply_merge.
{ "type": "calibration", "phase": "merge_applied", "zone": "speaker-grilles", "name": "Speaker grilles",
  "merged": ["right-grille", "left-grille"], "samples": 18,
  "bindingsChanged": [ { "id": "b1", "label": "Volume up", "gesture": "double", "from": "right-grille", "to": "speaker-grilles" } ],
  "conflicts": [["b1", "b2"]], "overall": 0.95, "accuracy": { }, "labels": ["..."], "note": "..." }
  // reply to calibration_apply_merge. conflicts: enabled bindings that became identical (same gesture, zone,
  // modifiers and app); only the first fires, so the app should ask the user to change or remove the others.
  // note: present when the two zones were on different surfaces (the merged zone keeps the first one's surface).
{ "type": "calibration", "phase": "doubles", "zone": "right-grille", "count": 3, "target": 8, "lastGapMs": 240 }
{ "type": "calibration", "phase": "doubles_done", "zone": "right-grille", "gapsMs": [231, 240, ...], "doubleWindowMs": 330 }
  // settings.doubleWindowMs becomes the 90th percentile of the user's gaps + 80 ms (250...500), and a config
  // message follows. Both taps of each pair become training samples.
  // During zone and doubles capture, a candidate with a key press or release or any pointer event within 150 ms
  // before or after it is not used: the progress message carries "dropped": "key or pointer event within 150 ms".
  // Every sample in model/samples.json records its posture, strength and kind (single, double1, double2, negative).
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
{ "type": "subscribe", "streams": ["imu", "lid", "light", "taps", "air", "debug"] }
{ "type": "unsubscribe", "streams": ["imu"] }
{ "type": "pause" }  { "type": "resume" }
{ "type": "calibration_start", "zones": ["left-palm", "right-palm"], "target": 20, "posture": "desk" }  // posture: desk | lap | stand
{ "type": "calibration_zone", "zone": "left-palm", "strength": "soft" }  // following taps are labeled with this zone; strength soft | firm (optional)
{ "type": "calibration_doubles", "zone": "right-grille", "count": 8 }     // the user double-taps in their own rhythm, `count` times
{ "type": "calibration_negatives", "seconds": 45 }          // user types/uses the trackpad; everything is labeled none
{ "type": "calibration_finish" }                             // train, save, reply with calibration done
  // the run replaces the saved samples of the zones it captured (and of none, if it captured negatives); saved
  // samples of every other zone still in the config are kept, so redoing some zones never erases the rest
{ "type": "calibration_cancel" }
{ "type": "calibration_apply_recommendation" }  // disable the recommended drops (except merge-pair zones), retrain
{ "type": "calibration_apply_merge", "zones": ["right-grille", "left-grille"], "name": "Speaker grilles" }
  // two confused zones become one: new id from the name (unique), rect = union of both, enabled; both zones' saved
  // samples are relabeled to it and the model is retrained; bindings on either zone now use the merged zone
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
{ "type": "sonar_session_start" }                            // optional: sonar starts by itself when settings.sonar.enabled turns on;
                                                             // this retries at once, or replies a session error saying why not (off, waiting, mic denied)
{ "type": "sonar_session_stop" }                             // turns settings.sonar.enabled off (saved, config broadcast)
{ "type": "calibration_taptype_start", "types": ["fingertip", "knuckle", "nail"], "target": 15 }
  // needs an active sound session (extended to 120 s); taps are labeled in the order of `types`, target 3...50
{ "type": "calibration_taptype_cancel" }
{ "type": "feedback_missed", "zone": "right-palm" }  // "I just tapped this zone and nothing happened"
{ "type": "feedback_false" }                           // "the last accepted tap was not meant" (nothing is undone)
{ "type": "diagnostics_export" }                       // write the last 10 s to <config dir>/diagnostics/*.gkrec
  // Feedback: at most one every 2 s and 20 per minute. Export: at most one every 5 s. See "Feedback loop".
// Test-only, accepted only when the daemon runs with --no-hardware-sessions (simulated sessions):
// { "type": "sim_tap", "zone": "right-grille" }  { "type": "sim_tap_type", "tapType": "knuckle" }
// { "type": "sim_air", "phase": "began|changed|ended", "dx": 0.05, "dy": 0 }
// { "type": "sim_slow_retrain", "seconds": 2 } (the next zone-change retrain waits before installing: race tests)
// { "type": "sim_input_event", "ago": 0.2 } (a pointer event 0.2 s ago, written into the diagnostics buffer)
// { "type": "sim_undo" } (stands in for Cmd+Z)  { "type": "sim_adapt" } (runs the learn-from-use retrain without the 60 s idle wait)
// { "type": "sim_sonar", "gesture": "push", "side": "left" }  { "type": "sim_sonar", "air": { "gesture": "hover_level", "phase": "changed", "displacementMm": 40 } }
```

## Feedback loop

The daemon keeps the last 10 s of raw motion samples (with key / mouse idle times and modifiers) and of detector
decisions in memory only. Nothing is written to disk unless the app asks.

- `feedback_missed {zone}`: the last 5 s are saved as `diagnostics/missed-<zone>-<time>.gkrec` and replayed offline
  with the typing / trackpad / burst gates off. A wrong feedback sample hurts accuracy, so at most one candidate is
  learned, and only if it passes every check; otherwise nothing is added (the diagnostic is still saved):
  - it happened 0.7 to 5 s before the request (the last 0.7 s is the hand moving to send the report);
  - it was not accepted live, and there was no trackpad / mouse activity within 150 ms of it;
  - its peak is at least half this user's gentle tap in that zone (the zone's calibrated p10), or 1.5x the onset floor
    when the model has no peak data;
  - the classifier does not give another zone 0.8 or more, and the claimed zone is among its top 2.
  The best passing candidate (highest probability for the zone) is added to `model/samples.json` as that zone and the
  model is retrained. `feedback_missed` never adds `none` samples. Only calibrated zones can gain samples. The reply's
  `candidates` lists every onset considered, with `skipped` (the reason) or `probability`.
- `feedback_false`: the last accepted tap (within 60 s) is added as `none` and the model is retrained, but only if the
  tap was weaker than this user's typical tap in that zone (below the zone's calibrated p50). A tap at least that
  strong was most likely intended: the report is accepted and logged, nothing is learned, and the reply says so
  (`retrained: false`, `peakG`). The action the tap triggered is never undone.
- Every retrain keeps the previous `zone-model.json`, `calibration-report.json` and `samples.json` as `*.bak`.
- Learn from use (`settings.learnFromUse`, default false; an existing config that had the old default of true is
  switched off once, logged, and recorded in `migrations.json`, after which the user's own choice sticks): a tap is
  confirmed when it fired a bound action that succeeded, its confidence was at least `minConfidence`, the detector did
  not find taps unfamiliar at the time, the tap was within 1.5x the model's typical distance, and nothing undid it
  within 5 s (no `feedback_missed` /
  `feedback_false`, no Cmd+Z in the frontmost app). Taps at 0.97 confidence or more teach little, so only 1 in 3 of them
  is kept. Confirmed taps go to `model/confirmed.json` (samples.json entries plus `"source": "confirmed"` and `ts`),
  at most 20 per zone and at most half that zone's calibration samples (the oldest is replaced); never `none`.
  Once 10 new confirmations exist and no tap came for 60 s, the model is retrained from calibration + confirmed samples.
  Ship guard (deterministic): confirmed taps that disagree with their calibration neighbours (fewer than 3 of the 5
  nearest calibration samples share the label, or the nearest same-label one is over twice that label's typical
  nearest-neighbour distance) are removed first; then a model trained on calibration + every other remaining
  confirmed tap must label the calibration samples and the held-out confirmed taps at least as well as the current
  model (within 0.02). Otherwise nothing is installed, the confirmed set is discarded, and an `adaptation` message
  (`kept`, `confirmed`, `rejected`, `accuracyBefore/After`, `heldOutBefore/After`, `reason`) says so.
  Undo: Cmd+Z (the key press, not the time it is held) cancels only the pending taps of the latest gesture;
  `feedback_false` cancels the pending taps of the gesture of the tap it is about; `feedback_missed` cancels nothing.
  Feedback refused by its rate limit has no effect at all.
- Retrains never overwrite newer ones: every retrain (calibration, feedback, zone changes, merges, learn from use)
  takes a generation number, and a result finishing after a newer one was installed is discarded (logged). The one
  exception is a calibration: it always ends with `done` (or `failed`), because the retrains that started while it
  trained were built from the samples it replaces. Those are not installed: a zone change retrains again from the new
  samples, feedback replies `retrained: false` (send it again), learn from use waits. While a calibration trains,
  `calibration_start` and `calibration_apply_merge` are refused with an `error`. A new calibration discards the
  confirmed taps of the zones it recalibrated. Cmd+Z is noticed by polling the key state (Command + Z, ANSI layout),
  which needs no extra permission.
- Raw calibration windows: during calibration capture, 0.1 s before to 0.25 s after each captured tap (zones and
  negatives) is kept and written at the end of the session to `model/raw/<session>.gkrec` (lab format, one segment
  per tap), for future model work. The folder is capped at 20 MB (oldest recordings dropped).
- `diagnostics_export`: the last 10 s go to `diagnostics/<time>.gkrec`, the ghostkeys-lab recording format
  (`ghostkeys-lab info|replay <file>`), with the detector's decisions in the header's `notes`. The folder keeps the
  newest 50 recordings.

## Config file (`<config dir>/config.json`, default `~/Library/Application Support/Ghostkeys/daemon/config.json`)

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
  "settings": { "sensitivity": 0.5, "typingGateMs": 450, "doubleWindowMs": 350, "minConfidence": 0.8, "followUpConfidence": 0.5, "lightTouch": false, "learnFromUse": false,
    "hud": true, "haptics": false,
    "sound":  { "enabled": false, "sessionSeconds": 30, "autoApps": [] },
    "camera": { "enabled": false, "sessionSeconds": 30, "autoApps": [], "deskMode": false },
    "sonar":  { "enabled": false, "sessionSeconds": 30, "autoApps": [] } }
}
```

- `slider` (only on `hover_level` / `finger_slide` bindings, zone `air` for hover): `{ "mode": "absolute" |
  "relative", "stepMm": 20, "inverse": { action } }`. While the gesture lasts, `action` runs once per `stepMm` of travel
  up (hover: hand raised; finger slide: toward the hinge) and `inverse` once per step down. `relative`: every step of
  movement counts, like a knob. `absolute`: the output follows the position since the gesture began, so moving back to
  the start undoes the steps, and a gesture that ends `cancelled` is undone. The start of the gesture fires nothing.
  Steps go through the same limits as `knob` steps (dropped, never auto-pausing). Example: hover above a speaker to
  change the volume smoothly: `"action": { "kind": "volume", "step": 2 }, "slider": { "mode": "absolute", "stepMm": 20,
  "inverse": { "kind": "volume", "step": -2 } }`.
- `settings.sonar`: an on/off switch. The tones never play unless `enabled` is true. While it is true, sonar runs
  continuously (microphone open, so the orange dot stays on) until it is turned off: there is no time limit, and
  `sessionSeconds` and `autoApps` are ignored. The daemon starts it when the setting turns on (config_set) and at
  launch, renews the tones every second (each renewal re-checks that the output is the built-in speakers), and stops
  the tones at once, resuming by itself when the condition ends, on: output switched to headphones, Bluetooth or any
  external or unknown device (tones off, mic stays open, retried every 10 s); system or display sleep, lid closed,
  Ghostkeys paused (mic closed too); daemon exit. A refused start waits a 10 s cooldown; renewals never do.
  Pets and some people can hear 19 to 20 kHz; say so in the UI.
- `learnFromUse` (default false): refine the zone model from taps that fired an action and were not undone (see
  "Feedback loop").
- `lightTouch` (default false): lets much lighter taps (8 to 40 mg) trigger, with an onset floor learned from
  calibration. It also lets in more junk spikes, so only turn it on after a calibration done with light taps.
- `followUpConfidence` (0 to `minConfidence`): in a zone with a double / triple binding, a tap at this confidence may
  complete a multi-tap whose other tap passed `minConfidence`; alone it never fires. Set equal to `minConfidence` to disable.
- Typing gate: a tap is rejected as `typing` within `typingGateMs` of a key press, and also within 150 ms of any key
  release (so the release of a key held longer than the gate cannot slip through).
- Pointer gate: a tap is rejected as `trackpad` right after any pointer event: moves, drags, every button down and up,
  scroll, and the trackpad's gesture, swipe, magnify, rotate and force-click events.
- Tilt gestures are detected only while an enabled `tilt_left` / `tilt_right` binding exists.
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

Samples and models live in `<config dir>/model/`.
