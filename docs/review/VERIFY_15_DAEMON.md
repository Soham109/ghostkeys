# VERIFY 15: ghostkeysd commit 9e33f13 (learning fixes, calibration, gates)

Independent check of the latest commit on main, which changed `daemon/Sources/ghostkeysd` and `docs/PROTOCOL.md`.
Date: 27 Sep 2026. Build: debug, `--scratch-path .build-v15`, working tree as found (it also holds other agents'
uncommitted GhostkeysDetection and GhostkeysAcoustics edits).

## Verdict

**Ship it with the one fix below (already made, with a test).** The owner's real data survives the upgrade intact.
One real bug was found and fixed: a calibration could be thrown away without a word if any retrain started while it
trained. On the owner's real data that training takes about 16 s in a debug build, so the window is wide.

What was proven on a copy of the owner's real config (`~/Library/Application Support/Ghostkeys/daemon`, copied, never
touched):

- Upgrade: bindings, zones and every setting come through unchanged; `samples.json` (142 old entries, no posture
  fields) loads; the model loads (`calibrated: true`, all 8 zones). Across three starts the only file that changes is
  the new `migrations.json`. `samples.json` is not even rewritten.
- The owner's `config.json` has no `learnFromUse` key at all, so the new default (off) applies and the migration has
  nothing to flip. With the key set to `true` (the old default written out), the migration turns it off once; setting
  it back to `true` then survives two restarts.
- Partial recalibration of `right-grille` (6 taps, posture `lap`, strength `firm`) through the protocol: all 122
  entries of the other zones and `none` are identical after it, in the same order, number for number (every number
  literal in each entry matches the original file). The file layout (key order) changes because the daemon re-encodes
  it; the data does not. Two restarts afterwards change nothing.

## Findings, ranked

### 1. High, fixed: a calibration was silently discarded when a retrain started while it trained

`finishCalibration` took a generation number and, at install, dropped itself as "stale" if any newer retrain had been
installed. Retrains that start during training (a zone switched on or off with `config_set`, `feedback_missed` /
`feedback_false`, a merge, a recommendation) take a newer number and finish first. Result, reproduced on the real
data: no `done` and no `failed` message (the app would sit on "training" forever), the new samples never saved
(`samples.json` kept the old 20 `right-grille` samples), only a log line. The other ordering was also wrong: a retrain
that started during training but finished after it installed a model built from the old samples over the new
calibration (the report showed `right-grille` trained on 20 old samples while `samples.json` held the 6 new ones).

Measured: calibration training on the owner's 142 samples took 15.8 s (debug build, machine under load from other
agents), so a zone toggle during that time was enough.

Fix (`App/Daemon.swift`, 29 lines):
- A calibration always installs and always ends with `done` or `failed`.
- `samplesEpoch` goes up when a calibration replaces `samples.json`. A zone-change retrain that started from older
  samples retrains again from the new ones; feedback replies `retrained: false` ("a new calibration finished first;
  send the feedback again"); learn from use does not install and waits.
- If zones were switched on or off while the calibration trained, it retrains once more after installing.
- While a calibration trains, `calibration_start` and `calibration_apply_merge` are refused with an `error` (a merge
  relabels samples on disk that the training calibration would overwrite). Learn-from-use retraining waits too.
- `docs/PROTOCOL.md` says so.

Test: `tests/e2e/test_learning_fixes.py::test_calibration_survives_a_retrain_started_while_it_trains`. It fails on the
commit as shipped (model trained on the old samples) and passes with the fix. On the real-data copy, after the fix:
`done` arrives, `right-grille` is trained on the 6 new samples, and the `lid` toggle is applied by a follow-up retrain.

Remaining edge, not fixed: a feedback retrain that started before `calibration_finish` and finishes before the
calibration installs saves its one added sample, which the calibration then overwrites. One feedback sample lost, no
wrong model.

### 2. High, design question for the owner: a second posture wipes the first

Partial recalibration replaces samples per zone, not per zone and posture. The app's training session
(`Practice.tsx`) calibrates every active zone for one posture. Training "On my lap" after "On a desk" therefore
replaces every desk sample of those zones, although samples now carry `posture` so that per-posture models can be
built later. The same goes for a doubles-only session: on the real data, 4 doubles on `right-grille` replaced its 20
single-tap samples with 10 double-tap samples. Not changed here, because it is a product choice (options: replace only
samples of the same posture, treating old samples without a posture as `desk`; or keep both and cap per posture).

### 3. Low: Cmd+Z can cancel an older gesture's taps

`cancelLatest` drops the newest gesture that still has pending taps, not the newest gesture. If the newest gesture
left nothing to learn (confidence under `minConfidence`, taps unfamiliar, or taps already counted by an earlier
gesture), Cmd+Z cancels the previous gesture instead. Reproduced: tap at 0.95, tap at 0.5, `sim_undo`: nothing
confirmed (expected 1). It errs toward learning less, which is the safe side, so it was left alone. A precise fix
needs an undo stack that also records gestures with no pending taps, and a decision about gestures that share taps.

Everything else about undo behaved: three taps then one undo leaves 2; two undos leave 1; right then left then undo
cancels only left; undo after a tap was already confirmed changes nothing; `feedback_false` cancels only the gesture
of the tap it is about.

### 4. Low: the ship guard stops mislabels, not boundary drift

Deterministic, as claimed: every poisoning case run twice on identical copies gave identical `adaptation` messages
and byte-identical models. On the real data:
- 8 `right-grille` taps confirmed as `left-palm`: all 8 rejected, the 10 genuine taps kept.
- 8 taps far outside every cluster: all 8 rejected.
- 3 entries of the wrong length: all 3 rejected.
- 8 `left-palm` taps placed 55 to 69% of the way from `right-grille` to `left-palm`: 6 accepted and shipped
  (calibration accuracy unchanged at 0.9789). Plausible but shifted labels get through; that is the limit of a
  neighbour check, and learn from use is now off by default.

### 5. Low: loose message validation

- `posture` that is not a string (`5`, `null`, `["lap"]`) silently becomes `desk` instead of an error; a bad string is
  refused. `strength: 5` is silently ignored.
- `calibration_doubles` (like `calibration_zone`) accepts a zone id that is not in the config; its samples then train
  a label no zone has.
- `target: null` is refused although a missing `target` defaults to 20.

Numbers themselves are safe: `1e300`, negatives, `0` and fractions are clamped, strings and booleans are refused,
`NaN` / `Infinity` are invalid JSON. The daemon stayed up through all of it.

### 6. Low: `bound` is true for gestures that did not fire

`bound` is set before the rate limiter, so a gesture skipped by a binding's cooldown, or refused because the limiter
tripped, is still reported `bound: true`. PROTOCOL says "an enabled binding matched and fires".

### 7. Low: other notes

- Doubles window: with few pairs the 90th percentile is the slowest pair, so one slow double sets the window (four
  pairs of 101, 251, 451 and 691 ms gave 500 ms, the maximum). Gaps under 50 ms are one onset; over 700 ms do not
  pair. Unpaired first taps are kept as `double1` samples. Clamping to 250 to 500 ms works.
- A corrupt `migrations.json` makes the migration run again and turn `learnFromUse` off a second time. A config that
  cannot be saved still records the migration as done.
- The motion gate watches the direction of gravity, so lifting the laptop straight up without tilting it does not
  pause sonar (the old level threshold did).

## Test-only hooks

Every `sim_*` message (including the new `sim_slow_retrain` and `sim_input_event`) is a `case ... where
options.noHardwareSessions`; without that flag it falls through to `unknown message type`. The raw-cap override
`GHOSTKEYS_TEST_RAW_CAP_BYTES` is read only under the same flag. The app starts the daemon without
`--no-hardware-sessions` (only `app/scripts/selftest-real.mjs` and `app/scripts/verify/verify-app.mjs` pass it). This
was checked in the code, not by launching the daemon without the flag, because the safety rules for this run require
the flag.

## App compatibility (`app/src/shared/protocol.ts`, not edited here)

- `adaptation` is missing from `DAEMON_TYPES` and has no message type, so `parseDaemonMessage` drops it. `rejected`,
  `heldOutBefore` and `heldOutAfter` (and the whole message) never reach the app.
- `calibration` phase `failed` is not in `CalibrationMsg` and nothing in the renderer handles it; a calibration that
  cannot be saved leaves the app waiting.
- `bound` is typed (optional) but nothing in the renderer reads it yet, so the HUD does not filter on it as PROTOCOL
  describes.
- Accepted as sent: `detection_state` (typed and handled in `store.ts`), `status.detector.unfamiliar`, `done.recalibrated`,
  `posture` (`desk | lap | stand`), `strength`, `dropped`, the `doubles` and `doubles_done` phases, and
  `calibration_doubles` is relayable from the renderer.
- New errors from the fix above (`calibration_start` / `calibration_apply_merge` while training) arrive as plain
  `error` messages, which the app already shows.

## Test runs

- `daemon/scripts/run-tests.sh`: Detection 111 passed, Vision 44 passed, Integrations 55 passed (one skipped test),
  Acoustics 77 tests with 17 failures, all in `SonarField` / sonar real-scene / sonar performance tests. Another agent
  was editing `GhostkeysAcoustics/SonarField.swift` during this run (my first build failed with "modified during the
  build"); ghostkeysd has no test target, and nothing in this commit touches GhostkeysAcoustics.
- `tests/e2e` (port 47961, scratch `.build-v15`): 117 passed, 4 skipped, 1 failed. The failure was `test_rate_limited_feedback_does_not_cancel_pending_taps` timing out while waiting 20 s for its setup calibration to finish, with the load average at 14 from other agents; run again alone it passed. The new test passed in the full run.
- `tests/e2e/test_learning_fixes.py` alone: 8 passed (7 from the commit plus the new one).

## Files changed by this check

- `daemon/Sources/ghostkeysd/App/Daemon.swift`: the fix for finding 1.
- `tests/e2e/test_learning_fixes.py`: test 8.
- `docs/PROTOCOL.md`: the retrain paragraph.
- `tests/e2e/REPORT.md`: see the note below.

Note on `tests/e2e/REPORT.md`: my first single-test pytest run rewrote it before I had saved a copy, so the
uncommitted version that was in the working tree is lost. I restored the committed version (`git show HEAD:...`), saved
a copy of that, and restored it after every later run.
