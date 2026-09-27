# CLAUDE.md: Ghostkeys project constitution

Read this first in every session. It holds the things that rarely change. Current status lives in
[PROGRESS.md](PROGRESS.md); the reasons behind choices live in [DECISIONS.md](DECISIONS.md).

## Keeping these files current (standing instruction)

- **Update this file** in the same change whenever the architecture, a module's job, a build/test command, a
  permission, or a project-wide rule changes. If something here turns out to be wrong, fix it here immediately.
- **Update PROGRESS.md at the end of every work session** (and whenever a task finishes or gets blocked): move
  items between Done / In Progress / Next Step, and leave enough detail in In Progress to resume cold.
- **Add a dated entry to DECISIONS.md** whenever a non-obvious technical or design choice is made (why this,
  not the alternative). Newest entries at the top.
- Only mark something "Done" after it was actually run or tested. Otherwise write "unverified" and say why.
- Do this without being asked.

## What it is

Ghostkeys turns blank parts of an Apple silicon MacBook's case (palm rests, speaker grilles, the strip above the
keyboard, edges, the lid) into shortcut "zones". **There is no touch or proximity sensing.** A tap on the aluminum
is felt by the built-in **accelerometer and gyroscope** (the motion sensor, ~800 Hz), and a per-user classifier
trained during calibration decides which zone was tapped. Taps become gestures (tap, double, triple, sequence,
rhythm), gestures are matched to bindings, and bindings run actions (keystrokes, volume, media keys, window ops,
Excel/Spotify/browser integrations, shell, macros). Lid angle and ambient light sensors add whole-laptop gestures
(lid nudge, cover). Microphone (sound mode, sonar) and camera add-ons exist but are optional and off by default.

Hackathon project, built 2026-09-26 by Soham Aggarwal (Soham109) in ~4 hours of commits, largely with AI agents.
It is far more than a skeleton: ~17k lines of Swift, ~13k lines of TypeScript app, plus SDK, CLI, Raycast, a Rust
Windows port, a Next.js website and a Remotion promo film. Demo target: finalist round, Sunday 2026-09-27,
1 to 3 PM (see [docs/pitch/live-demo.md](docs/pitch/live-demo.md)).

## Tech stack (and why, as far as it can be inferred)

| Layer | Tech | Why |
| --- | --- | --- |
| Daemon `ghostkeysd` | Swift 5.9+ SwiftPM, macOS 14+, **no third-party dependencies** | Needs IOKit/HID, CoreGraphics events, AppKit, Apple Events, AVFoundation, Vision; Swift is the native way in |
| Desktop app | Electron 44 + electron-vite, React 19, Tailwind 4, Radix, zustand, uPlot, `ws` | Fast UI iteration; the app is only a client of the daemon |
| Client tools | TypeScript SDK (`@ghostkeys/sdk`, zod-validated), `gk` CLI, Raycast extension | Everything speaks the same WebSocket protocol |
| Tests | swift-testing (Swift), pytest e2e over the WebSocket, vitest (sdk, cli, raycast), `node --test` (composer) | |
| Windows port | Rust (`windows/`) | Same protocol, no zone classifier |
| Website | Next.js (unusual version, read `web/AGENTS.md` first), static export | Marketing, guide |

## Architecture and data flow

```
Sensors (IOKit HID: AppleSPUHIDDevice)          InputMonitor (CGEventSource idle times, modifiers, frontmost app)
  accel+gyro ~800 Hz, lid angle, light                          |
        |  SensorHub (own thread/run loop)                      |
        v                                                       v
  Daemon.onIMU (core serial queue) --> TapEngine.ingest(sample, InputContext)      [GhostkeysDetection, pure Swift]
        OnsetDetector -> gates (typing 450 ms, trackpad, burst, motion, paused)
        -> FeatureExtractor (33 features, 20 ms before to 80 ms after onset)
        -> ZoneModelSet (one model per posture, picked by gravity + tap evidence) -> ZoneModel.classifyDetailed
           (kNN + LDA posterior averaged with logistic regression, Platt-calibrated confidence, "none" class,
           per-zone reject distance) -> FamiliarityGuard (strict mode when taps stop resembling the calibration)
        -> minConfidence 0.8 -> GestureGrammar (tap/double/triple/sequence/rhythm) + Tilt/Lid/Light detectors
        v
  Daemon.onGesture -> broadcast "gesture" -> skip if paused / calibrating / zone disabled
        -> BindingResolver.resolve (gesture + zone + exact modifier set + app; app-specific beats "*")
        -> ActionLimiter (per-binding cooldown, 5/s and 60/min trip = auto-pause)
        -> ActionRunner (serial queue, max 8 pending, dropped if >1 s stale)
              validate -> ApprovalStore.check (shell/applescript/shortcut/open need approvedHash) -> execute
              keystroke/media/text: CGEvent / NSEvent aux keys (needs Accessibility)
              volume/mute: AppleScript via osascript; shell: /bin/zsh -lc with 10 s timeout
              integration: GhostkeysIntegrations (fixed AppleScript handlers, args passed as Apple Event data)
        v
  WebSocketServer (127.0.0.1:47823, token header, Origin rejected) <--> Electron main (DaemonBridge) <--IPC--> renderer + HUD
```

- The Electron main process (`app/src/main/daemon.ts`, `DaemonSupervisor`) spawns the daemon with
  `--port --parent-pid` and `GHOSTKEYS_TOKEN`, restarts it after a crash (running `--restore-sensors` first, max
  3 restarts a minute), and SIGTERMs it on quit. The renderer never talks to the daemon directly; `bridge.ts` relays.
- **Calibration**: app sends `calibration_start`, then `calibration_zone` per zone (every candidate spike is labeled
  with that zone), then `calibration_negatives` (typing/trackpad for N s, labeled `none`), then `calibration_finish`.
  The daemon trains a `Trainer` off the core queue, saves `model/zone-model.json`, `samples.json`,
  `calibration-report.json`, and replies with per-zone accuracy, a confusion table and a keep/drop/merge
  recommendation (`calibration_apply_recommendation`, `calibration_apply_merge`).
- **Feedback loop**: `feedback_missed` / `feedback_false` look at recent candidates and retrain only on clear
  evidence, keeping `.bak` copies. `Feedback/UseLearner.swift` can also learn from confirmed taps
  (`settings.learnFromUse`, off by default).
- The contract between daemon and every client is **[docs/PROTOCOL.md](docs/PROTOCOL.md)** (messages, config
  shape, action kinds, auth, limits). Treat it as the source of truth.

## Key modules and files

**Daemon (`daemon/Sources/`)**
- `ghostkeysd/App/main.swift`: startup order (atexit restore, signal handlers, config dir, machine-wide lock,
  crash recovery, `--selftest`/`--dump-imu`/`--restore-sensors`, then `Daemon`).
- `ghostkeysd/App/Daemon.swift` (~1070 lines): the hub. Sensor callbacks, gesture to binding to action, every
  protocol message handler (`handle(_:from:)`), calibration, feedback, merge, snapshots (`hello`, `status`).
- `ghostkeysd/Sensors/SPUDriverControl.swift`: wakes the `AppleSPUHIDDriver` accel/gyro (sets `ReportInterval`
  1250 us, reporting/power state), saves originals to `spu-originals.json` **before** writing, restores on exit/crash.
- `ghostkeysd/Sensors/SensorHub.swift`: opens `AppleSPUHIDDevice`s, decodes reports (accel/gyro int32 LE / 65536),
  pairs accel+gyro, and has the `--simulate-sensors` synthetic source.
- `ghostkeysd/Sensors/InputMonitor.swift`: key/mouse idle times and modifiers via `CGEventSource` (never key contents).
- `ghostkeysd/App/TapLog.swift`: `--log-taps` terminal diagnostics. Daemon.onIMU pairs the live engine's events
  with the `shadow` engine's candidates (same onset time) to get each spike's zone guess.
- `ghostkeysd/App/BindingResolver.swift`, `App/ActionLimiter.swift`, `Actions/*` (ActionRunner, EventPoster,
  KeyCodes, WindowActions, ProcessRunner), `Security/*` (SessionToken, ApprovalStore + CommandFilter),
  `Server/WebSocketServer.swift`, `Config/*` (Config, ConfigStore, generated zone defaults),
  `Calibration/CalibrationSession.swift`, `Feedback/*`, `Sessions/*` (sound, sonar, camera session timers).
- `GhostkeysDetection/`: pure logic, no hardware. `API.swift` (public types: `IMUSample`, `InputContext`,
  `DetectionSettings`, `TapFeatures`, events), `Engine.swift` (`TapEngine`), `Onset/`, `Features/FeatureExtractor.swift`
  (feature index table in the header comment), `Classifier/` (`ZoneModel`, `Logistic`, `ZoneModelSet`,
  `FamiliarityGuard`, `Trainer`, `ZoneRecommendation`, `CalibrationMerge`), `Gestures/` (grammar, lid, light, tilt).
- Detection design history and measurements: `docs/review/DETECTION_AUDIT.md`, `DETECTION_ROUND2.md`,
  `DETECTION_ROUND3.md`, and `daemon/analysis/README.md`. `daemon/analysis/bench/run.sh --compare
  bench/results/<latest>.json` is the gate for any detection change (it needs data from `bench/fetch-data.sh`).
- `GhostkeysIntegrations/`: ~90 app commands (Excel formula tools, Chrome/Safari, Music/Spotify, Finder,
  PowerPoint/Keynote, Zoom). `Catalog/IntegrationCatalog.swift` lists them; `Scripts/Scripts.swift` holds the
  AppleScript; `Formula/` is unit-tested A1 formula logic. See its README for the full catalog.
- `GhostkeysAcoustics/` (sound mode, sonar), `GhostkeysVision/` (camera add-on): optional, simulation-tested only.
- `ghostkeys-lab/`: record labeled sensor sessions (`.gkrec`) and replay them through detection for accuracy.
- `daemon/analysis/`: Python + Swift harnesses used to tune detection; its README is the lab notebook with dates.

**App (`app/src/`)**
- `main/index.ts` (windows, tray, HUD, IPC, approvals dialog, prefs), `main/daemon.ts` (supervisor),
  `main/bridge.ts` (the only WebSocket client), `main/native.ts` (menus, app icons).
- `shared/protocol.ts` (TS mirror of PROTOCOL.md), `shared/zone-defaults.json` (**single source** of default zone
  geometry; the daemon embeds it via codegen), `shared/approval.ts`, `shared/actions.ts`.
- `renderer/src/screens/`: Onboarding, Live, Zones, Bindings, Calibration, Sensors, Settings, Guide.
  `renderer/src/lib/store.ts` (zustand), `lib/client.ts`. `renderer/src/hud/` is the confirmation overlay.
- `scripts/mock-daemon.ts`: fake daemon for `pnpm dev:mock`.

**Elsewhere**: `presets/` (242 presets, 6 layouts, `validate.mjs`), `packages/{sdk,cli,raycast,composer,promo}`,
`tests/e2e/` (pytest against a real daemon), `windows/` (Rust port), `web/` (site), `packaging/` (app bundle, DMG,
notarization notes), `docs/` (guide, audit, pitch, pricing).

## Hardware, OS APIs and permissions

- **Motion sensor**: private IOKit classes `AppleSPUHIDDriver` (settings) and `AppleSPUHIDDevice` (reports),
  matched by `PrimaryUsagePage/PrimaryUsage` (accel 0xFF00/3, gyro 0xFF00/9, light 0xFF00/4, lid 0x0020/138).
  Undocumented Apple internals: could change with a macOS update. Needs no root and no Input Monitoring.
- Works on M1 Pro/Max, M2 and later MacBooks. **Base M1 and Intel Macs have no motion stream** (light gestures only
  on base M1). Camera add-on needs M4/M5.
- **Accessibility** (`AXIsProcessTrusted`): required for synthesized keystrokes, media keys, text typing, window ops.
  Volume/mute go through AppleScript and work without it.
- **Automation (Apple Events)** per target app for integrations (Excel, Spotify, ...). Integrations never launch
  an app: the app must already be running.
- Microphone / camera: only inside timed sessions the user starts.
- Files: everything under `~/Library/Application Support/Ghostkeys/daemon/` (override `--config-dir` or
  `GHOSTKEYS_CONFIG_DIR`). `daemon.lock`, `spu-originals.json`, `mic.active` are machine-wide in the default dir.
  The Electron profile is `.../Ghostkeys/app/`.

## Build, run, test

```bash
# Daemon
cd daemon && swift build                         # .build/debug/ghostkeysd
.build/debug/ghostkeysd --selftest               # 3 s sensor check, exit 0/1
.build/debug/ghostkeysd --simulate-sensors --no-hardware-sessions --dry-run --config-dir "$(mktemp -d)" --port 47890
                                                 # safe sandbox: no hardware, no real actions
swift build --scratch-path .build-lab --product ghostkeys-lab   # record/replay tool

# App (spawns daemon/.build/{release,debug}/ghostkeysd itself)
cd app && pnpm install && pnpm dev               # real daemon
pnpm dev:taps                                    # real daemon with --log-taps (per-tap diagnosis in this terminal)
pnpm dev:mock                                    # fake daemon, UI work only
pnpm typecheck && pnpm lint
pnpm build:mac                                   # unsigned Ghostkeys.app in app/release/

# Tests
cd daemon && scripts/run-tests.sh --strict       # Swift tests (shim runner if no swift-testing; see gotchas)
cd tests/e2e && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/pytest   # quit the app first
pnpm --dir packages/sdk test ; pnpm --dir packages/cli test ; pnpm --dir packages/composer test
node presets/validate.mjs
cd windows && cargo test                         # also checks every PROTOCOL.md JSON example
daemon/scripts/gen-zone-defaults.sh [--check]    # after editing app/src/shared/zone-defaults.json
```

Useful daemon flags: `--verbose`, `--dry-run`, `--port N`, `--dump-imu SECONDS`, `--restore-sensors`, `--log-taps`
(one line per spike: too soft / REJECTED with reason / ACCEPTED with zone, confidence and runner-up, then each
GESTURE's outcome and ACTION result; implemented in `ghostkeysd/App/TapLog.swift`).
App env: `GHOSTKEYSD_PATH`, `GHOSTKEYSD_ARGS` (e.g. `--dry-run`), `GK_PORT`, `GK_MOCK=1`.

## Gotchas and constraints

- **Swift tests:** always use `scripts/run-tests.sh --strict`, never plain `swift test` (on the Command Line Tools
  it runs nothing and reports success). Swift 5.10 Command Line Tools (this Mac) have no swift-testing at all; the
  script then switches to its shim runner (`scripts/lib/shim_tests.py`, summary says "shim runner"). Only
  `#expect`, `#require`, `Issue.record`, `@Suite`, `@Test` and `@Test(.enabled(if:))` are supported there, so new
  tests must stick to those (no `@Test(arguments:)`) or the target fails to generate.
- In test files that `import Testing`, use `import Darwin`, not `Foundation` (see `daemon/scripts/README.md`).
- **One daemon or lab session on the sensors at a time** (machine-wide `daemon.lock`). Quit the app before e2e tests
  or `ghostkeys-lab record`.
- The app spawns `.build/release/ghostkeysd` **before** `.build/debug/ghostkeysd` if both exist, and if the port is
  already open it attaches to that "external" daemon instead of spawning. A stale binary or a leftover daemon
  silently runs old code: rebuild the one that wins, or kill the old process.
- **Saved features are not versioned on `main`.** Changing what a feature means silently mismatches every saved
  model and `samples.json`. Such a change must add versioning first (a ready version exists in
  commit c6419e4, which is in `main`'s history but whose changes were not applied on 27 Sep 2026; see DECISIONS.md).
- A **disabled zone never fires**, and bindings on it do nothing, with no warning at the binding level
  (`--log-taps` prints "zone X is disabled").
- A zone with only a `double` binding ignores single taps (the gesture is `tap`, which has no binding).
- If the app finds a daemon already listening on the port it attaches to it and passes no flags, so
  `pnpm dev:taps` only logs if no other ghostkeysd is running.
- To change zones/bindings from a script, send `config_set` over the WebSocket (token from `<config dir>/token`);
  the daemon retrains from saved samples when enabled zones change. Do not hand-edit model files.
- Accuracy is per machine and per person, and depends heavily on calibration tap count and strength. Edges and
  lid are weak; gentle taps (under ~15 mg) are detected but not placed. See `daemon/analysis/README.md`.
- Gesture actions older than 1 s are dropped; more than 5 actions/s or 60/min **auto-pauses** Ghostkeys.
- Calibrating blocks all actions. Paused blocks all actions.
- Excel edits made over Apple Events are not in Excel's undo history. Spotify cannot "like" via scripting.
- Protocol changes must update `docs/PROTOCOL.md`, the daemon, `app/src/shared/protocol.ts`, the SDK, and pass
  `cargo test` in `windows/`, in one commit.
- `docs/guide` chapters 7, 8, 11, 13 may lag the component READMEs; READMEs win.
- `web/` uses a Next.js version with breaking changes; read `web/AGENTS.md` and the bundled docs before editing.

## Non-negotiable rules (from CONTRIBUTING.md and PROTOCOL.md)

- No sudo, admin prompts, kernel extensions, launch daemons, login items, or System Settings changes.
- No network from the daemon or app. Only the loopback WebSocket on 127.0.0.1.
- Never read what the user types: only time since the last key or click.
- Only accel and gyro driver settings may be written; save originals first, always restore. Never write light or lid.
- The daemon writes only inside its config directory.
- Keep the connection checks: token, Origin rejection, approvals for shell/AppleScript/Shortcuts/open, rate limits.
- Detection changes need evidence from real recordings (`ghostkeys-lab replay`, `analysis/bench`), not only
  synthetic tests.

## Coding conventions (as the existing code does it)

- **Swift**: `final class ...: @unchecked Sendable` with an explicit `NSLock` or a serial `DispatchQueue` owning
  the state. Daemon state is mutated on the `core` queue; training runs on a global queue and hops back.
  Doc comments (`///`) explain *why* and cite `SAFETY_AUDIT` item IDs or `PROTOCOL.md` sections. Magic numbers are
  named statics with the measurement that justified them. Tolerant `Codable` decoding (`decodeIfPresent` with
  defaults) so old/new configs load. Protocol messages are built as `[String: Any]` dictionaries.
- **Detection module stays dependency-free and hardware-free**, and its public API in `API.swift` stays stable.
- **TypeScript**: strict TS, `@shared/*` path alias for types shared by main/renderer, zod at protocol boundaries
  in the SDK, zustand for renderer state, Tailwind utility classes, Radix primitives, 2-space indent, no semicolons,
  single quotes.
- **Docs, UI text, presets**: plain words, lead with the point, **no em dashes or en dashes**, only claim what was
  measured. Tuning results go into `daemon/analysis/README.md` as dated sections with before/after numbers.
- Commits: short imperative subject prefixed by area (`ghostkeysd:`, `Detection:`, `App:`, `Website:`).
