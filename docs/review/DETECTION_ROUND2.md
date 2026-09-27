# Tap detection, round 2 (27 Sep 2026)

Follow-up to `DETECTION_AUDIT.md` and `VERIFY_07_DETECTION.md`. Scope: the two costs VERIFY_07 found (strict mode switching on in normal use, and recall lost when old saved models are upgraded), plus benchmark checks so those costs stay guarded.

## Verdict

1. **Strict mode no longer switches on because of junk.** The familiarity guard now learns only from candidates the classifier is at least 80% sure are a tap of some zone (counted before the reject distance). With one typing spike past the gates before every tap, the share of taps arriving in strict mode fell from 61% to 0% with a fresh calib2 model, and from 60% to 9% with the live-style (upgraded, saved) calib2 model. Its one measured win is kept: cross-session false accepts 0.033 before, 0.034 now (one candidate out of 849), against 0.055 with no guard.
2. **The upgraded live model loses half as much recall.** `upgraded()` now also gives each zone a reject distance scaled to that zone's own spread, never tighter than before. The live model's calibration (calib2) went from 0.919 to 0.935 in-session recall (0.953 before any upgrade). The saved-model false-accept win is untouched: 0.014 before and after (12 of 849 candidates).
3. **Not fixed, stated plainly:**
   - On the real lap recording, 9.5% of taps still arrive in strict mode (10.5% before). What remains is caused by real taps that sit 2 to 3 typical distances from the calibration (warm-up taps, and taps in the grille phase that the lab tool did not label), not junk. It cost no lap taps.
   - The grille zones still lose 0.5 to 1 point on the upgraded live model (left 0.855 to 0.850, right 0.990 to 0.980). That is 1 to 2 held-out evaluations out of 200, below what this data can resolve.
   - With two typing spikes past the gates before every tap, the live-style model still spends 42% of taps in strict mode (91% before). That model is confident about more typing spikes than a fresh one, and a spike it would fire on is fair evidence.
4. Benchmark checks added; `DETECTION_AUDIT.md` corrected; 96 detection tests pass (7 new).

## Before and after

`daemon/analysis/bench/run.sh --compare daemon/analysis/bench/results/2026-09-27-after-rerun.json`. "Before" is the library as `2026-09-27-after.json` measured it (tonight's first round plus VERIFY_07's look-ahead fix), re-run with the new checks (`2026-09-27-after-rerun.json`; every metric that also exists in `2026-09-27-after.json` is identical). "Now" is `2026-09-27-round2.json`. Against `2026-09-27-after.json` itself: 0 better, 2 worse (the two cross-session rows below), everything else equal.

**Strict mode in normal use (lower is better)**

| Metric | Before | Now |
|---|---|---|
| Real lap taps arriving in strict mode, own model (`guard.s1.strictAtTap`) | 0.105 (32/305) | 0.095 (29/305) |
| calib2 taps arriving strict, 1 typing spike before each, fresh model | 0.612 | **0.000** |
| Same, 2 spikes | 0.911 | **0.000** |
| calib2 taps arriving strict, 1 spike, upgraded old-style model (live-style) | 0.597 | **0.087** |
| Same, 2 spikes | 0.912 | 0.416 |
| calib1 / calib_bak, 1 or 2 spikes, any model | 0.000 to 0.024 | 0.000 to 0.006 |

**Precision (lower is better)**

| Metric | Before | Now |
|---|---|---|
| Cross-session false accepts, retrained models (no guard: 0.055) | 0.033 (28/849) | 0.034 (29/849) |
| Same, the daemon's saved model files | 0.014 (12/849) | 0.014 (12/849) |
| Upgraded live-style model, typing negatives accepted in-session | 0.100 | 0.100 |
| Upgraded live-style model, wrong zone in-session | 0.000 | 0.003 (4 of 1300 evaluations) |
| Upgraded old-style calib1 model, typing negatives accepted | 0.013 (4/310) | 0.016 (5/310) |
| Handling taps on the lap, per minute | 0.000 | 0.000 |

**Recall (higher is better)**

| Metric | As saved | Before | Now |
|---|---|---|---|
| Upgraded live-style model (calib2), in-session | 0.953 | 0.919 | **0.935** |
| ... right-edge | 1.000 | 0.940 | **1.000** |
| ... top-strip | 0.995 | 0.900 | **0.955** |
| ... right-palm | 1.000 | 0.935 | **0.950** |
| ... left-palm | 0.955 | 0.940 | 0.940 |
| ... left-edge | 0.900 | 0.900 | 0.900 |
| ... left-grille (bound) | 0.855 | 0.850 | 0.850 |
| ... right-grille (bound) | 0.990 | 0.980 | 0.980 |
| Upgraded old-style calib1 / calib_bak | 0.698 / 0.755 | 0.667 / 0.705 | 0.669 / 0.707 |
| Composed grille doubles that fire | | 0.737 | 0.737 |
| Same, with the guard forced strict (`splice.strict.double.success`) | | 0.632 (12/19) | 0.632 (12/19) |
| Freshly trained models, in-session (calib1 / calib_bak / calib2) | | 0.685 / 0.735 / 0.928 | same |
| Lap recall, 5-fold | | 0.872 | 0.872 |

"Live-style model": the user's saved model cannot be scored in-session (it was trained on every tap), so, as in VERIFY_07, the benchmark uses 10 x 5 fold models trained the old way (no ensemble, old reject rule) on each calibration and scores the held-out fifth.

**Size of one event.** calib2 in-session: one tap is 0.8 points (130 taps, each scored 10 times). A zone of 20 taps: one tap is 5 points; right-edge has 10 taps, so 10 points. One composed double is 5.3 points; one lap tap is 1.6 points of lap recall and 0.33 points of the strict share. Cross-session: one candidate is 0.1 points.

## What changed

### 1. What feeds the familiarity guard (`FamiliarityGuard.swift`)

- **Old rule:** every classified candidate went into the guard's median, including spikes the classifier had already called "none" (a keystroke) or barely believed. A few of those between real taps pushed the median past 1.8 typical distances.
- **New rule:** a candidate is evidence only if the classifier is at least `evidenceConfidence` (0.8, the default `minConfidence`) sure it is a tap of some zone:
  - an accepted zone at that confidence, or
  - a candidate the reject distance turned away although the zone vote alone was that sure. `ZoneModel.Result.zoneConfidence` now reports that vote. A tap that looks like a zone but sits too far from it is the cross-session symptom, so it must count.
- Unchanged: window 8, memory 10 minutes, threshold 1.8, strict mode needs confidence 0.9 and at most 3 typical distances.
- The old behaviour stays available: `familiarity.evidence = .everyCandidate`.

Why 0.8 and not another floor: it is the existing "would fire" bar, not a fitted value. The alternatives, all measured:

| Evidence rule | Cross false accepts | Lap strict share | calib2 strict, 1 / 2 spikes (fresh model) |
|---|---|---|---|
| Every candidate (old) | 0.033 | 0.105 | 0.612 / 0.911 |
| Zones at confidence 0.5 only | 0.038 | 0.059 | 0.023 / 0.113 |
| Zones at confidence 0.8 only | 0.042 | 0.052 | 0.000 / 0.000 |
| Zones or rejected, zone vote at least 0.5 | 0.032 | 0.105 | 0.027 / 0.113 |
| **Zones or rejected, zone vote at least 0.8 (shipped)** | **0.034** | **0.095** | **0.000 / 0.000** |
| Same at 0.9 | 0.040 | 0.095 | 0.000 / 0.000 |

Rules that ignore rejected-but-confident taps get the lap share down to about 5%, but give back a quarter to a half of the guard's cross-session win, because many cross-session taps are exactly those.

**Leave one session out.** Cross-session false accepts split by the session being tested (models from the other two):

| Tested on | No guard | Old rule | New rule |
|---|---|---|---|
| calib1 | 9/284 | 6/284 | 6/284 |
| calib_bak | 14/302 | 7/302 | 8/302 |
| calib2 | 24/263 | 15/263 | 15/263 |

The guard's win holds on each held-out session, and the new rule matches the old one within one candidate on each. With the saved model files: 2, 5, 5 before and 3, 5, 4 now.

A posture signal from gravity direction was considered. It is not possible yet: models do not store the gravity direction of their calibration (audit 6.7).

### 2. Per-zone reject distance on upgrade (`ZoneModel.upgraded()`)

Where the 3.4 points went on calib2 (live-style models, measured by switching one piece off at a time):

| Upgrade variant | calib2 in-session | Saved-model cross false accepts |
|---|---|---|
| Guard only, reject distance not tightened | 0.953 | 0.052 |
| Old upgrade (pooled 1.3 x q95) | 0.919 | 0.014 |
| Old upgrade without the confidence taper | 0.941 | 0.025 |
| **Pooled limit, plus per-zone limits never below it (shipped)** | **0.935** | **0.014** |
| Per-zone limits, allowed below the pooled one | 0.914 | 0.011 |
| Reject at the q99 of the exact out-of-fold spread (the new-model rule) | 0.952 | 0.039 |
| Refit the logistic member and Platt scaling from the stored samples | 0.928 | 0.032 |

- The guard costs the live model nothing in-session. The loss is the tighter reject distance: 1.2 points directly, 2.2 more through the confidence taper that old models apply in the outer 20% of the accepted region.
- One pooled limit does not fit every zone. On calib2 the wide zones (top-strip, right-edge, right-palm) lost 5 to 10 points; the grilles 0.5 to 1.
- **Shipped rule:** each zone also gets a limit scaled to its own spread. That is the zone's median leave-one-out distance times the pooled shape: 1.3 x the 95th percentile of every tap's distance divided by its own zone's median, the same level as before. A zone keeps the pooled limit when that is larger, and no limit exceeds the saved one. Stored as `ZoneModel.zoneRejectDistances` (optional, so older files decode).
- No new tuned numbers: 1.3 and the 95th percentile are the existing rule's; the per-zone scale comes from each model's own samples.
- **Why not the others:**
  - Removing the taper, or using the new-model q99 rule, recovers more recall but gives back part of the saved-model win (0.014 to 0.025 or 0.039). Old models' confidences are not calibrated, so the tight limit is their only defence against typing spikes: 33% of calib2's typing negatives are accepted at q99.
  - Letting per-zone limits go below the pooled one cost the right grille 11.5 points.
  - Refitting the ensemble from stored samples makes the old model behave like a fresh one. The right grille drops to 0.915, and cross-session false accepts rise to 0.032.

### 3. Benchmark checks (`daemon/analysis/bench/Sources/GuardSuites.swift`)

Printed by `run.sh` and saved in the results JSON:

- `upg.<calibration>.recall`, `.wrongZone`, `.negAccepted`, `.asSaved.recall` (info), and per zone for calib2 (`upg.calib2.zone.*`): upgraded old-style models, in-session, through the live decision.
- `upg.<calibration>.junk1/junk2.strictAtTap`: strict share with those models and typing spikes before each tap.
- `guard.s1.strictAtTap` (and `guard.s1.strictCandidates`, info): real lap taps arriving while strict.
- `guard.junk1/junk2.<calibration>.strictAtTap` and `.recall`: fresh models.
- `splice.strict.double.success`: composed doubles with the guard forced strict.

The `upg.*` rows need the old-style fold models in `daemon/analysis/data/oldstyle-folds/` (150 files, copied from `daemon/.build-bench/verify07/dump/`, which `verify07/run.sh` writes). Without them those rows are skipped with a message. The bench still builds against the pre-commit library (checked: 0 better, 0 worse against `2026-09-27-before.json`).

## Tradeoffs, honestly

- **Cross-session false accepts rose by one candidate** (0.033 to 0.034; pair calib2 model on calib_bak taps, 1 to 2 wrong-zone taps). Inside the noise, but it is a small give-back on the guard's only measured win.
- **The lap strict share barely moved** (10.5% to 9.5%). The remaining cases are real taps that do look different from the calibration. The guard is doing its job there, and those taps still fired. If this matters in daily use, the lever is the threshold or the window, and it should be tuned on the guided training session's data (audit 6.6), not on this one recording.
- **Strict mode still costs doubles when it is on:** 12 of 19 composed doubles fire when forced strict, against 14 of 19 normally. This round makes strict mode rarer; it does not make it cheaper.
- **The live model is still 1.8 points below its saved recall** in-session (0.935 against 0.953), in exchange for 70% fewer typing spikes accepted (37 to 11 of 110). Recalibrating once still gives the best result: a fresh model loses 0.2 points.
- **The upgraded live model makes one more kind of mistake:** wrong zone 0 to 0.003 (4 of 1300 evaluations, less than one tap), because the wide zones now accept a little further out.
- **Overfitting:** every number is still from 3 calibrations and 1 recording. This round added no fitted constants: the evidence floor is the existing `minConfidence` default, and the per-zone limit reuses the existing 1.3 x q95 level. The leave-one-session-out split above shows the guard change behaves the same on each held-out session. The per-zone upgrade helps all three calibrations (+0.2, +0.2, +1.6 points). Its precision cost is the two small rows above: one more typing negative accepted on calib1 (4 to 5 of 310 evaluations) and 4 wrong-zone evaluations on calib2.

## Files

- `daemon/Sources/GhostkeysDetection/Classifier/FamiliarityGuard.swift`: evidence rule (`evidence`, `evidenceConfidence`, `isEvidence`); the header credit is corrected.
- `daemon/Sources/GhostkeysDetection/Classifier/ZoneModel.swift`: `Result.zoneConfidence`, `zoneRejectDistances`, `rejectDistance(forLabel:)`, per-zone limits in `upgraded()`.
- `daemon/Sources/GhostkeysDetection/Engine.swift`: comments only.
- `daemon/Tests/GhostkeysDetectionTests/PrecisionTests.swift`: new suite `Round2Tests` (7 tests: junk does not make the guard strict, the old rule still does; confident far taps still do; memory expires without new evidence; rejected taps report their zone vote; keystroke spikes past the gates in a real engine stream; per-zone limits on a synthetic wide zone; new models unaffected) and one more check in `oldModelsAreUpgradedWhenLoaded`.
- `daemon/analysis/bench/`: `Sources/GuardSuites.swift` (new), `Sources/main.swift`, `run.sh` (usage text); results `2026-09-27-round2.json` and `2026-09-27-after-rerun.json`.
- `daemon/analysis/data/oldstyle-folds/`: the old-style fold models (data, gitignored).

**Public API:** additive only. `FamiliarityGuard.admit(_:model:t:)` keeps its signature. `ZoneModel.Result` gained an optional field with a default, so its memberwise initializer still accepts the old arguments. Models saved by any earlier build decode unchanged.
