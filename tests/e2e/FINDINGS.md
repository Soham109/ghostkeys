# Findings from the e2e suite

Scope note: this file only documents things found while writing and running
`tests/e2e/**`. We do not own `daemon/Sources/**` and did not change any of it;
these are handed back for whoever does own that code to triage. Numbering is
stable across revisions of this file (so old references still resolve); fixed
items stay in the list, marked as fixed, rather than being renumbered away.

## Fixed

### 1. FIXED -- `--dry-run` used to never reach the Finder-quit / self-quit guards

- **Original problem:** `ActionRunner.validate("app", ...)` only checked that the op
  string was a member of `WindowActions.appOps`; the actual Finder/self-pid refusal
  checks lived inside `WindowActions.app(_:)`, only reached from `execute()`, which
  `perform()` skips whenever `dryRun` is true. A dry-run `test_action` to quit Finder
  always reported `ok:true`, no matter which app was actually frontmost.
- **Fix landed:** `daemon/Sources/ghostkeysd/Actions/WindowActions.swift` now has a
  `checkApp(_:)` function (no side effects: unknown-op check, frontmost-app lookup,
  and the Finder/self-pid guards) that `app(_:)` calls before doing anything, and
  `ActionRunner.validate()`'s `"app"` case calls `checkApp(_:)` directly (via `onMain`)
  instead of only checking `appOps` membership. So `validate()` and `execute()` now
  agree, and dry-run reports the same refusal a real run would.
- **Test:** `tests/e2e/test_actions.py::test_action_app_quit_finder_refused_when_frontmost`
  checks whether Finder is actually the frontmost app (via `harness.frontmost_app_name()`,
  which shells out to `lsappinfo` -- no Accessibility/Automation permission needed) and
  only asserts the refusal when it is; it skips otherwise, since this suite never changes
  window focus to force the precondition. A companion test,
  `test_action_app_quit_self_is_never_frontmost_so_never_reachable`, documents that the
  self-quit branch is unreachable from the protocol in practice (ghostkeysd is a
  background daemon with no windows, so it can never be `NSWorkspace`'s frontmost app).

### 2. FIXED -- there was no way to point the daemon at an isolated config directory

- **Original problem:** `Options.swift` had no `--config-dir` flag or environment
  variable fallback; `ConfigStore.init()` hardcoded
  `~/Library/Application Support/Ghostkeys/`. Every daemon instance on a machine
  (this suite, a manual run, a future CI job) read and wrote the same directory,
  which -- see finding #7 -- also turned out to be the real app's Electron profile
  directory.
- **Fix landed:** `Options.swift` gained `--config-dir PATH`; `ConfigStore.configure(override:)`
  resolves it, then `GHOSTKEYS_CONFIG_DIR`, else a new default
  `~/Library/Application Support/Ghostkeys/daemon/` (one level below the old shared
  location, so the Electron app keeps the parent folder to itself). `ConfigStore.migrateLegacyFiles()`
  does a one-time move of any daemon-owned files an older version left in the old
  shared location into the new default, but only when no explicit override is given.
- **What this suite does now:** every `DaemonProcess` (`tests/e2e/harness.py`) requires
  a `config_dir` argument and always passes `--config-dir <that path>` (normally a
  pytest `tmp_path`). This suite no longer reads, writes, backs up or restores
  anything under the real `~/Library/Application Support/Ghostkeys/` at all -- the
  earlier backup/restore workaround (`ConfigSandbox`) has been deleted entirely, and
  the daemon's per-launch token is read straight from `<config_dir>/token`
  (`DaemonProcess.token`) instead of being injected via an env var.

### 5. FIXED -- simultaneous WebSocket handshakes could all be refused, even with a valid token

- **Original problem:** `WebSocketServer`'s `setClientRequestHandler` callback has no
  way to know which pending connection a handshake belongs to (a Network.framework
  limitation the code comments call out directly). The old workaround assigned a
  verdict to a pending client only when exactly one was mid-handshake; with 0 or 2+
  waiting, it refused all of them, even ones presenting a perfectly valid token. Two
  WebSocket connections opened at close to the same instant (e.g. a main window and a
  HUD both starting up) could both be rejected on the first attempt.
- **Fix landed:** `daemon/Sources/ghostkeysd/Server/WebSocketServer.swift` now
  serializes handshakes: an `admissions` queue holds connections waiting their turn,
  `handshaking` tracks the one connection currently mid-handshake, and `admitNext()`
  only starts the next queued connection once the previous one has finished (accepted,
  rejected, or timed out). Exactly one connection is ever mid-handshake, so the
  ambiguity is gone and simultaneous connections just wait their turn (a few
  milliseconds each).
- **Test:** `tests/e2e/test_handshake.py::test_concurrent_handshakes_both_succeed` opens
  two connections at the same instant via `asyncio.gather` and asserts both succeed.

### 7. FIXED (more thoroughly than our own interim fix) -- config directory was shared with the real app's Electron profile

- **Original problem:** PROTOCOL.md's safety rules said "Config lives in
  `~/Library/Application Support/Ghostkeys/` only" -- true for what the daemon itself
  wrote, but that same directory was found mid-session to also hold a full Electron
  userData profile (`Cache`, `GPUCache`, `Session Storage`, `Local Storage`,
  `Preferences`, `Cookies`, `blob_storage`, `DawnGraphiteCache`, `Local State`, etc.),
  almost certainly from the real `Ghostkeys.app` (Electron's default userData path is
  `<Application Support>/<app name>`). An early version of this suite's `ConfigSandbox`
  backed up and wiped the *entire* directory between tests, which risked destroying
  that profile or fighting a concurrently running instance of the real app over files
  like `Session Storage/LOCK`. (Timestamps showed no actual damage occurred -- the
  Electron profile's last write predated this suite's test runs -- but the design
  was unsafe regardless of that luck.) A same-session interim fix narrowed
  `ConfigSandbox` to only touch the specific files/dirs ghostkeysd owns.
- **Fix landed upstream:** exactly the suggestion this finding made: the daemon's
  default directory moved one level down, to
  `~/Library/Application Support/Ghostkeys/daemon/` (finding #2), so the Electron
  app's userData directory and the daemon's own files no longer share a folder at all
  by default. Combined with `--config-dir` (also finding #2), this suite now avoids
  the real shared location entirely rather than just being careful within it --
  `ConfigSandbox` has been deleted from `tests/e2e/harness.py`.

## Remaining

### 3. `integration` action kind was a stub, then landed mid-suite (informational, not a live bug)

When this suite was started, `docs/PROTOCOL.md` documented an `integration` action
kind (`app`/`command`/`args`) as "implemented by the GhostkeysIntegrations module",
but `ActionRunner.validate()`/`execute()` had no `"integration"` case (fell through
to `unknown action kind: integration`) and `GhostkeysIntegrations/Placeholder.swift`
was a one-line stub. Partway through writing these tests, a full
`GhostkeysIntegrations` implementation (catalog, Excel/Chrome/Finder/etc. commands,
`IntegrationCatalog.swift`) landed, `ActionRunner` grew a real `"integration"` case,
and `Package.swift` started linking the module into the `ghostkeysd` target. The
suite tests the current, working behavior:
`tests/e2e/test_actions.py::test_action_integration_unknown_command_is_refused` and
`::test_action_integration_valid_command`. Nothing to fix; noted so the next reader
isn't confused by a stale "unimplemented" claim if they see one referenced elsewhere.

### 4. Calibration sample capture can't be driven from the protocol (suite limitation, not a daemon bug)

`calibration_zone` only starts *labeling* whatever taps the detection engine
already accepts as candidates; there is no message that injects a synthetic
accelerometer sample. Actually accumulating a capture count (and therefore
reaching `calibration_finish` with real samples, seeing `phase: "done"` with
real accuracy numbers) requires a person physically tapping the laptop case
while `calibration_zone`/`calibration_negatives` is active. `tests/e2e/test_calibration.py`
covers every part of the control flow that doesn't require that (start, zone
selection and its broadcast, the negatives countdown timer end-to-end including
clamping, finish-with-zero-samples' error, cancel), and separately proves the
"no samples" error path, but cannot exercise a successful `phase: "done"`.

Note: a `--no-hardware-sessions` mode with `sim_tap`/`sim_tap_type`/`sim_air` test
hooks landed later in the same session (see finding #6) for a *different* purpose
(tap-type calibration and air/sound gesture testing) -- it does not feed the
original zone-calibration engine (`TapEngine.ingest()`), so it does not close this
gap. Whoever picks this up should check whether a similar synthetic-sample hook
could be added for `calibration_zone`/`calibration_negatives` specifically.

### 6. This suite was written while the daemon was under active, concurrent development (informational)

Not a bug by itself, but worth recording for whoever reads this next: over the course
of writing `tests/e2e/**`, another agent working on this same repo shipped, in order:
a full authentication layer (`Security/SessionToken.swift`, handshake token, Origin
rejection, per-client/global rate limits -- see finding #5), an action-approval
workflow (`Security/ApprovalStore.swift`, `approve_action`/`revoke_action`,
`CommandFilter` dangerous-pattern refusals), a crash-recovery mechanism for the
sensor driver settings (`spu-originals.json`, `--restore-sensors`), the
`GhostkeysIntegrations` module (finding #3), `--config-dir` isolation (finding #2),
the Finder-quit dry-run fix (finding #1), and a large "sessions" subsystem
(`Sessions/SessionCoordinator.swift`, `AirSession.swift`, `SoundSession.swift`,
tap-type calibration, a `--no-hardware-sessions` simulation mode with
`sim_tap`/`sim_tap_type`/`sim_air` test hooks, a `catalog_get` message, pinch-hold
"knob" bindings). The build even raced mid-compile once ("input file ... was
modified during the build") before the first successful build, and every finding
in this file except #3/#4/#6 was reported to the daemon's owner and fixed within
the same working session.

This suite tracks the authentication, approval, config-dir and integration changes
above (they are load-bearing for basic connectivity and for the required action-kind
coverage) but deliberately does **not** add coverage for the sessions/air/sound/catalog/
knob surface: it is outside the original task's checklist, still in motion as this was
written, and each of those features has real hardware or timing dependencies (mic,
camera, pinch gestures) that need their own design, not a bolt-on here. Whoever picks
that up should start from `Sessions/SessionCoordinator.swift` and the
`--no-hardware-sessions` / `sim_*` hooks in `App/Daemon.swift`'s `handle()`, which look
purpose-built for exactly this kind of black-box testing.

### Sensor stream rate checks are environment-dependent (suite limitation, not a daemon bug)

`test_streams.py`'s imu (~60 Hz) and light (~10 Hz) rate checks read `hello.sensors`
first and `pytest.skip` if the corresponding sensor isn't present, and also skip
(with a note recorded into REPORT.md) if the sensor is present but produced zero
messages in the sampling window (e.g. IOHIDDevice access silently blocked by a TCC
permission in whatever environment runs the suite). The lid-angle "on change" check
is inherently a no-op unless something physically moves the lid during the run, so
zero messages there is treated as a valid outcome, not a failure.
