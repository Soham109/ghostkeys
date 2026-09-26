# Ghostkeys safety and security audit

Date: 2026-09-26. Scope: `daemon/Sources/ghostkeysd`, `daemon/Sources/ghostkeys-lab` (sensor code only), a skim of
`GhostkeysVision` and `GhostkeysAcoustics` (still being written), and the parts of `app/src/main` that start and talk to
the daemon. Read-only audit: no repo code was changed.

## Bottom line

- **One critical problem: any web page open in the user's browser can connect to the daemon and run shell commands.**
  The server checks neither where a connection comes from nor any password. Proven with a probe (below).
- Four high problems: a slow AppleScript can stop the daemon from shutting down cleanly; a crash leaves the motion
  sensors running until reboot and the next launch cannot undo it; on exit the daemon can switch off the light and lid
  sensors that macOS itself uses; and nothing limits how fast actions fire.
- Nothing found can physically damage the Mac. The worst hardware outcome is a sensor left streaming (a little
  battery) or the light/lid sensor left off (auto-brightness stops), and both clear on reboot. The real damage risk is
  to the user's files and data, through the action system.

## How this was checked

- Every file in `daemon/Sources/ghostkeysd` read in full; detection code read where it bounds buffers or rates.
- Built a private copy (`swift build --scratch-path .build-audit`) and ran it once with
  `--dry-run --verbose --port 47899` for a few seconds (a spare port, so the real app could not attach to it).
  Stopped with SIGTERM. Nothing else was started or killed.
- Probe script: a WebSocket client that sends the header `Origin: https://evil.example.com`, exactly what a browser tab
  on that site would send. Kept in the session scratchpad, not in the repo.
- Read-only `ioreg` snapshots of the sensor drivers before and after.

### Probe result (the critical finding, reproduced)

```
OPEN with Origin https://evil.example.com (handshake accepted)
<- hello  {device: Mac17,8, Apple M5 Pro, sensors..., permissions...}
<- config {full bindings list}
<- action {"label":"Test: shell","ok":true}          x2
<- action {"label":"Test: applescript","ok":true}
<- action {"label":"Test: shell","ok":true}
stream messages received in 2.5 s: imu 154, light 26, lid 1
```

Daemon log (dry run, so nothing actually ran):

```
dry-run: would run {"command":"echo pwned > /tmp/should-not-exist","kind":"shell"}
dry-run: would run {"command":"su\"\"do -n true","kind":"shell"}          <- passes the sudo filter
dry-run: would run {"kind":"applescript","source":"do shell script \"id\" with «class badm» true"}  <- passes the admin filter
dry-run: would run {"command":"rm -rf ~/not-a-real-dir-audit","kind":"shell"}
```

Without `--dry-run` those commands would have run as the user.

### Measured resource use (dry run, sensors at full rate)

- CPU 1.8 to 2.8 % of one core, 4 threads, about 18 MB resident memory. Fine.
- SIGTERM path worked: log said `restored 2 sensor driver setting(s)` and `ioreg` showed `ReportInterval` back to 0.

---

## 1. Hardware and system state

### Every hardware write

There is exactly one call site in the daemon that writes to hardware settings:
`ghostkeysd/Sensors/SPUDriverControl.swift:154` (`IORegistryEntrySetCFProperty`). It is reached from:

| caller | what it writes | on which sensors |
| --- | --- | --- |
| `wakeMotion` (`SPUDriverControl.swift:52-68`) | `SensorPropertyReportingState=1`, `SensorPropertyPowerState=1` if the driver looked idle; `ReportInterval=1250` always | accelerometer, gyroscope |
| `wakeSilent` (`SPUDriverControl.swift:71-78`), called from `SensorHub.swift:80-85` | reporting and power state = 1 | ambient light, lid angle |
| `restore` (`SPUDriverControl.swift:81-97`) | original `ReportInterval`; states = 0 if we turned them on | all of the above |

The lab tool has its own copy of the same logic: `ghostkeys-lab/Sensor.swift:49-122`.

### What happens on each way of exiting

| exit path | sensors restored? | evidence |
| --- | --- | --- |
| normal `exit()` anywhere | yes | `atexit` at `main.swift:12` |
| SIGINT / SIGTERM / SIGHUP | yes, **only if the main queue is free** | handlers run on `.main`, `main.swift:18-24` |
| parent app dies | yes, **only if the main queue is free** | `ParentWatch` sources on `.main`, `Lifetime.swift:49-67` |
| listener fails (port busy) | yes | `exit(3)` at `WebSocketServer.swift:49` runs `atexit` |
| crash (Swift trap, bad memory access, abort) | **no** | no handler for SIGSEGV / SIGBUS / SIGILL / SIGTRAP / SIGABRT |
| SIGKILL (including the app's 2 s fallback) | **no, cannot be** | `app/src/main/daemon.ts:79-82` |

Residual state after a crash or SIGKILL: the accelerometer and gyroscope drivers stay powered on and reporting every
1.25 ms (about 800 times a second) to nobody. Cost: a little battery, some coprocessor wakeups. No damage. It clears on
reboot, because the drivers are recreated at boot. (Whether sleep and wake also clears it was not tested.)

### H2 (high). A crash leaves sensors on, and the next launch makes it permanent until reboot

- Where: `SPUDriverControl.swift:56-61` and `133-142`; `main.swift` has no crash handler.
- Problem: after a crash, the next launch reads the leftover `ReportInterval` (1250) as the "original" and sees the
  driver already streaming, so it records `wasStreaming = true`. On its clean exit it "restores" 1250 and leaves the
  power on. The leak survives every later launch until reboot.
- Fix:
  1. Before the first write, save the true originals to `~/Library/Application Support/Ghostkeys/sensor-state.json`.
     Delete the file only after a successful restore.
  2. At startup, if that file exists, the last run did not clean up: restore from the file first, and use the file's
     values as the originals, not what the registry shows now.
  3. Add a `--restore-sensors` flag that only does step 2 and exits. The app runs it whenever the daemon exits with a
     signal or a nonzero code (`daemon.ts:59`).
  4. Optional: `sigaction` handlers for SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGABRT that make a best-effort restore and
     re-raise. Not strictly safe inside a crash, which is why steps 1 to 3 are the real fix.

### H3 (high). On exit the daemon can turn off the light and lid sensors macOS itself uses

- Where: `SensorHub.swift:80-85` wakes light or lid if no report arrived in 1.5 s. `SPUDriverControl.swift:75-76`
  records `wasStreaming: false` unconditionally. `restore` at `SPUDriverControl.swift:90-92` then writes
  `SensorPropertyReportingState=0` and `SensorPropertyPowerState=0`.
- Why "silent" is not a safe signal: the lid sensor only reports when the angle changes
  (`LidGestureDetector.swift:4-5`), so a lid that is not moving looks silent. For the light sensor the driver's
  `DebugState` counter read 0 events while the daemon was receiving 26 light readings (measured with `ioreg`), so the
  driver's own counters cannot tell "off" from "on".
- Effect: automatic brightness (light sensor) or anything using the lid angle could stop until reboot.
- Fix: never write power or reporting state to the light or lid drivers. If they are silent, report the sensor as
  unavailable to the app. At minimum, never switch them off in `restore` (treat them as `wasStreaming = true`).

### M3 (medium). Late wake after restore

- Where: `SensorHub.swift:80` schedules `wakeSilent` 1.5 s after start on a global queue; `stop()` (`SensorHub.swift:88-96`)
  does not cancel it. `restore` sets `restored = true` (`SPUDriverControl.swift:84-85`) but `record` keeps appending.
- Effect: if the daemon is told to stop within 1.5 s of starting (the app restarting it, a quick SIGTERM), the late
  wake runs after the restore and is never undone.
- Fix: keep the work item and cancel it in `stop()`; in `wakeSilent`, take the lock and return if `restored` is set.

### M4 (medium). Interval written even when the original could not be read

- Where: `SPUDriverControl.swift:56` reads the original (may be `nil`), `:62` writes 1250 regardless, `:87` restores
  only when the original is non-nil.
- Fix: skip the write when the read failed.

### M2 (medium). The daemon and the lab tool can run at the same time and fight over the drivers

- Where: `ghostkeys-lab/Sensor.swift:49-122` has its own driver control and does not take `daemon.lock`
  (`Lifetime.swift:6-30`).
- Observed during this audit: a `ghostkeys-lab record` session (pid 19347, started by someone else) was streaming the
  accelerometer and gyroscope at about 800 per second. It was left alone.
- Effect: whichever exits first restores "its" originals under the other: the lab's exit can power the sensors off
  under a running daemon, or the daemon's exit can reset the interval under a recording.
- Fix: the lab tool takes the same `daemon.lock`.

### L (low). Interval changed on drivers someone else already uses

- Where: `SPUDriverControl.swift:62` sets 1250 even when `wasStreaming` is true. Restored at exit, but while the
  daemon runs any other user of the sensor gets the new rate. Acceptable; document it.

### Writes outside `~/Library/Application Support/Ghostkeys`

The daemon's own writes all stay inside it: `config.json`, `config.json.bad`, `daemon.lock`, `model/zone-model.json`,
`model/calibration-report.json`, `model/samples.json` (`ConfigStore.swift`, `Lifetime.swift:12`). Exceptions:

- `screenshot` action writes to the Desktop or the user's screenshot folder (`ActionRunner.swift:245-256`). User intended.
- `shell`, `applescript`, `open`, `shortcut` actions can write anywhere. See section 3.
- `ghostkeys-lab` writes wherever `--out` points. Developer tool, acceptable.
- The Electron app writes `app-prefs.json` to its own `userData` folder (`app/src/main/index.ts:22-38`), which is a
  different folder unless the app is named "Ghostkeys". Low; worth aligning with PROTOCOL.md.

`samples.json` is overwritten on each calibration, not appended (`ConfigStore.swift:63-65`), so it does not grow.

---

## 2. Local attack surface: the WebSocket server

### C1 (critical). Any web page can take control of the daemon

- The good part: the server really is loopback only. `WebSocketServer.swift:38-39` binds to `127.0.0.1` and sets
  `acceptLocalOnly`. Other machines cannot connect.
- The problem: browsers let any page open a WebSocket to `ws://127.0.0.1:47823`. WebSockets are not covered by the
  browser's same-origin rule; the server is expected to check the `Origin` header itself. Some newer Chrome builds ask
  the user before a public site reaches a local address; Safari and Firefox do not. Do not rely on the browser.
- The daemon checks nothing: no `Origin` check, no token, no rate limit (`WebSocketServer.swift:30-55`, `63-81`).
  Every message type is accepted from every client (`Daemon.swift:260-343`).
- What a page can do (all confirmed reachable by the probe):
  - `test_action` (`Daemon.swift:325-329`) with `kind: "shell"`: runs `/bin/zsh -lc <anything>` as the user
    (`ActionRunner.swift:105-108`). Delete files, steal files, install persistence.
  - `test_action` with `kind: "text"`: types up to 5000 characters into whatever window is focused. Typed into a
    Terminal with a newline, that is also command execution.
  - `test_action` with `clipboard`, `open` (any file or URL, including apps and `.command` files), `app quit`,
    `keystroke` with modifiers.
  - `config_set` (`Daemon.swift:312-324`): silently replaces the user's config and saves it
    (`ConfigStore.swift:43-45`, no backup). A page can bind a shell command to a common gesture, so it keeps running
    after the tab is closed.
  - `calibration_start` / `calibration_finish` (`Daemon.swift:284-309`, `225-250`): turns all actions off while
    "calibrating", and overwrites the user's trained model.
  - `request_permission` (`Daemon.swift:330-340`): pops the Accessibility prompt repeatedly.
  - Reads: device model, permission state, full config (including any commands the user wrote), and live streams:
    motion at 60 per second, lid angle, light level, taps, and the frontmost app with each gesture. See section 5.
- Fix (small, and all three parts are needed):
  1. **Reject any connection that carries an `Origin` header.** Browsers always send one on WebSockets; the app's
     Node `ws` client (`app/src/main/bridge.ts:28`) sends none. Use
     `NWProtocolWebSocket.Options.setClientRequestHandler(queue) { subprotocols, headers in ... }` and return
     `.init(status: .reject, subprotocol: nil)` when `headers` contains `origin` (case-insensitive). The API exists
     in the installed SDK. Confirm with the probe that `Origin` actually shows up in `headers`.
  2. **Per-launch secret.** At start, generate 32 random bytes (`SecRandomCopyBytes`), write them hex-encoded to
     `~/Library/Application Support/Ghostkeys/session-token` with permissions 0600 (a web page cannot read files).
     The app reads the file and sends it as a custom header, e.g. `X-Ghostkeys-Token` (a browser cannot set custom
     headers on a WebSocket). The daemon compares in constant time and rejects the handshake if it is missing or wrong.
     A file works both when the app starts the daemon and in the app's "external" mode (`daemon.ts:41-44`).
  3. **Limits:** at most 4 clients; at most about 50 messages per second per client, dropping the client above that;
     `test_action` at most 2 per second.
- Also worth doing: the app should check the token file too before trusting whatever listens on the port, so a
  process squatting on 47823 cannot receive the user's config (`daemon.ts:41-44`). Low.

---

## 3. Action safety

### H4 (high). The sudo and admin filters are cosmetic; destructive commands are not considered at all

- Where: `ActionRunner.swift:63-70` and `266-268`.
- Bypasses proven by the probe: `su""do -n true` passes the sudo check. `do shell script "id" with «class badm» true`
  (the raw code for "with administrator privileges") passes the admin check. Base64, variables and `eval` give endless
  more.
- Not checked at all: `rm -rf`, `diskutil`, `csrutil`, `launchctl`, `defaults write`, `networksetup`, `tmutil`,
  `pmset`, `curl ... | sh`, `osascript` inside shell, writes to `~/Library/LaunchAgents`. Several of these break
  PROTOCOL.md's own rule "never change System Settings" (`docs/PROTOCOL.md:17`).
- Why a better blocklist is not the fix: the user writes these commands; any list can be dodged. The protection has
  to be "only the user can create them, and the user sees exactly what they approve":
  1. Fix C1 first. That alone drops this finding to medium.
  2. When a binding with `shell`, `applescript`, `open` of a file, or `shortcut` is saved, the app shows the exact
     command and asks for confirmation. Store a hash of each approved command in the config; the daemon refuses to run
     a command whose hash is not approved. A config written by anything other than the app's confirm flow cannot run.
  3. Keep a short pattern list (the commands above, `sudo` after removing quotes and backslashes) as a speed bump that
     needs an explicit extra confirmation, not as a wall.
- Note: a real admin prompt still asks for the password or Touch ID, so `sudo` without a cached ticket fails. The risk
  is everything that does not need admin: the user's own files.

### H5 (high). Nothing limits how fast actions fire

- Where: `ActionRunner.run` queues without limit (`ActionRunner.swift:20-29`). Gesture detectors for cover, lid and
  tilt have no minimum gap between repeats (`LightGestureDetector.swift`, `LidGestureDetector.swift`,
  `TiltDetector.swift`). `test_action` has no limit.
- Effects: a flickering light or a TV can trigger `cover` over and over; a bad binding like cmd+delete in Finder
  repeats; a slow action (shell up to 10 s, shortcut 30 s, area screenshot 120 s) piles up a backlog that fires long
  after the gesture.
- Good existing guards: tap onsets have a refractory gap and a burst lockout (`OnsetDetector.swift:137-153`), so
  vibration does not become a tap storm.
- Fix: per binding, at most one pending run and a 250 ms cooldown; overall, at most 5 actions per second and 60 per
  minute; drop queued actions older than 1 s; if the limit trips, auto-pause and tell the app.

### H1 (high). A slow AppleScript blocks shutdown, so the sensors are never restored

- Where: AppleScript runs in-process on the main thread with no time limit (`ActionRunner.swift:109-115`, via
  `DispatchQueue.main.sync` at `258-264`). The signal handlers (`main.swift:18`) and parent-death watcher
  (`Lifetime.swift:49`, `55`, `61`) also run on the main thread.
- Effect: a script with `delay 600`, `display dialog`, or a hung target app blocks the main thread. SIGTERM then waits;
  the app gives up after 2 s and sends SIGKILL (`daemon.ts:79-82`), so nothing is restored. If the app itself quits,
  the daemon cannot notice and keeps running with sensors on and actions live. The same main-thread wait also applies
  to `clipboard`, `window` and `app` actions, but those are quick.
- Fix: run user AppleScript out of process through `ProcessRunner.osascript` with a time limit (the `mute` action
  already does this, `ActionRunner.swift:165-168`). Move the signal sources to their own queue and restore the sensors
  there directly, never waiting on the main thread.

### M1 (medium). Timed-out shell commands leave children running and leak threads

- Where: `ProcessRunner.swift:38-46` terminates only `zsh`. Anything started in the background (`cmd &`, `nohup`) keeps
  running. It also keeps the output pipes open, so each reader (`ProcessRunner.swift:22-28`) stays blocked on a
  system thread until that child exits. The call returns after 2 s but the thread stays stuck. About 64 such threads
  starve the system thread pool and stall the daemon. When the daemon exits, running children are left behind too.
- Fix: start commands with `posix_spawn` in their own process group (`POSIX_SPAWN_SETPGROUP`); on timeout and at
  daemon exit, kill the whole group (`kill(-pgid, SIGKILL)`); close the pipe read ends after the time limit.
  (Foundation's `Process` cannot set a process group, and killing the daemon's own group would kill the daemon.)

### Checked and fine

- Macros: at most 50 steps, 30 s total, no nesting, every step checked before any runs (`ActionRunner.swift:141-161`).
  Note: the 30 s limit is only checked between steps, so one slow step can overrun it. Low.
- `text` and `clipboard` capped at 5000 characters (`:73-75`); brightness at 16 presses (`:101`); volume kept to
  0 to 100 (`:176-180`).
- `app quit` refuses Finder and the daemon (`WindowActions.swift:113-116`). It uses a normal quit
  (`terminate()`), so apps can still ask to save. It can quit Terminal or other important apps. Low; consider a
  confirmation when the app has unsaved documents, or a small protected list (loginwindow, System Settings, Terminal
  during a running command).
- Stuck modifier keys: synthetic events carry flags but do not press modifier keys, so nothing stays held
  (`EventPoster.swift:18-30`).
- Leftover processes: every started process is waited for (`ProcessRunner.swift:32`).
- `open` can launch any file or URL, including apps and `.command` scripts (`ActionRunner.swift:182-191`). Low on its
  own; include it in the H4 confirmation flow.

---

## 4. Resource safety

- CPU: measured 1.8 to 2.8 % of one core at the full sensor rate. The per-sample idle-time check is cached to every
  4 ms (`InputMonitor.swift:18`, `41`). Fine.
- Memory: 18 MB. Sample history is a fixed 1024 ring (`Engine.swift:83`); key and mouse times capped at 32
  (`Engine.swift:209-212`); every tap onset always ends or times out (`OnsetDetector.swift:116-126`), so the
  in-flight list cannot grow. Calibration samples are capped at 500 per zone plus up to 600 s of negatives
  (`CalibrationSession.swift:21`, `Daemon.swift:300-301`). Fine.
- **M6 (medium). Slow or idle clients can grow memory.** `broadcast` sends without checking whether the client is
  keeping up (`WebSocketServer.swift:122-129`). A client that subscribes to `imu` and never reads makes the send
  buffer grow (about 10 KB per second). No client limit, messages up to 4 MB (`WebSocketServer.swift:33`). Fix: count
  unsent bytes per client and drop the client above about 1 MB; at most 4 clients (with C1).
- Threads: 4 at rest. The leak risk is M1 above.
- Files: logs go to stderr, and the app passes them to its own console (`daemon.ts:57-58`), not to a file, so there is
  no log growth today. If the daemon is ever run by launchd with a log file, add size limits then. `samples.json` is
  replaced each calibration, not appended.

---

## 5. Privacy

- Good: the daemon never reads the clipboard, never records which keys are typed (only how long since the last key,
  `InputMonitor.swift:43-47`), and never reads window titles.
- **M7 (medium). Data any connected client receives** (today, any web page, see C1): the frontmost app's ID with every
  gesture (`Daemon.swift:167-170`), lid angle and light level (shows whether someone is at the Mac), and motion data
  at 60 per second. Research has shown laptop motion sensors can leak typing rhythm and even keys. Fixed by C1; also
  consider sending `imu` only while the app's live view is open.
- **Logs:** with `--verbose` or `--dry-run`, the full action is logged, including `text` and `clipboard` contents and
  shell commands (`ActionRunner.swift:44`, `47`). Failed commands send up to 300 characters of their error output to
  every client and to the log (`ActionRunner.swift:107-108`, `Daemon.swift:184`). Fix: log `text (42 chars)` instead
  of the text; send error details only to the client that asked (`test_action`), and short.
- Permissions requested: Accessibility (on request, `Daemon.swift:330-340`). Automation prompts appear per target app
  the first time an AppleScript action controls it. Camera and Microphone will come with Vision and Acoustics.
  No Input Monitoring is needed for the idle-time checks.

---

## 6. Vision and Acoustics (early code, skimmed)

Neither module is linked into the daemon yet (`daemon/Package.swift`: `ghostkeysd` depends only on
`GhostkeysDetection`). Nothing opens the camera or microphone today.

### Vision (`GhostkeysVision/CameraSession.swift`)

- Good: nothing turns the camera on until `start` (`:119-132`); listing cameras does not open them (`:82-98`); a hard
  30 s cap on every session (`:33-34`, `:210-212`); the session stops on runtime errors (`:200-201`, `:216-218`);
  capture drops to 5 frames per second without a hand (`:137-146`).
- Low: if setup fails after the camera input is added (`:193-196`), the input stays attached and the next `start`
  fails with "cannot add input". Remove inputs on every failure path.
- Low: `device` is written on the control queue and read on the capture queue (`:151`, `:239`) without a lock.
- Rule to keep when wiring it in: only start a camera session from an explicit user action, and show it in the app
  (the green light alone is not enough in a menu-bar app). Stop it on pause, on SIGTERM, and on client disconnect.

### Acoustics (`GhostkeysAcoustics`)

- Only signal processing and a fixed-size ring buffer so far (`AudioRingBuffer.swift:21-39`, bounded). No microphone
  or speaker code exists yet, so there is no tone to limit.
- Rules to meet when the sonar tone lands: output level cap (for example -20 dB below full scale), fade in and out to
  avoid clicks, a hard time limit per session, never above about 20 kHz nor at full volume for long (small laptop
  tweeters can overheat on sustained loud high tones), stop on pause, exit and mute, and never raise the system
  volume to make it work. Open the microphone only inside an explicit user session, like the camera.

---

## Prioritized fix list

| # | severity | fix | where |
| --- | --- | --- | --- |
| 1 | critical | Reject handshakes with an `Origin` header; require a per-launch token from a 0600 file sent as `X-Ghostkeys-Token`; limit clients and message rate | `WebSocketServer.swift`, `app/src/main/bridge.ts`, `daemon.ts` |
| 2 | high | Never write power or reporting state to light and lid drivers (or never turn them off) | `SensorHub.swift:80-85`, `SPUDriverControl.swift:71-78` |
| 3 | high | Save original sensor values to a file before writing; restore from it on next start; `--restore-sensors` run by the app after a crash | `SPUDriverControl.swift`, `main.swift`, `daemon.ts` |
| 4 | high | Run AppleScript out of process with a time limit; move signal handling off the main thread | `ActionRunner.swift:109-115`, `main.swift:14-28`, `Lifetime.swift` |
| 5 | high | Action rate limits: per-binding cooldown, 5 per second, 60 per minute, auto-pause on trip, drop stale queued actions | `ActionRunner.swift:20-29`, `Daemon.swift:177-188` |
| 6 | high | Shell, AppleScript, file-open and shortcut actions require user confirmation in the app; daemon runs only approved command hashes | `ActionRunner.swift:52-85`, app bindings editor |
| 7 | medium | Kill the whole process group on timeout and at exit; stop leaking reader threads | `ProcessRunner.swift` |
| 8 | medium | Lab tool takes `daemon.lock` | `ghostkeys-lab/Sensor.swift` |
| 9 | medium | Cancel the delayed light/lid wake on stop; refuse wakes after restore | `SensorHub.swift:80`, `SPUDriverControl.swift:71` |
| 10 | medium | Do not write `ReportInterval` when the original could not be read | `SPUDriverControl.swift:56-62` |
| 11 | medium | Drop clients that fall behind; cap clients | `WebSocketServer.swift:122-129` |
| 12 | medium | Redact text and clipboard contents from logs; send error details only to the requester | `ActionRunner.swift:44-47`, `Daemon.swift:184-193` |
| 13 | low | Back up `config.json` and the model before overwriting | `ConfigStore.swift:43-58` |
| 14 | low | Camera: remove inputs on every setup failure; lock `device` | `CameraSession.swift` |
| 15 | low | Acoustics: meet the tone and microphone rules above before shipping | `GhostkeysAcoustics` |

Unrelated functional bug found on the way: `cover_hold` can never fire, because the daemon never calls
`LightGestureDetector.poll(t:)` (only `ingest` at `Daemon.swift:155`), and the light sensor may report only on change.
