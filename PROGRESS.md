# PROGRESS.md: living status

Update at the end of every work session (see CLAUDE.md). "Verified" means someone ran it and saw it work, with
the date and how. Everything else is marked unverified.

Last updated: 2026-09-27 ~00:30, session 2 (Rupak Sharma + Claude). Machine: Mac17,9 (M5 Pro 14"),
Swift 5.10 Command Line Tools, Node 22.11, pnpm, Python 3.12, **no Rust toolchain**.

## Done

### Verified on Mac17,9 (2026-09-26)
- **Daemon builds** with all working-tree changes (`cd daemon && swift build`).
- **App typecheck and lint pass** (`pnpm --dir app typecheck`, `pnpm --dir app lint`), checked in session 1,
  before `package.json` gained `dev:taps`.
- **Zones and bindings for this Mac, chosen from its own calibration taps** (session 2):
  - Evaluated every combination of the 8 zones by 5-fold cross-validation on the saved version-2 taps
    (20 to 30 per zone, 43 typing), counting a tap only at confidence >= 0.8 as live does. With all 8 zones the
    weakest zone got 37%; 4 to 5 zones is the sweet spot. Chosen: **left-palm, right-palm, left-edge,
    right-edge** (weakest zone 87%, 1% wrong zone, 5% of typing spikes read as taps before the typing gate).
    The previous set (lid instead of right-palm) read 14% of typing as taps. Lowering minConfidence to 0.7 did
    not raise recall. Grilles are weak on this Mac (63 to 87% depending on the set).
  - Applied through the daemon's own `config_set` path (simulated-sensor daemon, dry run). The daemon retrained:
    model labels left-edge, left-palm, right-edge, right-palm, none; report left-edge 1.00, left-palm 0.95,
    right-edge 0.90, right-palm 0.87, none 0.88, overall 0.92. Saved taps of the disabled zones are kept.
  - Bindings (all `double`, app `*` unless noted): right-palm volume +6, left-palm volume -6, right-edge
    Spotify next, left-edge Spotify previous; **in Excel only**: right-edge wrap-in-IFERROR, left-edge cycle $
    anchors.
  - Backup of the previous state: `~/Library/Application Support/Ghostkeys/daemon/backup-20260926-before-zone-fix/`.
- **`--log-taps` diagnostics** (session 2): new `ghostkeysd/App/TapLog.swift`, hooks in `Daemon.swift`, flag in
  `Options.swift`, `pnpm dev:taps` in `app/package.json`. Tested with a simulated-sensor daemon on a copy of the
  config: synthetic spikes print REJECTED with peak, zone guess and reason; single taps on a double-only zone
  print "no binding for this gesture (bound on this zone: double)"; taps on a disabled zone print that; nothing
  prints without the flag.
- Real detection ran end to end on this Mac with the uncommitted feature changes (session 1: version-2 model
  trained live at 21:52).

### Claimed by the original author, not re-verified here
- Swift unit tests (cannot run on this machine, see In Progress). e2e suite 107 passed / 2 skipped on the author's
  Mac17,8 at 17:42, before ~25 later commits. Integrations, SDK, CLI, composer, Raycast, Windows port tests.
  Sound, sonar, camera: simulation only. Website live.

## In Progress

### 0. Live diagnosis, round 1 (2026-09-26 ~22:35): right palm taps look like typing
- 11 deliberate right-palm single taps over two rounds: all **detected** (76 to 102 mg, trigger 17.5 mg), none
  gated; the classifier rejected 9 (7 as `none` = typing, 2 right-palm at 0.60) and accepted 2 at 0.81.
- One false positive: a 25 mg bump (hands moving) accepted as right-edge at 0.81.
- Offline replay of the exported recordings (`diagnostics/20260926-2235*.gkrec`) through the saved model reproduces
  the live confidences exactly. Live taps differ from the right-palm calibration taps mainly in `ringFrequency`
  (38 to 39 Hz vs 37.0 to 37.7 Hz: the whole laptop rocking on its feet, so it moves when the laptop is placed
  differently) and `decayTime` (16 to 18 ms vs median 51 ms: much more damped, keystroke-like).
- Tested ignoring ringFrequency / decayTime / pulseWidth / spectral shape: none fixes it (2 of 5 stay `none 1.00`),
  some hurt calibration accuracy. **No code change made.** Conclusion: calibration does not match how the user taps
  now. Action: recalibrate right palm (partial recalibration) in the demo posture, with negatives that include
  resting and moving hands; recalibrate on the demo table before the round.
- Tools (scratchpad, not in repo): a read-only WebSocket observer that auto-requests `diagnostics_export` after
  non-typing spikes; `zoneeval` (zone-subset CV), `tapdiag` (replay + per-feature z-scores), `variants`
  (ignored-feature experiments). Worth moving into `daemon/analysis/` if reused.

### 0b. Live diagnosis, round 2 (2026-09-26 22:46, after a full fresh calibration at 22:44)
- Fresh calibration: all 8 zones, 20 taps each, 49 negatives (all samples new). Report on the 4 enabled zones:
  left-edge 1.00, left-palm 0.95, right-edge 1.00, right-palm 0.90, none 0.73 (8 of 49 negatives read as
  right-palm in CV: watch for false right-palm taps while typing; the live typing gate should block most).
- Live single taps, posture as in calibration: **right palm 5/5 accepted at 1.00** (was 2/11 before recalibration);
  left palm 6 accepted at 0.97 to 1.00, 1 correct-zone at 0.77 (rejected, under 0.80). Unclear ground truth: a
  right-palm 0.90 at 1050.5 s and a right-palm 1.00 at 1059.0 s during the left-palm set (asked the user).
- Conclusion: the calibration logic works; round 1 failed because the calibration did not match how taps were made.
- Not yet tested live: edges, double taps (the actual bindings), typing false positives, actions firing.

### 0c. Rounds 3 and 4 (22:48 to 22:53): edges good at the calibrated spot; doubles never detected -> fixed
- Edges, at the calibrated spot: right 10/10, left 10/11 accepted at 1.00; taps a little lower were rejected
  (correct zone at ~0.5 or `none`). No wrong-zone taps in any round. Demo advice: mark the calibrated spots.
- False positives seen: hands resting/shifting on the palm rests read as right-palm at 0.90 and 1.00 (1050 s,
  1059 s in round 2). Not yet addressed.
- Double taps: 0 of 9 detected; root cause the onset tail guard (see DECISIONS.md and the analysis README). **Fixed
  in `OnsetDetector.swift`** (lagged guard window) + regression test. Replay: right doubles 4/4, left 2/5 (second
  tap sometimes classified right-palm). The running app must be restarted to load the rebuilt daemon. Not yet
  verified live.
- **All Swift tests now run on this machine** (2026-09-27): `scripts/run-tests.sh` switches to a shim runner when
  swift-testing is missing (`scripts/lib/shim_tests.py`). 243 tests pass over the 4 targets (Acoustics 62, Vision
  44, Integrations 54 + 1 disabled, Detection 83), including Soham's `AnchorTests` and `CalibrationMergeTests`.
  Checked that it fails (exit 1) when the old onset detector is put back.
  Known flaky: `PerformanceTests.sonarFieldSixtySecondsUnderHalfASecond` (Acoustics) is a wall-clock limit
  (0.5 s, debug build) and failed once at 0.55 s while the app and daemon were running; 3 reruns passed.

### 1. Diagnose live misses and wrong-zone taps with `--log-taps` (needs a human at the laptop)
Not yet run with real taps. The ACCEPTED line, the "too soft" line and the real Spotify/Excel actions have only
been checked by reading the code, not with real taps. How to run: quit the Ghostkeys app and any `ghostkeysd`,
then `cd app && pnpm dev:taps`. Each tap prints one of:
- nothing, or `too soft ... below the 17.5 mg trigger`: never classified. Tap firmer or raise sensitivity.
- `REJECTED ... -> typing gate / trackpad gate / motion / burst`: a gate blocked it before the classifier.
- `REJECTED ... <zone> 0.6x (next <zone> ...) -> not sure enough`: the classifier's confidence was under 0.8.
- `REJECTED ... none ...`: the classifier thinks it is typing or a click, or unlike every calibrated zone.
- `ACCEPTED ... <zone> 0.9x (next ...)`: then a `GESTURE ... -> runs "<label>"` or `-> nothing ran: <why>`.
Collect about 10 taps per zone, note which zone was really tapped, and count each line type. Wrong zones and
REJECTED low-confidence lines point to recalibrating those zones (more taps, at the strength actually used);
"too soft" points to sensitivity; gate rejections point to the timing gates.

### 2. Soham's detection fix: anchored feature window (his ~21:18 session; committed on `demo-fixes`)
`FeatureExtractor` anchors integrals on 30% of the tap's peak; `TapFeatures.version = 2`; strength augmentation
on; `ConfigStore` ignores other feature versions; `CalibrationMerge` keeps saved zones on partial recalibration;
`DeviceInfo` maps Mac17,9; tests `AnchorTests`, `CalibrationMergeTests`. Evidence: `daemon/analysis/README.md`
(small sets). Builds, runs live, and its tests pass (shim runner, 2026-09-27).

### 3. Swift tests on this machine: solved by the shim runner (see 0c)
Official swift-testing runs still need Swift 6 Command Line Tools or Xcode 16+; not required any more.

## Branch state (2026-09-27)
All work is committed on branch `demo-fixes` (5 commits on top of `main` at e9cbf5e; not pushed, not merged):
Soham's detection work (authored as Soham), the tail-guard fix, the shim test runner, `--log-taps`, these docs.

## Next Step

Restart the app (`Ctrl+C` the `pnpm dev:taps` terminal, run it again) so the rebuilt daemon with the tail-guard fix
loads, then repeat round 4 (5 double taps per palm) with the observer and confirm the volume changes. Then look at
the resting-hand false positives on the palm rests.
