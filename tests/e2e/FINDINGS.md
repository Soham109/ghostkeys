# Findings from the e2e suite

Scope note: this file only documents things found while writing and running
`tests/e2e/**`. We do not own `daemon/Sources/**` and did not change any of it;
these are handed back for whoever does own that code to triage.

## Bugs / gaps in the daemon

### 1. `--dry-run` never reaches the Finder-quit / self-quit guards

- **Where the skip happens:** `daemon/Sources/ghostkeysd/Actions/ActionRunner.swift`,
  `perform(_:inMacro:)` (lines 56-73, current as of this writing -- this file has been
  edited several times during this session, see finding #6). The order is:
  `try validate(kind, action)` (line 65), then the approval gate (line 66), then
  `if dryRun { ...; return }` (lines 67-70), then only if not dry-run,
  `try execute(kind, action)` (line 72).
- **Where the actual guard lives:** `daemon/Sources/ghostkeysd/Actions/WindowActions.swift`,
  `app(_:)`, lines 113-115 (this file has not been touched during this session):
  ```swift
  case "quit":
      guard front.bundleIdentifier != "com.apple.finder" else { throw ActionError("refusing to quit Finder") }
      guard front.processIdentifier != getpid() else { throw ActionError("refusing to quit ghostkeysd") }
  ```
  `execute()` is what calls into `WindowActions.app(_:)`; `validate()`'s `"app"` case
  only checks that the op string is a member of `WindowActions.appOps`
  ("hide", "quit", "switch-next", "switch-previous"). It has no idea which app is frontmost.
- **Why this matters:** the doc comment directly above `validate()` (ActionRunner.swift
  line 75) says: *"Checks fields before anything runs, so dry-run reports the same
  errors a real run would."* That invariant is false for `{"kind":"app","op":"quit"}`:
  a dry-run `test_action` always reports `ok:true` for this action, no matter which
  app is frontmost, because `execute()` (and therefore the guard) is never reached.
- **Repro:**
  1. Start the daemon with `--dry-run`.
  2. Make Finder the frontmost app (or don't -- it doesn't matter).
  3. Send `{"type":"test_action","action":{"kind":"app","op":"quit"}}`.
  4. Observe `{"type":"action","ok":true,...}` instead of a refusal.
- **Suggested fix:** move the Finder/self-pid checks into `validate()` (they only need
  `NSWorkspace.shared.frontmostApplication`, no side effects), so dry-run and a real run
  agree, and so the UI's "confirm before binding quit" story (PROTOCOL.md's action-kinds
  table, `app`/`quit` row) is actually backed by a guard that fires during dry-run
  testing/preview.
- **Test:** `tests/e2e/test_actions.py::test_action_app_quit_finder_not_refused_in_dry_run_KNOWN_GAP`
  pins down today's behavior explicitly so a future fix flips it red as a signal to update
  the test, rather than the suite silently asserting a wrong assumption. We could not test
  the real refusal path directly: doing so would require running without `--dry-run`,
  which the task's safety rules for this Mac forbid (a real "app quit" while some
  unpredictable app is frontmost is not something an automated agent should risk).

### 2. No way to point the daemon at an isolated config directory

- **Where checked:** `daemon/Sources/ghostkeysd/App/Options.swift` (whole file) has no
  `--config-dir` flag and no environment-variable fallback of any kind.
  `daemon/Sources/ghostkeysd/Config/ConfigStore.swift`, `init()` (lines 13-17), hardcodes:
  ```swift
  let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
  directory = base.appendingPathComponent("Ghostkeys", isDirectory: true)
  ```
  There is no constructor parameter and no override hook.
- **Impact:** every daemon instance on a machine (this test suite, a second manual run, a
  future CI job) reads and writes the *same* `~/Library/Application Support/Ghostkeys/`,
  including `config.json` and `model/*.json`. That is exactly the real user's live
  Ghostkeys config if that app is ever actually used on this Mac.
- **What this suite does instead:** `tests/e2e/harness.py`'s `ConfigSandbox` backs up
  the whole directory before the session (`snapshot_and_clear`) and restores it
  byte-for-byte afterwards (`restore`), with an `atexit` backstop in `conftest.py` in
  case the session is killed rather than finished normally. Every individual test also
  wipes the directory first (`reset_between_tests`) so it starts from `Config.defaults`.
  This works, but it is extra choreography a `--config-dir PATH` flag threaded through
  `Options` and `ConfigStore.init(directory:)` would remove entirely, and it is the
  kind of thing a test suite really shouldn't have to do to a real user's Mac.
- **Suggested fix:** add `--config-dir PATH` to `Options.parse` (mirroring the existing
  `--port` handling) and an optional `directory:` parameter to `ConfigStore.init`. This
  is a small change in the same style as two flags that landed in `Options.swift` during
  this same session (`--restore-sensors`, and the `GHOSTKEYS_TOKEN` environment variable
  read in `Security/SessionToken.swift`), so there is already a precedent for exactly
  this kind of override; `--config-dir` (or a `GHOSTKEYS_CONFIG_DIR` env var, matching the
  token's pattern) is the one still missing.
- **What this suite does about the token specifically:** since there is no config-dir
  override, but there *is* a `GHOSTKEYS_TOKEN` env var (`Security/SessionToken.swift`),
  `tests/e2e/harness.py`'s `DaemonProcess` generates a fresh 32-byte hex token per
  instance and passes it via that env var, so tests never need to read the shared
  token file at all.

### 3. (Resolved during this session) `integration` action kind was a stub, then landed mid-suite

When this suite was started, `docs/PROTOCOL.md` documented an `integration` action
kind (`app`/`command`/`args`) as "implemented by the GhostkeysIntegrations module",
but `ActionRunner.validate()`/`execute()` had no `"integration"` case (fell through
to `unknown action kind: integration`) and `GhostkeysIntegrations/Placeholder.swift`
was a one-line stub. **This repo is being actively developed by another agent in
parallel with this suite**: partway through writing these tests, a full
`GhostkeysIntegrations` implementation (catalog, Excel/Chrome/Finder/etc. commands,
`IntegrationCatalog.swift`) landed, `ActionRunner` grew a real `"integration"` case,
and `Package.swift` started linking the module into the `ghostkeysd` target. The
suite now tests the current, working behavior:
`tests/e2e/test_actions.py::test_action_integration_unknown_command_is_refused` and
`::test_action_integration_valid_command`. Nothing to fix here; noted so the next
reader isn't confused by a stale "unimplemented" claim if they see it referenced
elsewhere (e.g. in an earlier commit of this file).

### 5. Simultaneous WebSocket handshakes can all be refused, even with a valid token

- **Where:** `daemon/Sources/ghostkeysd/Server/WebSocketServer.swift`, `start()`'s
  `ws.setClientRequestHandler` closure. Its own comment explains why: *"Network.framework
  does not say which connection a handshake belongs to, and a rejected handshake still
  reaches `.ready` on the server side."* The workaround: the verdict for an incoming
  handshake is assigned to a pending client only if `waiting.count == 1` (exactly one
  connection is currently mid-handshake); if 0 or 2+ are waiting, *all* of them are marked
  `authorized = false` and this handshake gets an explicit reject, regardless of whether
  its own token was valid.
- **Impact:** if the app opens two WebSocket connections at close to the same instant
  (e.g. a main window and a HUD both starting up), both can be rejected on the first
  attempt even though both presented the correct `X-Ghostkeys-Token`. The code comment
  says "the app simply reconnects", i.e. this is treated as an acceptable, retry-driven
  race rather than a bug -- but `docs/PROTOCOL.md`'s "Authentication" section does not
  mention this at all, so a client author would not know to implement the retry.
- **Repro / test:**
  `tests/e2e/test_handshake.py::test_concurrent_handshakes_can_all_be_refused_KNOWN_GAP`
  opens two connections at the same instant with the correct token via `asyncio.gather`
  and shows both can be rejected, then shows a sequential retry always succeeds.
- **Suggested fix:** at minimum, document the retry requirement in PROTOCOL.md's
  Authentication section. A more robust fix would thread an unambiguous per-connection
  identity into the handshake callback if Network.framework exposes one, or serialize
  pending handshakes so only one is ever mid-flight at a time.

### 6. This suite was written while the daemon was under active, concurrent development

Not a bug by itself, but worth recording for whoever reads this next: over the course
of writing `tests/e2e/**`, another agent working on this same repo shipped, in order:
a full authentication layer (`Security/SessionToken.swift`, handshake token, Origin
rejection, per-client/global rate limits), an action-approval workflow
(`Security/ApprovalStore.swift`, `approve_action`/`revoke_action`, `CommandFilter`
dangerous-pattern refusals), a crash-recovery mechanism for the sensor driver settings
(`spu-originals.json`, `--restore-sensors`), the `GhostkeysIntegrations` module
(finding #3 above), and a large "sessions" subsystem (`Sessions/SessionCoordinator.swift`,
`AirSession.swift`, `SoundSession.swift`, tap-type calibration, a `--no-hardware-sessions`
simulation mode with `sim_tap`/`sim_tap_type`/`sim_air` test hooks, a `catalog_get`
message, pinch-hold "knob" bindings). The build even raced mid-compile once
("input file ... was modified during the build") before the first successful build.

This suite was adapted to track the authentication, approval and integration changes
above (they are load-bearing for basic connectivity and for the required action-kind
coverage) but deliberately does **not** add coverage for the sessions/air/sound/catalog/
knob surface: it is outside the original task's checklist, still in motion as this was
written, and each of those features has real hardware or timing dependencies (mic,
camera, pinch gestures) that need their own design, not a bolt-on here. Whoever picks
that up should start from `Sessions/SessionCoordinator.swift` and the
`--no-hardware-sessions` / `sim_*` hooks in `App/Daemon.swift`'s `handle()`, which look
purpose-built for exactly this kind of black-box testing.

## Suite limitations (not daemon bugs)

### 4. Calibration sample capture can't be driven from the protocol

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

### 7. `~/Library/Application Support/Ghostkeys/` is shared with the real app's Electron profile, not daemon-exclusive

PROTOCOL.md's safety rules say "Config lives in `~/Library/Application Support/Ghostkeys/`
only" -- true for what the *daemon* writes, but partway through this session that same
directory was found to also contain a full Electron userData profile: `Cache`, `GPUCache`,
`Session Storage`, `Local Storage`, `Preferences`, `Cookies`, `blob_storage`,
`DawnGraphiteCache`, `Local State`, etc. This is almost certainly the real `Ghostkeys.app`
(Electron's default userData path is `<Application Support>/<app name>`, and the app name
matches). Timestamps show that profile's last write was well before this suite's test runs
and no process held the directory open when checked, so nothing here indicates a live app
was actually disrupted -- but the design point stands regardless of luck: **this directory is
not exclusive to the daemon**, and any tooling (including an earlier version of this very
suite) that backs up and wipes the *whole* directory between tests risks destroying a real
app's live profile, or worse, fighting a concurrently running instance of it over files like
`Session Storage/LOCK`.

**Fix applied here:** `tests/e2e/harness.py`'s `ConfigSandbox` was rewritten to only ever
touch the specific paths ghostkeysd itself reads or writes (`config.json` and its `.bak`/`.bad`
siblings, `daemon.lock`, `token`, `approved.json`, `spu-originals.json`, and the `model/`
directory) rather than the directory as a whole. Everything else there, however large, is now
left completely alone by this suite.

**Suggested fix upstream:** either give the daemon its own subdirectory (e.g.
`~/Library/Application Support/Ghostkeys/daemon/`) separate from whatever the Electron app's
userData path resolves to, or document in PROTOCOL.md that the two intentionally share the
top-level directory and enumerate exactly which entries belong to the daemon, so the next
person writing tooling against this doesn't make the same whole-directory assumption.

### Sensor stream rate checks are environment-dependent

`test_streams.py`'s imu (~60 Hz) and light (~10 Hz) rate checks read `hello.sensors`
first and `pytest.skip` if the corresponding sensor isn't present, and also skip
(with a note recorded into REPORT.md) if the sensor is present but produced zero
messages in the sampling window (e.g. IOHIDDevice access silently blocked by a TCC
permission in whatever environment runs the suite). The lid-angle "on change" check
is inherently a no-op unless something physically moves the lid during the run, so
zero messages there is treated as a valid outcome, not a failure.
