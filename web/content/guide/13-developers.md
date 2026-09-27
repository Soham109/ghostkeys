---
title: For developers
description: The WebSocket protocol, the SDK, CLI, Raycast extension, and the Windows port.
order: 13
---

Ghostkeys is several independent pieces: a Swift daemon (`ghostkeysd`) that reads sensors and runs actions on macOS, a Rust daemon (`ghostkeysd-win`) that does the same on Windows, an Electron app that gives you a UI over either one, a Next.js marketing site, and a growing set of tools built on top of the daemon's protocol: an SDK, a command-line tool, and a Raycast extension. This page is for anyone who wants to talk to a daemon directly, or use one of those tools instead.

## The WebSocket protocol

The daemon serves a WebSocket at `ws://127.0.0.1:47823/`, bound to your own machine only. Every message is a single JSON object per text frame, and every message has a `type` field. Timestamps (`t`) are milliseconds since the daemon started.

The full, authoritative contract, kept in lockstep with the daemon's actual code, lives in `docs/PROTOCOL.md` in the repository. In short, the daemon sends things like:

- `hello`: version, device model, which sensors are present (including microphone and camera), current permission state.
- `status`: paused state, whether a model is calibrated, current zone list, live sensor rate.
- `imu` / `lid` / `light`: raw sensor streams, only once you subscribe to them.
- `tap` / `rejected` / `gesture`: every accepted tap, every rejected candidate (with a reason), and every completed gesture, including the sonar and camera ones.
- `air`: continuous values from the camera (`pinch_hold`, `two_hand_zoom`, `point`) and from sonar (`hover_level`, `finger_slide`).
- `session`: when a sound, sonar, or camera session starts, is renewed, or stops, and why.
- `action`: the result of running a binding's action.
- `calibration`: progress and results while a calibration session, including tap-type calibration, is running.
- `candidate` / `feedback` / `diagnostics`: a debug stream of every tap onset considered, and the replies to "I just tapped and nothing happened" / "that wasn't me" reports.
- `config`: the full saved configuration.

And you can send it things like:

- `subscribe` / `unsubscribe`: to the `imu`, `lid`, `light`, `taps`, `air`, or `debug` streams.
- `pause` / `resume`.
- `calibration_start`, `calibration_zone`, `calibration_negatives`, `calibration_finish`, `calibration_cancel`, `calibration_apply_recommendation`, `calibration_apply_merge`, `calibration_taptype_start`, `calibration_taptype_cancel`.
- `config_get` / `config_set`.
- `test_action`: run an action immediately, without a bound gesture, useful for testing a binding you're building.
- `request_permission`: ask the daemon to trigger the Accessibility prompt.
- `sound_session_start` / `sound_session_stop`, `sonar_session_start` / `sonar_session_stop`, `air_session_start` / `air_session_stop`: open or close a microphone or camera session.
- `feedback_missed` / `feedback_false`, `diagnostics_export`: the feedback loop described in `docs/PROTOCOL.md`.

Config itself (zones, bindings, settings, including `settings.sound`, `settings.camera`, and `settings.sonar`) is also just JSON, saved at `~/Library/Application Support/Ghostkeys/daemon/config.json`; `docs/PROTOCOL.md` documents its exact shape, and the full table of action kinds and their fields.

If you're building something that talks to Ghostkeys today, that file is the source of truth to work from directly; connect to the port above and read and write the messages it describes. Or use the SDK below, which already does this for you.

## SDK, CLI, and Raycast extension

Three tools in this repository sit on top of the protocol so you don't have to hand-roll the WebSocket connection yourself. All three are real, tested packages, not placeholders.

- **`@ghostkeys/sdk`** (`packages/sdk`): a TypeScript client, `GhostkeysClient`. It gives you a typed event for every message in `docs/PROTOCOL.md`, validated with zod, so a frame that doesn't match the protocol becomes a `protocolError` event instead of a crash. It auto-reconnects with backoff, re-subscribing to whatever streams you asked for, and has promise-based helpers for the request/reply flows: `pause()`, `resume()`, `getConfig()` / `setConfig()` (with an `ifRevision` guard against overwriting someone else's concurrent change), `testAction()`, `requestAccessibility()`, and a `startCalibration()` helper that drives the whole calibration state machine and hands you back a `CalibrationFlow`.
- **`@ghostkeys/cli`** (`packages/cli`): a terminal client, `gk`, built on the SDK. `gk status`, `gk watch` (a live colored stream of taps and gestures), `gk zones list` / `add` / `rm`, `gk bind "<gesture> [zone] [+modifiers] [@app]" <action>` and `gk unbind`, `gk bindings`, `gk export` / `gk import`, `gk pause` / `gk resume`, an interactive `gk calibrate` wizard, `gk presets search`, and `gk doctor` for checking daemon reachability, sensors, permissions, and model files.
- **Ghostkeys for Raycast** (`packages/raycast`): a Raycast extension, also built on the SDK, with commands to check status, pause or resume detection, search and edit bindings (with a dry-test that only previews an action and never runs it), bind a preset, watch gestures live, and apply a zone layout.

Two SDK bugs found while writing the Raycast extension's tests (a stray timer after a failed connection, and `getConfig()` matching the greeting config instead of its own reply) are fixed, with regression tests in `packages/sdk/test/`.

## The Windows port

`windows/` holds `ghostkeysd-win`, a Rust rewrite of the daemon that speaks the exact same protocol, so the same Electron app, SDK, CLI, and Raycast extension can talk to it without knowing which one is on the other end. It compiles for Windows (`x86_64-pc-windows-msvc` and `x86_64-pc-windows-gnu`) and its test suite, over 100 tests including one that round-trips every JSON example in `docs/PROTOCOL.md`, passes today, but it has not yet been run on real Windows hardware.

What's different on Windows, mainly because most Windows laptops' accelerometers report far less often and less precisely than a Mac's motion sensor:

- No per-zone tap classifier: every knock lands in one pseudo-zone called `anywhere`, but `tap`, `double`, `triple`, and `rhythm` still work.
- Tilt gestures work with an accelerometer or, failing that, an inclinometer. `lid_nudge` and `sequence` (two zones) don't exist, since Windows has no lid-angle sensor and only the one zone.
- Sound mode currently means knocks heard through the microphone; tap type, rubs, and sonar haven't been ported yet.
- The camera add-on hasn't been ported: `hello` reports whether a webcam exists, and nothing more.
- Most actions work the same (keystroke, volume, media keys, window snapping, open, shell, macro), with a Windows-specific integration set for Excel and a mapped set of system operations.

Build it from `windows/`:

```sh
cargo build --release
cargo test
target/release/ghostkeysd-win.exe --selftest
```

From a Mac, you can type-check the Windows target and run the platform-independent test suite without linking:

```sh
rustup target add x86_64-pc-windows-msvc
cd windows && cargo check --target x86_64-pc-windows-msvc --all-targets && cargo test
```

## Other things worth knowing

- `ghostkeysd` takes a few flags useful for development: `--port N` (default 47823), `--verbose` (debug logging), `--dry-run` (logs the actions it would run instead of running them), `--dump-imu SECONDS` (prints raw motion samples as CSV), `--selftest` (a one-shot sensor check that exits 0 or 1; see [Troubleshooting](10-troubleshooting.md)), `--config-dir PATH` (use a different config directory), `--simulate-sensors` (synthetic motion data, no real sensor hardware touched), and `--no-hardware-sessions` (simulate sound and camera sessions, state and timers only, without ever opening the microphone or camera).
- The detection logic (feature extraction, the per-zone classifier, the gesture grammar) lives in a dependency-free Swift module, `GhostkeysDetection`, and is unit tested on its own, independent of any real hardware.
- Sound mode and sonar (`GhostkeysAcoustics`) and the camera add-on (`GhostkeysVision`) are both wired into `ghostkeysd`'s session handling, not placeholders. Their detection logic is tested against synthetic audio and synthetic hand movement; the code paths that actually open a real microphone or camera have not yet been exercised against real hardware. See [Sound mode](07-sound-mode.md) and [Camera add-on](08-camera-add-on.md), including `ghostkeys-lab sonar-bench`, the one tool that plays real inaudible tones and records the real microphone, gated on typed consent.
- App integrations (`GhostkeysIntegrations`, the `integration` action kind) are wired into the action runner too, for apps like Excel, Chrome, Safari, and Finder.
- `ghostkeys-lab`, a separate command-line tool built alongside the daemon, records real sensor sessions and replays them against the detector to measure accuracy (`record`, `replay`, `info`, `export`, `live`, `synth`), and includes `sonar-bench` for the real-hardware sonar check mentioned above.
