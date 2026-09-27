# ghostkeysd-win

The Windows version of the Ghostkeys daemon. It speaks the same WebSocket protocol as the Swift daemon (`docs/PROTOCOL.md`), so the same Electron app drives it without knowing which one it talks to.

Status: compiles for Windows (`x86_64-pc-windows-msvc` and `x86_64-pc-windows-gnu`), and everything that is not a Windows API call is tested on macOS (102 tests). It has **not yet run on Windows hardware**. The "Not validated yet" list at the end says what must be checked on a real machine.

## What Windows laptops can sense

| hardware | where it exists | what Ghostkeys does with it |
| --- | --- | --- |
| Accelerometer (motion sensor) | 2-in-1s and Surface devices. Most clamshell laptops have none. | Knock counting (tap, double, triple, rhythm) and tilt gestures |
| Inclinometer (tilt angle sensor) | Same devices, usually | Tilt gestures when there is no accelerometer |
| Ambient light sensor | Some laptops; optional | `cover` and `cover_hold` |
| Microphone | Nearly all | Sound mode: knocks heard through the mic (opt-in) |
| Webcam | Nearly all | Reported in `hello` only; the camera add-on is not ported yet |
| Lid angle | Never exposed to apps (only the lid switch) | Nothing: `lid_nudge` is Mac only |

The accelerometer is the big difference. On a Mac the daemon reads its motion sensor about 800 times a second and a classifier learns where on the case a tap landed. On Windows, `Windows.Devices.Sensors.Accelerometer` lets the driver decide the report interval (the time between readings), shared between all apps. Typical minimums are 16 ms (about 60 readings a second) or slower, and drivers often smooth the signal. A firm knock still shows up clearly, but there is too little detail to tell zones apart. So Windows counts knocks without locating them: every knock lands in one pseudo zone called `anywhere`, and the normal gesture grammar turns them into `tap`, `double`, `triple` and `rhythm`.

## Architecture

```
Electron app ──WebSocket 127.0.0.1:47823──> server.rs ──> core.rs (one task, no locks)
                                               ^               │
             sensor callbacks, mic thread ─────┘               ├─> detection/ (knock, sound, tilt, light, grammar)
                                                               ├─> bindings.rs (which binding fires)
                                                               └─> actions.rs (one worker thread) ──> ActionRunner
```

Everything above the platform line is plain Rust and runs on any OS. The platform line is five traits in `src/platform/mod.rs`:

| trait | Windows implementation (`src/platform/windows/`) | mock (`src/platform/mock.rs`) |
| --- | --- | --- |
| `MotionSource` | `Accelerometer`, `Gyrometer`, `Inclinometer` from Windows.Devices.Sensors (WinRT, works in desktop apps) | reports chosen hardware, tests push readings |
| `LightSource` | `LightSensor` (lux, normalized to 0..1 on the Mac's log scale) | same |
| `AudioSource` | WASAPI shared-mode capture of the default microphone, event driven, 20 ms buffer | tests push samples |
| `InputActivity` | `GetLastInputInfo` (typing gate), `GetAsyncKeyState` (held modifiers), `GetForegroundWindow` + process image name (front app) | settable idle time, modifiers, app |
| `ActionRunner` | `SendInput`, `IAudioEndpointVolume`, `ShellExecuteW`, `SetWindowPos`, Excel over COM `IDispatch`, WMI for brightness | records every call |

`core.rs` has no I/O: messages and sensor readings go in, protocol messages come out. That is what lets the whole daemon, including the WebSocket server, be tested on a Mac. Off Windows, `ghostkeysd-win` runs with an empty mock platform (every sensor reported absent, actions only logged), which is handy for pointing the Electron app at it during development.

Source map:

| file | what it holds |
| --- | --- |
| `protocol.rs` | every message type in PROTOCOL.md, as serde enums tagged by `"type"` |
| `config.rs`, `store.rs` | the config schema (lenient, unknown keys kept) and `%APPDATA%\Ghostkeys\config.json` |
| `security.rs` | session token, approvals (`approved.json`), action rate limits; ports of the Swift files |
| `safety.rs` | refusals for the `shell` action |
| `detection/grammar.rs` | line-for-line port of GestureGrammar.swift |
| `detection/light.rs`, `detection/tilt.rs` | ports of LightGestureDetector.swift and TiltDetector.swift |
| `detection/knock.rs` | accelerometer knocks at Windows sensor rates |
| `detection/sound.rs` | microphone knock detector |
| `excel.rs` | the Excel commands as text transforms, plus the `catalog` reply |
| `keys.rs`, `window_math.rs` | key names to virtual-key codes, window snapping geometry |

## Feature matrix, Mac vs Windows

| feature | Mac | Windows |
| --- | --- | --- |
| Tap zones and calibration | yes | no: no zone classifier at 60 Hz. `calibration_*` messages get an error |
| Knock count (tap, double, triple, rhythm) | yes | yes, with an accelerometer or in sound mode, zone `anywhere` |
| `sequence` (two zones) | yes | no (one zone) |
| Tilt left / right | yes | yes, with an accelerometer or inclinometer |
| `lid_nudge` | yes | no: Windows has no lid angle |
| `cover`, `cover_hold` | yes | yes, with a light sensor |
| Sound mode | tap type (knuckle / fingertip / nail), rubs, sonar waves | knocks heard by the mic; tap type later; no rubs or waves yet |
| Camera add-on | yes | no (camera presence is reported) |
| Typing gate | keyboard and trackpad separately | one gate for keyboard and mouse (`GetLastInputInfo` cannot tell them apart) |
| Actions: keystroke, text, clipboard | yes | yes |
| volume, mute | yes | yes (`IAudioEndpointVolume` on the default output) |
| media keys | yes | yes (media virtual keys) |
| brightness | yes | best effort through WMI on the built-in panel; external monitors not supported |
| open | yes | yes (`ShellExecuteW`, `~` and `%VARS%` expanded) |
| shell | `zsh -lc`, 10 s | `cmd.exe /D /S /C`, 10 s, whole process tree killed on timeout |
| applescript, shortcut | yes | refused as unsupported |
| macro | yes | yes (same limits: 50 steps, 30 s, no nesting) |
| window snapping | Accessibility API | `SetWindowPos` on the front window, invisible borders corrected, per-monitor DPI aware |
| app: hide, quit, switch | yes | minimize, WM_CLOSE (the app can still ask to save), Alt+Tab, Alt+Shift+Tab |
| system ops | 8 ops | lock, sleep-display, screenshot (Win+PrtScn), screenshot-area (Win+Shift+S), mission-control (Task View), launchpad (Start), show-desktop. `dnd-toggle` refused: no public API |
| integrations | many apps | Excel only: wrap-iferror, unwrap-iferror, toggle-absolute, cycle-number-format, run-macro. The rest of the Mac's Excel commands are listed as unsupported in `catalog` |

Windows reuses the Mac's names for modifiers so a config moves between machines: `control` is Ctrl, `option` is Alt, `command` is Ctrl when a binding presses it (Cmd+C on a Mac is Ctrl+C on Windows) and the Windows key when it is read as a held modifier. `win` / `meta` press the Windows key. `fn` is invisible to software and ignored.

App ids: bindings match the lowercased exe name of the front window's process (`excel.exe`, also `excel`). Common Mac bundle ids (`com.microsoft.Excel`, `com.google.Chrome`, ...) map to their Windows exe, so a Mac config keeps working.

## Protocol notes for Windows

Everything in PROTOCOL.md is accepted, and a test reads PROTOCOL.md itself and round-trips every example, so a new message in the doc without a Windows counterpart fails the build's tests. What differs:

- `hello.sensors`: `imu` means an accelerometer exists, `lid` is always false, `sound` / `camera` mean the hardware exists (checked without opening it). Windows adds `inclinometer`. `permissions.accessibility` is always true (Windows has no such gate); `microphone` / `camera` come from Settings > Privacy & security (`authorized` or `denied`; desktop apps never see a prompt).
- `status.calibrated` means "knocks can be detected right now" (there is nothing to calibrate), and `zones` is `["anywhere"]` then. `detector` carries the knock detector's noise floor, threshold and level in milli-g.
- `tap.source` is `imu` for accelerometer knocks and `sound` for microphone knocks. `x` and `y` are 0.5 (unknown).
- Sound sessions follow the Mac: `sound_session_start` opens the mic for `seconds` (default `settings.sound.sessionSeconds`, 30; at most 120), a `session` message goes out on start, every 5 s, and on stop with a `reason`. Pausing ends the session. Windows adds one opt-in key, `settings.sound.alwaysOn: true`, which keeps the mic open for knocks without a session. It exists for clamshell laptops with no accelerometer, where the mic is the only knock sensor. Windows shows its microphone-in-use icon the whole time.
- `air_session_start` and `calibration_taptype_start` answer with a failure (`session` with `reason: "error"`, `calibration` with `phase: "taptype_failed"`).
- `request_permission` answers with `hello` (nothing to prompt for).
- Zone-model features answer clearly instead of pretending: `calibration_apply_recommendation`, `calibration_apply_merge` and `diagnostics_export` reply with an `error`; `feedback_missed` / `feedback_false` reply with `feedback`, `retrained: false`, `reason: "not calibrated yet"` (same rate limit as the Mac: one every 2 s, 20 per minute).
- Sonar is Mac only. Every client gets a `session` message with `kind: "sonar"`, `active: false` and `enabled` (the setting). `sonar_session_start` answers with a sonar `session` carrying `reason: "error"`; `sonar_session_stop` turns `settings.sonar.enabled` off (saved, config broadcast), as on the Mac.
- `rejected` for a knock dropped by the typing gate or pause carries `zone: "anywhere"` and `confidence: 1`; motion and burst rejections carry neither. No rejection carries `strength` (the Windows detectors do not measure the peak in milli-g). The `debug` stream is accepted but no `candidate` messages are sent yet.
- `settings.followUpConfidence` and `settings.lightTouch` are read and saved with the Mac's defaults (0.5, false) but change nothing on Windows: every knock has confidence 1 and the knock detector has its own floor. `settings.sound` / `camera` / `sonar` and any other keys are kept as written.

## Security

Same rules as the Mac daemon, ported from its Swift sources:

- Bound to 127.0.0.1 only.
- A handshake with any `Origin` header is refused (browser pages always send one; the app does not).
- A handshake needs `X-Ghostkeys-Token`. On every launch the daemon writes 32 random bytes, hex encoded, to `%APPDATA%\Ghostkeys\token`, and also accepts `GHOSTKEYS_TOKEN` from its environment when it is at least 32 characters. `%APPDATA%` is readable only by the user, SYSTEM and administrators, the Windows equivalent of the Mac's mode 0600 file.
- At most 8 clients, 200 messages per second per client, 1 MB per message, 2 `test_action` per second per client. A client that stops reading first loses stream frames, then is dropped at 1 MB queued.
- `shell` and `open` run only with an `approvedHash` that the daemon issued through `approve_action` and still lists in `%APPDATA%\Ghostkeys\approved.json` (SHA-256 over the action without `approvedHash`, `label`, `delayMs`, keys sorted).
- Even approved, `shell` refuses: `sudo`, `runas`, `Start-Process -Verb RunAs`, `reg delete`, `format X:`, `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`, `diskpart`, `bcdedit`, `vssadmin delete`, `wmic shadowcopy delete`, `cipher /w`, `del /s`, `erase /s`, `rd /s`, `rmdir /s`, `rm -rf` in any spelling, and `Remove-Item -Recurse` (or its aliases) on a system path: a drive root, Windows, Program Files, ProgramData, the Users folder or a whole profile, or the environment variables that point at them. The check ignores `^` and backtick escapes and looks inside quoted `powershell -c "..."` strings. It is a guard rail; approval is the real control.
- Actions run one at a time (at most 8 waiting); gesture actions older than 1 s are dropped; per-binding cooldowns and a global 5 per second / 60 per minute limit that pauses the daemon when tripped.
- Nothing else on disk is written: `config.json`, `token`, `approved.json`, all in `%APPDATA%\Ghostkeys\`. No system setting is changed. Sensor report intervals are per app and end with the process, so a crash leaves nothing to restore (`--restore-sensors` is accepted and does nothing).

## Building on Windows

1. Install Rust with rustup (https://rustup.rs), which on Windows defaults to the MSVC toolchain.
2. Install "Build Tools for Visual Studio" with the "Desktop development with C++" workload (it brings the linker and the Windows SDK).
3. Build and test:

```bat
cd windows
cargo build --release
cargo test
target\release\ghostkeysd-win.exe --selftest
```

`--selftest` prints which sensors exist and how fast they report over 3 seconds. Other flags: `--port N`, `--parent-pid PID`, `--verbose`, `--dry-run` (log actions instead of running them).

From a Mac you can only type-check for Windows (linking needs the Windows SDK):

```sh
rustup target add x86_64-pc-windows-msvc
cd windows && cargo check --target x86_64-pc-windows-msvc --all-targets && cargo test
```

## How the Electron app will start it

The app already starts the Mac daemon as a child process (`app/src/main/daemon.ts`) with `--port <port> --parent-pid <app pid>` and the session token in `GHOSTKEYS_TOKEN`. `ghostkeysd-win.exe` takes the same arguments and environment, exits when the app's process ends, and prints logs to stderr for the app to forward. What the app needs on Windows:

1. Binary path. `candidates()` in `app/src/main/daemon.ts` lists only the Swift build. For `process.platform === 'win32'` it should look for `../windows/target/release/ghostkeysd-win.exe` and `../windows/target/debug/ghostkeysd-win.exe` (in a packaged app, the copy shipped under `resources`). Until then, `GHOSTKEYSD_PATH` pointing at the exe works.
2. External token. `externalToken()` in `app/src/main/index.ts` reads `~/Library/Application Support/Ghostkeys/token`. On Windows the file is `%APPDATA%\Ghostkeys\token`. This only matters when the daemon was started outside the app; a daemon the app spawns accepts `GHOSTKEYS_TOKEN`.
3. Stopping. `child.kill('SIGTERM')` becomes `TerminateProcess` on Windows. That is fine: the daemon holds no state that needs restoring. The app's crash recovery runs `--restore-sensors`, which exits 0 at once.
4. Packaging. Add `windows/target/release/ghostkeysd-win.exe` to `extraResources` in `app/electron-builder.yml` under a `win` target.
5. UI. On Windows the zone editor and calibration screens do not apply; the app can show one "anywhere" zone when `hello.device.family` is `other` and `hello.sensors.lid` is false, and use `hello.sensors` to hide gestures the machine cannot make.

## Tests

`cargo test` runs on any OS:

- `tests/protocol_doc.rs`: every JSON example in `docs/PROTOCOL.md` (read from the file) parses and serializes back unchanged; the config and zone examples load.
- `tests/config.rs`: defaults written on first run, save and load, lenient decoding, unknown keys kept, a Mac-written config, a corrupt file kept aside as `config.json.bad`.
- `tests/core_flow.rs`: knocks to `double` to the default volume binding; typing gate and pause; sound sessions (start, knocks, timeout, pause, no mic); light cover to a binding; approvals and requester-only replies; test-action and global rate limits; config validation; stream subscriptions.
- `tests/server_e2e.rs`: a real WebSocket on 127.0.0.1: token and Origin rules, greeting, actions, config, the flood cut-off, the 8-client limit.
- Unit tests: the gesture grammar port, light and tilt ports, knock and sound detectors on synthetic signals, binding resolution, shell refusals, key mapping, window geometry, Excel transforms, token, approvals, limiter, options.

## Not validated yet

These need a Windows machine, ideally a Surface or another 2-in-1 plus a clamshell:

- Knock thresholds against real accelerometer drivers (rates, smoothing, and noise differ by vendor). `status.detector` and `--selftest` show what a device delivers.
- The accelerometer axis convention for tilt on devices whose sensor sits in the base rather than the screen.
- Sound-mode thresholds against real laptop microphones and fan noise, and how often keyboard clicks slip past the typing gate.
- Excel automation: `GetActiveObject` only finds an Excel that has registered itself, which a freshly started Excel does only after it has lost focus once.
- Brightness through WMI on panels from different vendors.
- SendInput into elevated windows fails by design (UIPI, Windows' rule that a normal app cannot drive an administrator app); the error says so.
- Our own SendInput counts as input for `GetLastInputInfo`, so right after a keystroke action the typing gate is briefly closed.
