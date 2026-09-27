# daemon/analysis

Numeric (plot-free) analysis of real lab recordings, used to tune `GhostkeysDetection`.

## Setup

```sh
cd daemon/analysis
python3 -m venv --system-site-packages .venv          # numpy, scipy, scikit-learn, pandas
../.build-lab/debug/ghostkeys-lab export ../../session1.gkrec --csv data/session1
```

`.venv/` and `data/` are gitignored: the data is regenerated from the `.gkrec` file.

## Files

- `gk.py`: loaders plus Python mirrors of the Swift code: detection level (15 Hz high-pass magnitude), gravity low-pass, onset detector, the 33 features. Keep it in step with `Sources/GhostkeysDetection` when that changes.
- `motion_gate_eval.py data/session1`: compares motion-gate variants. For each it reports how many recorded taps it would gate (bad) and how much of the repositioning period between phases it flags (good).
- `separability.py data/session1`: per-zone feature medians, and leave-one-out accuracy of LDA and 5-nearest-neighbours for 3 zones and for each zone pair. It runs on two tap sets:
  - the lab tool's recorded onsets;
  - every engine onset inside a capture phase, labelled with that phase's zone.

- `classifier_sweep.py data/calib1/samples.json`: compares classifier designs (kNN, shrinkage LDA, logistic regression, blends, class balancing) with repeated cross-validation. It reports tap recall, wrong-zone and false-tap rates at several confidence thresholds.
- `operating_points.py dump.tsv`: the same metrics for the real Swift classifier, from a dump made by the harness below.
- `harness/GentleEval.swift`: gentle and light taps, old fixed floor vs adaptive floor. It injects synthetic taps into the real rest recording, looped, and also rescales the lab recording's real taps. It reports onset recall, calibration, zone-correct taps and false taps per minute. Run it like the harness below.
- `harness/`: a temporary Swift test that cross-validates the live classifier path on a `samples.json`, and prints one TSV row per held-out sample. To use it:
  1. Copy both files into `Tests/GhostkeysDetectionTests/`.
  2. Run `ZZ_DROP=left-edge,lid scripts/run-tests.sh Detection -- --filter zzLivePath | grep '^ZZ' | sed 's/^ZZ //' > out.tsv`. Set `ZZ_DROP` to the zones you want left out, or leave it empty.
  3. Remove both files again. They read local user data, so they must not stay in the test target.

Copy the daemon's files before analysing them, and never modify the originals: `cp ~/Library/Application\ Support/Ghostkeys/daemon/model/*.json data/calib1/`.

## Real-data benchmark (27 Sep 2026, night): `bench/`

`bench/run.sh` replays every real recording and calibration through the library, as the daemon uses it, and prints recall, wrong zone, false taps and latency. It is the gate for every detection change: `run.sh --compare bench/results/2026-09-27-after.json`. `bench/fetch-data.sh` copies new calibrations and diagnostics into `data/` (copies only). Suites, data and limits: `docs/review/DETECTION_AUDIT.md`, section 3.

What it found and what was fixed (full table in the audit, section 2):
- **Models do not transfer across sessions, and say so with high confidence.** Train on one calibration, test on another: 6.8% of candidates became confident wrong zones or accepted typing spikes (16.5% with the saved model files). The live model's reject distance was 31.2 against a normal spread of 10. Now 3.3% (1.4%), through a q99 reject distance, an upgrade of old models on load, and `FamiliarityGuard` (strict mode when recent candidates sit far from the calibration).
- **The ringing-tail guard blocked the second tap of quick doubles** (it compared a rising tap with its own rising edge). Composed doubles from real lap taps: 0 of 19 fired, now 14 of 19.
- **Look-ahead:** a key press or pointer event within 300 ms after a grille tap cancels its pending double.
- Tried and rejected on this data: peak-aligned integrals, a pooled tap vs non-tap gate, Platt scaling on time-blocked folds, strength ranges, dropping feature groups, a quiet-before-tap rule (numbers in the audit, section 5).

## Posture, round 3 (27 Sep 2026): `bench/round3/`, `bench/Sources/PostureSuites.swift`

- `bench/round3/run.sh`: research, not a gate. Tests a gravity-aligned feature frame (every IMU sample rotated so the lap's gravity points where the desk's does) against the sensor frame on the lap recording and the calibrations, including leave one session out. Result: no gain, small losses; not adopted. Also measures how far lap taps sit from desk models, which features differ, and two other posture signals (tap distance, noise floor). Writes `bench/results/2026-09-27-round3-frame.json`.
- The bench's `posture.*` and `xpost.*` rows check `ZoneModelSet` (one model per posture, picked by gravity plus tap evidence) on session1 and the desk rest recording. Results: `bench/results/2026-09-27-round3.json`.
- Write-up and daemon wiring: `docs/review/DETECTION_ROUND3.md`.

## Classifier upgrade (27 Sep 2026): ensemble + calibrated confidence

The second real calibration (calib2) has 0.90 overall, but only 11 typing negatives, and 36% of them would be accepted as taps at 0.8 (before the typing gate).

**How it was tested.**
- `zonemodel_py.py` is a faithful Python port of the Swift classifier. It reproduces Swift's calib1 numbers to within 0.006.
- `ml_eval.py`, `ml_candidates*.py`, `ml_boost.py` and `ml_session1.py` screen ideas on identical folds (10 x repeated stratified 5-fold).
- The winner was then re-measured in Swift with `harness/ZZHarness.swift`.

**Measured on the real data** (recall / wrong zone / typing negatives accepted, at 0.8):

| Model | calib1 | calib2 | session1 |
|---|---|---|---|
| Current Swift model | 0.695/0.017/0.016 | 0.949/0.015/0.364 | 0.949/0.020/n.a. |
| Shipped: 50/50 with logistic regression (C 0.3) + Platt | 0.683/0.013/0.003 | 0.929/0.010/0.009 | 0.920/0.003/n.a. (Python) |
| Same plus boosted stumps | 0.681/0.028/0.006 | 0.913/0.009/0.009 | n.a. |
| Platt calibration alone | 0.626/0.009/0.013 | 0.936/0.012/0.200 | n.a. |
| Negative bank (other calibration's negatives), current model | no change | 0.952/0.016/0.345 | n.a. |

- The lab recording through the real engine is unchanged: 5-fold 52/61, with slightly fewer extra taps. The rest recording and the diagnostics are unchanged: no false taps.
- **Rejected or deferred:**
  - Boosted stumps: worse.
  - QDA: 10 to 20 samples per zone is too few.
  - Per-zone isotonic calibration: 1 to 4 errors per zone is too few.
  - Richer shape and spectral features: +3.5 recall points on session1 only. They can't be tested on the calibrations (only features are stored), they change the feature vector, and session1's zone blocks may confound them.
  - Time-jitter and noise augmentation, and posture features: they need raw calibration windows (see the daemon spec in the report).
  - Gain augmentation: rejected earlier (it tripled typing false taps).
## Double taps never detected: tail guard compared a tap with its own ring-up (26 Sep 2026, late night)

On Mac17,9 every double tap came out as a single tap: 9 of 9 real doubles (5 right palm, 4 left palm), so no
`double` binding could fire.
- **Cause:** for 300 ms after a pulse, the onset detector's ringing-tail guard required a new onset to exceed twice
  the highest level of the preceding 25 ms. Real taps ring up over several samples, so by the time the second tap of
  a double was large, the 25 ms before it held its own rising edge and it never reached 2x. The recordings show the
  second tap 155 to 200 ms after the first, peaking at 38 to 54 mg (trigger 17.5 mg), with the first tap's tail at
  7 to 9 mg just before it.
- **Not a fix:** turning the guard off. Every single tap also has a rebound 80 to 95 ms later that crosses the
  trigger, so every single tap would become a double.
- **Fix:** the guard's reference window is lagged: twice the highest level of the 25 ms that ended 25 ms earlier
  (`OnsetDetector.tailLag`). The rebound is still riding on the first tap's tail and fails; a real second tap comes
  after the tail has decayed and passes.
- **Replay of all 20 exported recordings of the evening, live model, all four zones waiting for multi-taps:**
  right-palm doubles 0 -> 4 of 4 detected as `double`; left-palm doubles 0 -> 2 (plus 1 `sequence`, 1 single: the
  second tap sometimes reads as right-palm); all 11 single-tap recordings unchanged (no phantom doubles).
- **Tests:** new `OnsetTests.doubleTapThatRingsUpIsTwoOnsets` (fails on the old detector); all 83 Detection tests
  pass (run through a converted plain-executable runner, since this machine's toolchain has no swift-testing).
- **Open:** the second tap's features include the first tap's tail in their pre-window, which may be why a left-palm
  second tap is sometimes classified as right-palm.

## Feature window anchored on the tap (26 Sep 2026, night)

**Not on `main`** (kept on branch `demo-fixes`, commit c6419e4): the real-data benchmark above rejected peak-aligned
integrals, and this change needs feature versioning. See DECISIONS.md, 27 Sep 2026.

A second user (Mac17,9) calibrated firm and then tapped at half that strength or less: most taps came out
`low_confidence`, and the left edge read as the right edge.
- **Cause:** the impulse, twist and DFT windows started 3 samples before the fixed-threshold crossing. Real
  taps ring up: the first half cycle is smaller than the rebound. Under ~50 mg the first half cycle stays below
  17.5 mg, the crossing lands one half cycle later, and impulse and twist flip sign. Replaying one user's firm
  left-palm taps with the motion scaled down: `impulseDirZ` +1.00 at 1x, -1.00 at 0.35x on every tap.
- **Fix:** the window starts at the first sample whose accel magnitude reaches 30% of the tap's own peak
  (`FeatureExtractor.anchorFraction`). The scaled replay keeps +1.00 down to 0.25x. `TapFeatures.version` is now
  2; models and samples without it are ignored, so old calibrations have to be redone.
- **Strength augmentation is now on** (0.4x, 0.6x, 1.6x, 2.5x). It failed before because a light tap was not a
  scaled copy of a firm one. Cross-session on the user's live taps (train on one session, test on the other,
  minConfidence 0.8):

  | | run 3 -> run 2 | run 2 -> run 3 | typing read as a tap |
  |---|---|---|---|
  | old window | 21/69 | 45/133 | 0/12, 3/9 |
  | old window + augmentation | 28/69 (16 wrong) | 53/133 | 5/12, 2/9 |
  | anchored | 21/69 | 58/133 | 0/12, 1/9 |
  | anchored + augmentation | 33/69 (3 wrong) | 65/133 | 0/12, 1/9 |

  Run 2 had no palm taps, so 96 of run 3's 133 are reachable. Small sets: 5 to 16 taps per zone per session.

## Regression after light-touch (26 Sep 2026, evening)

The user, still on a firm-tap calibration, reported taps "all over the place and mostly not registering".
- I replayed the user's real data through three builds with the live model: `harness/ReplayGkrec.swift` as a small executable next to a copy of `GhostkeysDetection`.
  - old: febb145;
  - new: the light-touch build the user ran;
  - fixed: light-touch off, and the weak-tap rule restricted.
- **Real desk recording (12 s):** candidates old 3, new 8, fixed 3.
  - Junk read as a grille at 0.5 to 0.8: old 0, new 2, fixed 0.
  - Under the weak follow-up rule those weak grille readings could start or close double-tap groups: false doubles, or real doubles broken apart.
- **The two "missed" diagnostics:**
  - one holds no tap at all (the pointer was moving the whole time);
  - in the other, the 30 mg spike is followed by trackpad movement 30 ms later. It is rejected as "trackpad" by all three builds, and the classifier reads it as left-grille.
- **feedback_missed** added 3 bad samples: a "right-grille" sample that looks like left-grille, and two "none" samples that look like confident lid and top-strip taps. They lowered right-grille from 0.93 to 0.87. The cleaned copy is `data/samples.cleaned.json`.
- **Now:** light-touch is behind `DetectionSettings.lightTouch` (off by default). A weak tap only joins its own zone's group after a strong tap, and never starts or breaks a group.

## Gentle taps (26 Sep 2026): adaptive onset floor (now opt-in: DetectionSettings.lightTouch)

The user had to tap very hard: the fixed 17.5 mg floor sat far above the 1 to 4 mg desk noise. The floor now adapts:
- **Learned floor:** half the 10th-percentile peak of the user's gentlest calibrated zone, clamped to 4 to 17.5 mg.
- **Quiet desk:** 6 mg, when noise has been under 3 mg for 300 ms with no key or trackpad use for 1 s.
- **Calibration capture:** also 6 mg.
- **Noisy conditions:** k x noise takes over, with k = 5.
- **Sensitivity:** scales everything by x0.5 to x2.

Results from `harness/GentleEval.swift` (60 s, 5 zones, typing negatives in calibration):

| Quiet desk | old: detected | old: right zone | new: detected | new: right zone |
|---|---|---|---|---|
| Gentle 8 to 15 mg | 0/39 | 0/39 | 37/39 | 4/39 |
| Light 15 to 40 mg | 30/39 | 30/39 | 39/39 | 32/39 |

- **Disturbed desk** (the recording's own desk-wobble stretches): light taps detected 25 of 35, versus 19 of 35 before.
- **False taps per minute** are the same as before on the looped rest recording (5, all from its real desk events). They are 0 while typing with key events, and 0 while typing with key events ignored (old: 2).
- **Lab recording** 5-fold went from 0.852 to 0.902.
- **Gentle taps cannot be told apart by zone.** At 8 to 15 mg the zone cues (twist near the 0.061 deg/s gyro step, impulse direction, ringing) are at the noise level: 46 to 50% cross-validated accuracy even with 3 zones. So gentle taps are now heard, but the classifier correctly declines most of them.
- **Tap strength does not carry over.** A model calibrated hard accepts only 58% of light taps; one calibrated light accepts 58% of normal taps.
  - Training on strength-scaled copies (0.7x/1.4x) fixed the second case on synthetic data (58 to 95%).
  - On the real calibration it tripled typing negatives read as taps (0.05 to 0.145), so it is off by default.
  - Calibrate at the strengths the user will really use.

## Findings from the first real calibration (calib1, 26 Sep 2026)

This calibration has 8 zones and 31 typing negatives. The report said 0.80 overall.

- **Why taps were dropped.** I simulated the live path with 10 repeated 5-fold runs:
  - Almost every drop was the minConfidence 0.8 gate, usually on a correct zone guess: left-grille 6 of 20, lid 9 of 20, right-grille 3 of 14.
  - The reject distance dropped 1 tap in 146, and "none" winning dropped 5.
  - The trigger threshold is not the cause for grilles: their captured peaks are 22 to 45 mg, against a floor of 17.5 mg. Lid may lose about 12%.
  - The user's only bindings are grille double-taps, and each double needed two taps at 0.8 or above.
- **Classifier variants did not help.** A different kNN/Gaussian mix, class-balanced votes, LDA, logistic regression and blends all sit on the same recall versus false-tap curve or worse. Class balancing raised false taps. The weak zones are the lever.
- **Operating points** (all zones, 5-fold x 10; false taps are per typing negative before the typing gate):

  | threshold | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
  |---|---|---|---|---|---|
  | tap recall | 0.82 | 0.80 | 0.75 | 0.70 | 0.62 |
  | wrong zone | 0.10 | 0.06 | 0.04 | 0.02 | 0.00 |
  | false taps | 0.20 | 0.10 | 0.06 | 0.02 | 0.01 |

  Without left-edge and lid:

  | threshold | 0.5 | 0.6 | 0.7 | 0.8 | 0.9 |
  |---|---|---|---|---|---|
  | tap recall | 0.95 | 0.95 | 0.93 | 0.91 | 0.84 |
  | wrong zone | 0.03 | 0.02 | 0.02 | 0.02 | 0.01 |
  | false taps | 0.33 | 0.21 | 0.11 | 0.05 | 0.02 |
- **Double-tap success**, estimated as per-tap probability squared, versus the weak follow-up rule:
  - All 8 zones: left-grille 0.56 to 0.81, right-grille 0.45 to 0.75.
  - Without left-edge and lid: left-grille 0.93 to 1.00, right-grille 0.57 to 0.76.

## Findings from session1 (26 Sep 2026)

This recording is partial: left-palm, right-palm and left-grille, with the Mac on a lap.

- **Motion gate.** On a lap, a palm tap rocks the machine. The 50 ms gravity estimate turned 1 to 6 degrees per tap, so the old gate (3 degrees within 0.5 s) gated 24 of 61 taps. The new gate gates 0 of 61 and still flags 67% of the repositioning period. It uses:
  - a 200 ms low-pass;
  - a 150 ms freeze after each onset;
  - a 150 ms persistence requirement.
- **Pulse widths, measured as time above half the pulse's own peak.**
  - Taps: left-palm 50 to 90 ms, right-palm 34 to 39 ms, grille 16 to 41 ms.
  - Handling the machine: mostly 150 ms or more.
- **Ground truth is incomplete.** The recorded onsets come from the lab tool's own simple detector. It missed long runs of regular 0.4 s-spaced taps, for example right-palm 48.8 to 61.7 s and grille 108.7 to 114.5 s. So "extra taps" in `replay` are mostly real, unlabelled taps.
- **Separability.** Leave-one-out LDA gives 0.97 for 3 zones, and 0.97 to 1.00 per pair on the recorded taps. With only the force-independent features it is 0.93 to 0.98.
- **Caveats.**
  - Each zone was recorded in its own block, so posture drift between blocks may help. An interleaved recording would settle it.
  - Right-palm taps were much harder than the others.
  - Left-palm twist is near zero where physics predicts negative.
  - Almost all spectral energy is below 60 Hz, so the band features carry little on this data.
