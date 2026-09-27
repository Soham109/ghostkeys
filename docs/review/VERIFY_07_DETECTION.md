# Verify 07: detection precision fixes (commit 693042b)

Date: 27 Sep 2026. Scope: the last detection commit ("real-data benchmark; tail-guard fix for doubles, tight reject distance, familiarity guard, input look-ahead; audit") and its claims in `docs/review/DETECTION_AUDIT.md`.

## Verdict

**The numbers are real and reproduce exactly. The changes are a net win and should stay. But the audit credits the wrong fix for two of its four headlines, and it leaves out two recall costs.** One small real bug was found in the look-ahead and is fixed here.

1. **Every claimed number reproduces to the third decimal**, from a clean build of both the old and new library. The 88 unit tests pass (89 with the new one).
2. **Wrong credit.** The familiarity guard is credited with ending false taps while the laptop is handled. It has no part in that. The tail-guard fix does all of it. The "saved models 0.165 to 0.014" win is also entirely the tighter reject distance applied on load. The guard's measurable win is one number: cross-session false accepts 0.055 to 0.033.
3. **Unreported cost 1: the live model loses recall.** The upgrade applied to the user's saved model (the one running now) costs 3.4 points of in-session recall on that calibration (0.953 to 0.919). The audit's "at most 0.2 points" is true only for freshly trained models. Most of the loss is on unbound zones; the grille zones lose 0.5 to 1 point.
4. **Unreported cost 2: strict mode does switch on in normal use.** The audit says it engaged on 0% of in-session taps, but that was measured only on shuffled calibration taps. On the real lap recording, with its own model, 10.5% of taps arrived while the guard was strict. It cost no taps there, but it costs 2 of 19 composed doubles when strict.
5. **Bug fixed:** a key press or pointer event that came 80 ms or more after a tap, but before a late decision on that tap, did not cancel the pending double (finding 4). This does not show up on the user's grille taps today; it would on zones whose taps ring longer.

---

## Reproduced vs claimed

Commands: `daemon/analysis/bench/run.sh --compare daemon/analysis/bench/results/2026-09-27-before.json` and `daemon/scripts/run-tests.sh Detection`. I also rebuilt both libraries from `git archive` copies (HEAD and HEAD~1) into a clean build folder. The old library reproduces `2026-09-27-before.json` exactly, and the new one reproduces `2026-09-27-after.json` exactly (0 better, 0 worse).

| Claim (audit) | Claimed | Reproduced | Match |
|---|---|---|---|
| Cross-session false accepts, retrained models | 0.068 to 0.033 | 0.068 to 0.033 | yes |
| Same, saved model files | 0.165 to 0.014 | 0.165 to 0.014 | yes |
| Handling taps on the lap, per minute | 2.25 to 0 | 2.248 to 0.000 | yes (credit wrong, finding 1) |
| Composed grille doubles that fire | 0 to 0.737 | 0.000 to 0.737 (14 of 19) | yes |
| Composed doubles, stray gestures | 6 to 1 | 6 to 1 | yes |
| Doubles followed by a key 150 ms / pointer 100 ms later | 0 (74% without look-ahead) | 0.000; 0.737 with look-ahead off | yes |
| Lap onset recall / 5-fold recall | 0.869 to 0.902 / 0.856 to 0.872 | same | yes |
| In-session recall calib1 / calib_bak / calib2 | 0.687 to 0.685 / 0.735 / 0.928 | same | yes |
| Recall with threshold moved (sens 0.2 / 0.8) | 0.869 to 0.836 / 0.902 to 0.869 | same | yes |
| Latency p50 / p90 (ms) | 80 / 108 to 112 | 80.4 / 108.0 to 111.7 | yes |
| Strict mode engaged in-session | 0% | 0 to 0.9% on calibration CV; **10.5% of real lap taps** | no (finding 3) |
| In-session recall cost of the reject change | at most 0.2 points | true for new models; **3 to 5 points for upgraded old models** | partly (finding 2) |
| Unit tests | 88 pass | 88 pass (89 after this pass) | yes |

---

## Findings, most important first

### 1. The credit for two headlines is wrong (fix the audit's story, not the code)

I rebuilt the library with one change undone at a time and re-ran the whole benchmark.

| Build | Handling taps/min | Saved-model false accepts | Cross false accepts | Doubles |
|---|---|---|---|---|
| Before | 2.248 | 0.165 | 0.068 | 0.000 |
| Tail fix only (old reject rule for new models, no guard, no look-ahead) | **0.000** | **0.014** | 0.068 | 0.684 |
| Shipped, but familiarity guard off | 0.000 | 0.014 | 0.055 | 0.737 |
| Shipped, but old tail rule | 0.435 | 0.014 | 0.033 | 0.000 |
| Shipped | 0.000 | 0.014 | 0.033 | 0.737 |

- **Handling taps:** the tail fix alone takes them to 0; turning the guard off leaves them at 0. The audit says the guard "now catches them" (sections 1.3, 4.2, 5). It does not.
- **Saved models 0.165 to 0.014:** this is `upgraded()` tightening the reject distance when a model loads. The guard adds nothing to it.
- **What the guard does do:** cross-session false accepts 0.055 to 0.033. It also costs 1.6 points of recall each on `robust.sens0.2` and `robust.sens0.8` (0.852 to 0.836, 0.885 to 0.869). That is half of the 3.3-point loss the audit reports there.
- Why it matters: anyone tuning or removing the guard later would expect handling taps to come back. They would not.

### 2. The live model's upgrade costs in-session recall, not reported

The user's saved models were trained before the ensemble existed and before the new reject rule. To measure this I trained old-style models (no ensemble, old reject rule, from the pre-commit library) on 4/5 of each calibration, 10 x 5 folds. Then I scored the held-out fifth as saved and after `upgraded()` with the guard on.

| Calibration | Recall as saved | Recall upgraded | Wrong zone | Typing negatives accepted |
|---|---|---|---|---|
| calib2 (the live model) | 0.953 | 0.919 | 0.015 to 0.000 | 37/110 to 11/110 |
| calib1 | 0.698 | 0.667 | 0.014 to 0.012 | 6/310 to 4/310 |
| calib_bak | 0.755 | 0.705 | 0.028 to 0.023 | 18/490 to 18/490 |

- The reject distance falls from a median of 29 to 10 on calib2. On the real saved file it goes from 31.2 to 10.4.
- On calib2 the loss falls on unbound zones: right-palm 1.000 to 0.935, top-strip 0.995 to 0.900, right-edge 1.000 to 0.940. Grilles: left 0.855 to 0.850, right 0.990 to 0.980.
- Verdict: a fair trade for this user (typing spikes accepted fall by 70%, and the bound zones barely move). But it should be stated, and the fix is still to recalibrate, because a fresh model gets the tighter limit at a cost of 0.2 points.

### 3. Strict mode does switch on during normal use

- **Real lap recording, its own model (5 x 5 folds):** 32 of 305 held-out taps (10.5%) arrived while the guard was strict. So were 1,487 of 3,775 candidates (39%), mostly during handling. Recall was the same with the guard off (266 of 305 both ways), because lap taps are confident.
- **Why:** the guard averages the distance of every classified candidate, including junk that the classifier already rejects. With 8 remembered candidates over 10 minutes, a few bumps or spikes that get past the typing gate are enough.
- **Junk test on the calibrations:** I put J of the session's own typing spikes before each held-out tap. With the calib2 model, J = 1 made 61% of taps arrive in strict mode and J = 2 made 91%. Recall moved only from 0.928 to 0.918, because calib2 taps are confident. With the calib1 and calib_bak models the typing spikes sit close enough that strict mode stayed off.
- **What strict mode costs when it is on:**
  - In-session recall if every tap had to pass strict: calib1 0.685 to 0.621, calib_bak 0.735 to 0.664, calib2 0.928 to 0.915.
  - Composed grille doubles with the guard forced strict: 14 to 12 of 19 (the weak second tap then needs 0.9).
- Not changed: tuning this needs live candidate streams, which do not exist yet (audit 6.6). Two cheap options to test once they do:
  - Feed the guard only candidates the classifier called a zone.
  - Have strict mode require several far candidates within a shorter memory than 10 minutes.

### 4. Look-ahead missed keys during a late decision (bug, fixed)

- **The problem:**
  - A tap is decided 80 ms after onset, or when its pulse ends if it rings longer (up to 160 ms).
  - The typing gate looks for keys up to onset + 80 ms.
  - The look-ahead only checked events first seen at the current sample, and only while a double was already pending.
  - So a key or pointer event between onset + 80 ms and a late decision was checked by nobody, and the double fired.
- **How common:** 21.8% of the real lap taps ring longer than 80 ms. The user's grille taps (as spliced) are decided at 80 to 82 ms, so this does not change any benchmark number today. It matters for any multi-tap zone with ringing taps, for example a palm double.
- **Fix** (`Engine.swift`): the look-ahead now checks every remembered key-down and pointer time after the last tap, not only the newest ones. Event times derived from the input snapshot are never later than the real event, so older keys cannot trigger it by mistake.
- **Test:** `PrecisionTests.keyDuringALateDecisionStillCancelsTheDouble` uses slow, lap-like taps decided 112 ms after onset, with a key and then a pointer event at 95 ms. It failed before the fix (the double fired) and passes after.
- **Bench after the fix:** identical to `2026-09-27-after.json` (0 better, 0 worse).

### 5. The look-ahead drops real doubles followed quickly by typing (by design)

- A key D ms after the second tap of a composed double: 100 ms 0/19, 200 ms 0/19, 300 ms and later 14/19 (same as no key).
- The audit's "no cost" holds for plain doubles. A user who double-taps a grille and starts typing within 0.3 s loses the gesture every time.
- This is the intended trade, but it is a behaviour the user will notice. It belongs in the docs or the HUD spec.

### 6. The reject distance does not throw away in-session taps; across sessions it is now the main reason for a miss

- **In-session**, the reject distance rejects 0 to 1.2% of held-out taps per calibration. Worst zone: calib1 right-grille, 2.9%.
- **Cross-session**, true-accept rate for retrained models is 0.126 to 0.118. With saved models it is 0.123 to 0.097.
  - The reject distance now turns away 34% of cross-session taps (56% with saved models); the guard turns away 21% (5%).
  - Worst per-zone drops with saved models: left-grille 0.100 to 0.050, left-palm 0.133 to 0.058.
- Cross-session recall was already near useless before (the model mostly picks the wrong zone or "none"), so rejecting is the right behaviour. It does mean a user whose posture changed sees taps ignored rather than misfired, which is what the guard's "unfamiliar" banner (audit 6.4) is for.

### 7. No train/test leakage, but every threshold was tuned on the test data

- **Checked suite by suite:**
  - `cv`: the model and its Platt scaling are fitted on the training folds only.
  - `cross` / `xsaved`: training and test sessions are different.
  - `s1`: the ground-truth features come from a capture pass with no model; each fold trains on 4/5 of the taps and scores the rest.
  - `splice`: the doubles are built from the grille taps held out of training.
  - No suite scores a sample it trained on.
- **Tuned on test:** q99, 1.3 x q95, the 0.94 factor, 1.8 / 0.9 / 3.0, and the hand-marked handling windows were all chosen on the same 3 calibrations and 1 recording they are scored on. No session was held back, so the wins are optimistic.
- **Small numbers:**
  - The handling result is about 3 events per run.
  - One composed double is 5.3 points.
  - One lap tap is 1.6 points.
- The "before" doubles total is 18 rather than 19, because the old onset detector found one grille tap fewer.

### 8. Numerical edge cases: safe

- **Empty model:** it answers "none", and the guard lets it through without recording anything.
- **One-zone model:** it trains and classifies; the typical distance and reject distance are finite.
- **NaN or infinite feature:** `classifyDetailed` returns a zone name with NaN confidence and NaN distance. It never fires, because every confidence comparison is false, and the guard skips non-finite distances.
  - Minor: a caller that trusts the zone name without checking confidence would be misled.
- **Typical distance of 0 or NaN:** the guard is disabled for that model rather than dividing by zero.
- **Model with fewer than 5 spread samples** (for example 2 taps per zone): it gets no typical distance and no upgrade. The guard stays off for it and its reject distance stays as loose as before.
- **Re-assigning an old model to the engine:** the upgrade runs once, and assigning it again does not reset or loop.

---

## What I changed

- `daemon/Sources/GhostkeysDetection/Engine.swift`: the look-ahead checks all remembered key and pointer times after the pending tap (finding 4). A four-line change plus a comment.
- `daemon/Tests/GhostkeysDetectionTests/PrecisionTests.swift`: new test `keyDuringALateDecisionStillCancelsTheDouble`. Detection tests: 89 of 89 pass.
- `daemon/analysis/bench/verify07/`: `run.sh` plus two programs. They reproduce every extra number in this report: per-zone rates with miss reasons, the old-model upgrade, guard engagement, strict-mode doubles and edge cases. `run.sh` builds into `daemon/.build-bench/verify07/` (gitignored) and reads the pre-commit library with `git archive f9645cd`, which changes nothing in the repo.
- Not changed: nothing loosened; no thresholds touched; `DETECTION_AUDIT.md` left as written (its misattributions are listed in finding 1); no new benchmark results saved (the numbers did not move).

## Recommendations

1. Correct the audit's credit for the handling result and the saved-model result (finding 1). The next tuning pass should know that the guard's only measured job is cross-session false accepts.
2. Add two metrics to the benchmark: in-session recall of upgraded old-style models, and the share of real in-session taps that arrive in strict mode. Then the costs in findings 2 and 3 are guarded like the rest.
3. When the guided training session (audit 6.6) produces live candidate streams, revisit what feeds the guard (finding 3).
4. Tell the user to recalibrate once. A fresh model gets the tighter reject distance at a cost of 0.2 points instead of 3.4.
