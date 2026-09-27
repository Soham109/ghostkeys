# Release check

Run on 2026-09-27, on this Mac (Mac17,8, Apple M5 Pro), with the real Ghostkeys app and daemon running the whole
time. Nothing here touched them: every daemon was my own build (`daemon/.build-release-qa`), started with
`--simulate-sensors --no-hardware-sessions --dry-run`, a temp `--config-dir` and a port in 47961 to 47965. No mic,
camera, speaker or real action was used.

The daemon's sonar code (Sessions/, App/Daemon.swift, PilotTones.swift) was being edited by another agent during this
run. Results for those areas describe the code as it was at that moment.

## Verdict

Not ready to ship as is. The Mac daemon, app and website pass every check that can run here. Three things block a
release:

1. Raycast "Bind a Preset" and "Apply Layout" always fail (SDK bug 1 below).
2. The SDK silently drops sonar gestures, feedback replies, diagnostics replies and several calibration results
   (SDK bug 2). The CLI and Raycast use the SDK, so they inherit this.
3. The Windows daemon no longer matches PROTOCOL.md (2 failing tests).

## Checks

| # | check | result | numbers / notes |
| --- | --- | --- | --- |
| 1 | `daemon/scripts/run-tests.sh` (all 4 suites) | FAIL (timing only) | 1st run: 238 of 238 passed. Rerun on newer source: 240 tests (Acoustics 64, Vision 44, Integrations 55, Detection 77), 1 fails: `sonarFieldSixtySecondsUnderHalfASecond` took 0.55 to 0.59 s against a 0.5 s budget in debug, 3 of 3 runs, machine load average 48 to 86. Passes with `--release`. See bug 7. `allScriptsCompile` is off unless `GHOSTKEYS_COMPILE_SCRIPTS=1` |
| 2 | `swift build` debug: `ghostkeysd`, `ghostkeys-lab`, all targets | PASS | 0 warnings |
| 3 | `swift build -c release`, all targets | PASS (2nd try) | 1st try failed only because `SoundSession.swift` was saved mid-build by the sonar agent. 2 warnings (`weakSelf` never mutated, `Server/WebSocketServer.swift:63`) |
| 4 | `tests/e2e` pytest against my build, simulated sensors | PASS | 105 passed, 0 failed, 4 skipped (Finder not frontmost; real-sensor restore; no light sensor; no lid sensor in simulation). Needed harness fixes, see below |
| 5 | e2e soak (60 s, imu + taps streams) | PASS | RSS 25.9 MB to 26.2 MB (+288 KB), CPU avg 1.8 %, max 7.6 % |
| 6 | e2e 200 rapid requests | PASS | latency p50 11.3 ms, p95 20.2 ms, max 21.2 ms; imu stream 62 Hz |
| 7 | `packages/composer` typecheck, test, build | PASS | 121 tests |
| 8 | `packages/sdk` typecheck, test, build | PASS | 77 tests (but see SDK bugs: the tests don't cover the missing messages) |
| 9 | `packages/cli` typecheck, test, build | PASS | 76 tests |
| 10 | `packages/raycast` typecheck | PASS after fix | was failing: stale types (see fixes) |
| 11 | `packages/raycast` test | FAIL | 13 of 14 pass. The failure is real: SDK bug 1 |
| 12 | `packages/raycast` build (`ray build`) | PASS after fix | was failing on the same type errors |
| 13 | `packages/raycast` lint (`ray lint`) | FAIL | `author: "sohamaggarwal"` is not a Raycast Store account (404). Blocks Store submission only. ESLint/Prettier not installed, so formatting is not checked |
| 14 | `presets/validate.mjs` | PASS | all layouts and presets valid |
| 15 | `app` typecheck | PASS | node, web and scripts configs |
| 16 | `app` lint | PASS | 0 problems |
| 17 | `app` build (electron-vite) | PASS | renderer bundle 1.12 MB + 0.93 MB JS. `build:mac` and `selftest:real` not run, as instructed |
| 18 | `web` build | PASS | 21 static pages |
| 19 | `web` typecheck | PASS | |
| 20 | `web` check (console errors) | PASS | 12 page/theme combinations clean |
| 21 | `web` check-hero | PASS | 24 viewport/scroll cases ok |
| 22 | `web` check-snap | PASS | 14 snap steps ok, sheet opens |
| 23 | `web` check-fallback | PASS | no-WebGL and tier-0 fallbacks: 7 stills, no console issues |
| 24 | `windows` cargo test | FAIL | 98 of 100 pass. `protocol_doc`: 2 fail (Windows bug below). Note: plain `cargo test` stops at the first failing binary and skips `server_e2e`; use `--no-fail-fast` |
| 25 | `windows` cargo check `x86_64-pc-windows-msvc` | PASS | |
| 26 | `windows` cargo check `x86_64-pc-windows-gnu` | PASS | |
| 27 | SDK scenario (`tests/e2e/sdk_scenario.mjs`) | 28 of 29 PASS | the one failure is SDK bug 1, reproduced 3 of 3 runs. Steps below |

### SDK scenario steps (simulated daemon, driven through `@ghostkeys/sdk`)

| step | result |
| --- | --- |
| wrong token rejected; correct token connects, `hello` valid | PASS |
| `config_get` (8 zones, 2 bindings on a fresh config) | PASS |
| calibration: start, 6 live sim taps in each of 3 zones, finish | PASS (overall 0.33; synthetic taps are identical, so the recommendation drops or merges everything, as README says) |
| `calibration_apply_recommendation` | PASS (`recommendation_applied` received) |
| `calibration_apply_merge` | PASS (`merge_applied`, bindings moved to the merged zone) |
| create tap, double and sequence bindings with `config_set` + `ifRevision`; on-disk config matches | PASS |
| `sim_tap` fires the tap binding (dry-run action ok) | PASS |
| two live sim taps fire a double binding through the gesture grammar | PASS (needed retries, see bug 5) |
| sequence binding firing | NOT TESTABLE in simulation: `sim_tap` bypasses the grammar and live synthetic taps all land in one zone |
| `feedback_missed` after a sim spike | PASS (diagnostic `.gkrec` written inside the config dir) |
| feedback limiter (second within 2 s refused) | PASS |
| `feedback_false` after a sim tap | PASS (retrained) |
| shell action without approval refused; approve; run with `approvedHash`; changed command refused; `sudo` refused even approved; revoke | PASS (all 5) |
| sound session start/stop (simulated) | PASS |
| air session start/stop + `sim_air` (simulated) | PASS |
| sonar refused while `settings.sonar.enabled` is false | PASS |
| sonar session start/stop + `sim_sonar` (simulated) | PASS (stop reason is `turned_off`, see bug 6) |
| pause blocks actions; resume | PASS |
| rate limiter: 6 test actions in under 1 s from 3 clients auto-pauses (`pausedReason: rate_limit`); resume | PASS |
| `diagnostics_export` (8001 samples, 10 s); second within 5 s refused | PASS |
| config round trip get, set, get keeps the same revision | PASS |
| `setConfig(ifRevision)` right after `connect()` on a new connection | FAIL (bug 1) |
| daemon exits 0 on SIGTERM | PASS |

## Fixes made (test and build tooling only)

- `tests/e2e/harness.py`: the suite defaulted to port 47823, the app's own daemon port, and started daemons without
  `--simulate-sensors`. With the app running, every test would have skipped or the daemon would have exited on the
  sensor lock. Now: `GHOSTKEYS_E2E_PORT` (default 47891, 47823 refused), `GHOSTKEYS_E2E_SCRATCH` (build dir),
  simulated sensors by default, `GHOSTKEYS_E2E_REAL_SENSORS=1` for hardware runs.
- `tests/e2e/test_lifecycle.py`: the two "restored sensor driver settings" checks and the SIGKILL recovery test only
  run with real sensors (in simulation there is nothing to restore).
- `tests/e2e/README.md`: how to run the suite and the new variables.
- `tests/e2e/sdk_scenario.mjs`: new, the SDK scenario above, rerunnable.
- `packages/raycast/test/fake-daemon.ts`: the fake daemon's `hello`, `status` and settings were an old protocol
  version, so the SDK rejected its `hello` and 6 of 14 tests timed out.
- `packages/raycast/src/lib/format.ts`: gesture label table was missing the 17 sound and camera gestures, which broke
  `tsc` and `ray build`.

## Bugs found

1. **SDK: `setConfig` with `ifRevision` fails on a fresh connection.** Owner: `packages/sdk` (`src/client.ts`).
   `connect()` resolves on `hello`, before the greeting `config` arrives, so `lastConfigRevision` is still empty and
   `setConfig(..., { ifRevision })` throws `ConfigConflictError ... current revision <none>`. Raycast "Bind a Preset"
   (`src/bind-preset.tsx:107`) and "Apply Layout" (`src/apply-layout.tsx:94`) do exactly this, so both always fail.
   Repro: `node tests/e2e/sdk_scenario.mjs` (step "fresh connection"), or `npm test` in `packages/raycast`. Likely
   fix: `connect()` also waits for the greeting config.
2. **SDK: protocol schemas are behind the daemon.** Owner: `packages/sdk` (`src/protocol/schemas.ts`, `types.ts`).
   Frames are validated and anything unknown is dropped as a `protocolError`:
   - no schema at all for `feedback`, `diagnostics`, `candidate`;
   - calibration phases `recommendation_applied` and `merge_applied` missing;
   - `session.kind` allows only `sound | air`, so every `sonar` session frame is dropped;
   - `gesture.source` allows `imu | sound | camera`, so every sonar gesture (`source: "sonar"`) is dropped;
   - `z.object` strips unknown keys: `rejected` loses `zone`, `confidence`, `strength`; calibration `done` loses
     `recommendation` and `peaks`.
   Repro: the scenario's last step lists the dropped types. CLI and Raycast use the SDK.
3. **Windows daemon out of step with PROTOCOL.md.** Owner: `windows/ghostkeysd-win` (`src/protocol.rs`). Missing:
   `calibration_apply_recommendation`, `calibration_apply_merge`, `feedback_missed`, `feedback_false`,
   `diagnostics_export`, `sonar_session_start/stop` (and replies `feedback`, `diagnostics`); `rejected` lacks `zone`,
   `confidence`, `strength`. The app gets "unknown message type" for these on Windows. Repro:
   `cd windows && cargo test --test protocol_doc`. Some may be deliberately Mac only; if so the doc test needs a
   skip list, otherwise they need porting.
4. **Raycast Store metadata.** Owner: `packages/raycast/package.json`. `author` must be a real Raycast account;
   `ray lint` fails. Needs Soham's Raycast username.
5. **Simulated daemon still reads real keyboard/trackpad activity.** Owner: daemon (typing/trackpad gate input under
   `--simulate-sensors`). Live `sim_spike` taps are rejected with `reason: trackpad` whenever someone uses the Mac,
   so automated tests are flaky on a machine in use. Suggest: `--simulate-sensors` also fakes idle input, or a flag
   for it. The scenario retries as a workaround.
6. **Sonar behaviour not in PROTOCOL.md** (in-flight area, reported not changed). Owner: sonar work
   (`Sessions/SessionCoordinator.swift`). Sonar is now a continuous setting: `sonar_session_stop` turns the setting
   off and the stop frame says `reason: "turned_off"`, which is not in the documented reason list; sonar `session`
   frames also carry undocumented `continuous` and `enabled`. PROTOCOL.md still describes sonar as a timed session
   of up to 120 s.
7. **New sonar performance test is too tight for debug builds** (in-flight area, reported not changed). Owner: sonar
   work (`Tests/GhostkeysAcousticsTests/InfrastructureTests.swift:120`). `sonarFieldSixtySecondsUnderHalfASecond`
   expects 60 s of audio processed in under 0.5 s; debug builds take 0.55 to 0.59 s on this busy machine, so
   `run-tests.sh` (debug by default) fails. With `--release` it passes. Suggest a looser debug budget or running
   perf tests only in release.
8. **Minor:** 2 compiler warnings in release (`weakSelf` should be `let`, `Server/WebSocketServer.swift:63`).

## Not verifiable here (needs hardware or a person)

- Real taps: detection accuracy, zone classification, calibration quality, typing and trackpad gates with real input.
- Sensor rates and restore after crash (`ghostkeysd --selftest`, `GHOSTKEYS_E2E_REAL_SENSORS=1`); needs the app's
  daemon stopped. Lid angle and ambient light streams.
- Microphone sessions: knuckle vs fingertip, rubs, waves; sonar tones on the built-in speakers (level, route checks,
  that nobody nearby is bothered).
- Camera sessions: hand tracking, pinch knobs, Desk View.
- Actions actually executing (everything ran in dry-run): keystrokes, volume, window moves, integrations with Excel
  and browsers, Accessibility and Automation permission prompts.
- The packaged Mac app (`build:mac`, signing, notarisation, first-launch flow) and `selftest:real`.
- The Windows daemon on real Windows hardware (only compiled for Windows here).
- Raycast extension inside Raycast itself; the website on real phones.
