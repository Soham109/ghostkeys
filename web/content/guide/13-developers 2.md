---
title: For developers
description: The WebSocket protocol overview, and where the SDK and CLI are headed.
order: 13
---

Ghostkeys is three independent pieces: a Swift daemon (`ghostkeysd`) that reads sensors and runs actions, an Electron app that gives you a UI over it, and a Next.js marketing site. This page is for anyone who wants to talk to the daemon directly.

## The WebSocket protocol

The daemon serves a WebSocket at `ws://127.0.0.1:47823/`, bound to your own machine only. Every message is a single JSON object per text frame, and every message has a `type` field. Timestamps (`t`) are milliseconds since the daemon started.

The full, authoritative contract, kept in lockstep with the daemon's actual code, lives in `docs/PROTOCOL.md` in the repository. In short, the daemon sends things like:

- `hello`: version, device model, which sensors are present, current permission state.
- `status`: paused state, whether a model is calibrated, current zone list, live sensor rate.
- `imu` / `lid` / `light`: raw sensor streams, only once you subscribe to them.
- `tap` / `rejected` / `gesture`: every accepted tap, every rejected candidate (with a reason), and every completed gesture.
- `action`: the result of running a binding's action.
- `calibration`: progress and results while a calibration session is running.
- `config`: the full saved configuration.

And you can send it things like:

- `subscribe` / `unsubscribe`: to the `imu`, `lid`, `light`, or `taps` streams.
- `pause` / `resume`.
- `calibration_start`, `calibration_zone`, `calibration_negatives`, `calibration_finish`, `calibration_cancel`.
- `config_get` / `config_set`.
- `test_action`: run an action immediately, without a bound gesture, useful for testing a binding you're building.
- `request_permission`: ask the daemon to trigger the Accessibility prompt.

Config itself (zones, bindings, settings) is also just JSON, saved at `~/Library/Application Support/Ghostkeys/config.json`; `docs/PROTOCOL.md` documents its exact shape, and the full table of action kinds and their fields.

If you're building something that talks to Ghostkeys today, that file is the source of truth to work from directly; connect to the port above and read and write the messages it describes.

## SDK and CLI

An SDK and a command-line tool are planned, at `packages/sdk` and `packages/cli` respectively, to save you from hand-rolling the WebSocket connection and message types yourself. Neither exists yet: today, talking to Ghostkeys programmatically means opening the WebSocket directly and following `docs/PROTOCOL.md`. Watch those two paths in the repository for when they land.

## Other things worth knowing

- `ghostkeysd` takes a few flags useful for development: `--port N` (default 47823), `--verbose` (debug logging), `--dry-run` (logs the actions it would run instead of running them), `--dump-imu SECONDS` (prints raw motion samples as CSV), and `--selftest` (a quick, one-shot sensor check that exits 0 or 1; see [Troubleshooting](10-troubleshooting.md)).
- The detection logic (feature extraction, the per-zone classifier, the gesture grammar) lives in a dependency-free Swift module, `GhostkeysDetection`, and is unit tested on its own, independent of any real hardware.
- App integrations (`GhostkeysIntegrations`) and sound mode (`GhostkeysAcoustics`) are still placeholders in the codebase; the camera add-on (`GhostkeysVision`) has real, tested hand-tracking logic but isn't wired into a released daemon build yet. See [Sound mode](07-sound-mode.md) and [Camera add-on](08-camera-add-on.md).
- A recording and replay tool, `ghostkeys-lab`, is planned for capturing real sensor sessions and replaying them against the detector, useful for evaluating changes without a live Mac in hand. It's an early stub today.
