# ghostkeysd end-to-end tests

Black-box tests that talk to a real `ghostkeysd` over its WebSocket (see `docs/PROTOCOL.md`).

## Running the daemon for tests without touching the Mac

The daemon has flags made for exactly this. Use them instead of sharing the user's live setup:

| flag | effect |
| --- | --- |
| `--simulate-sensors` | Synthetic resting-laptop motion at 800 Hz. No sensor hardware is opened or written, and the machine-wide sensor lock is **not** taken, so tests can run while the real app (and its daemon) is running. Light and lid report nothing. |
| `--config-dir <path>` | Every file the daemon owns for its config (config.json, token, approved.json, model/, diagnostics/) goes here. Use a fresh temp dir per test session instead of backing up `~/Library/Application Support/Ghostkeys/daemon/`. Same as `GHOSTKEYS_CONFIG_DIR`. |
| `--port <n>` | Use a spare port; 47823 belongs to the app's daemon. |
| `--dry-run` | Actions are validated (including approvals and refusals) and logged, never executed. |
| `--no-hardware-sessions` | Sound (mic) and air (camera) sessions are simulated: state and timers only. Also enables the test-only messages below. |

Recommended command line:

```sh
daemon/.build/debug/ghostkeysd --simulate-sensors --no-hardware-sessions --dry-run \
    --config-dir "$(mktemp -d)" --port 47890
```

Read the handshake token from `<config dir>/token`, or pass your own with `GHOSTKEYS_TOKEN` (at least 32 characters).

Without `--simulate-sensors` the daemon opens the real motion sensor and takes the machine-wide lock
(`~/Library/Application Support/Ghostkeys/daemon/daemon.lock`); it exits with code 4 while another daemon (for
example the app's) or a `ghostkeys-lab` session holds it. `--config-dir` does not change that: the sensors belong to
the machine, not to a config.

## Test-only messages (only with `--no-hardware-sessions`)

| message | stands in for |
| --- | --- |
| `{ "type": "sim_spike", "live": true }` | a physical tap: with `--simulate-sensors` a tap-like transient goes through the live detector (candidates, taps, rejections, calibration capture). Without `live`, it is only added to the 10 s diagnostics buffer (for `feedback_missed`). |
| `{ "type": "sim_tap", "zone": "right-grille" }` | an accepted IMU tap and its `tap` gesture (bindings, limiter, knuckle hold) |
| `{ "type": "sim_tap_type", "tapType": "knuckle" }` | the sound classifier's verdict for the last held tap |
| `{ "type": "sim_air", "phase": "began", "dx": 0.05, "dy": 0 }` | a `pinch_hold` event from the camera (knob bindings) |
| `{ "type": "sim_sonar", "gesture": "push", "side": "left" }` | a SonarField gesture (needs a running `sonar` session, which needs `settings.sonar.enabled`) |
| `{ "type": "sim_sonar", "air": { "gesture": "hover_level", "phase": "changed", "displacementMm": 40 } }` | a continuous sonar value (slider bindings) |

With these, a full zone calibration (`calibration_start`, `calibration_zone`, a few `sim_spike` with `live: true`,
`calibration_finish`), recommendations, merges and the feedback loop can all be exercised without anyone touching
the laptop. Synthetic taps are identical to each other, so a calibration built from them recommends dropping or
merging every zone; that is expected.

Real hardware checks that remain manual: sensor rates (`ghostkeysd --selftest`, needs the sensor lock), lid and
light streams, and real taps.
