# Tap detection, round 3: posture (27 Sep 2026)

Follow-up to `DETECTION_AUDIT.md` (6.7), `VERIFY_07_DETECTION.md` and `DETECTION_ROUND2.md`. Scope: the posture weakness (a desk calibration does not carry over to the lap), inside `GhostkeysDetection` only. The daemon wiring is specified at the end; nothing outside the library, its tests and `daemon/analysis` was changed.

## Verdict

1. **Per-posture models are built and measured. They fix cross-posture recall once the user has calibrated in each posture.** Lap taps through a desk + lap `ZoneModelSet`: recall 0.842, against 0.000 with a desk model alone. The desk stays on the desk model 100% of the time.
2. **Gravity alone is a weak posture signal on this machine.** While tapping on the lap it sat only 2 to 11 degrees from the desk. With gravity alone the lap model was live for 41 of 61 lap taps; every left-palm tap (2.3 degrees from the desk) got the desk model. So the set also switches on **tap evidence**: two taps in a row that sit far from the live model and close to another posture's model. With it, the lap model was live for 61 of 61 lap taps, and 0 of 890 desk candidates from other desk days caused a wrong switch.
3. **The gravity-aligned feature frame is not adopted.** It does not raise cross-posture recall: lap taps by desk models stay at 0 of 183 either way. It lowers the other direction (desk taps by a lap model, 21 to 11 of 180). Under leave one session out it never wins: 3 fewer right taps and 2 fewer wrong ones across the four sessions. The lap differs from the desk by how the machine moves on a soft support and how hard the user taps, not by which way is down.
4. **One trap, stated plainly: the user's saved samples carry no gravity.** A set of a legacy desk model (no gravity) and a new lap model puts the lap model live on the desk too (100% of the desk rest recording). The daemon must build a set only when every posture's model has a calibration gravity, which means one fresh desk calibration.
5. Everything else is unchanged: all 100 round-2 benchmark metrics are identical, 111 detection tests pass (15 new), and `ghostkeysd` and `ghostkeys-lab` build unchanged against the new library.

## What was built (library, additive)

| Piece | Where | What it does |
|---|---|---|
| `TapFeatures.gravity` | `API.swift` | Optional unit gravity direction at the candidate. `TapEngine` sets it on every candidate. Older JSON decodes; nil is not written. Because the daemon saves candidates' `TapFeatures` in `samples.json`, new calibrations keep their gravity with no daemon change. |
| `TapEngine.gravityDirection` | `Engine.swift` | The engine's low-passed gravity direction (200 ms, frozen for 150 ms after each onset). |
| `ZoneModel.calibrationGravity`, `.calibrationGravitySpread`, `gravityAngle(to:)` | `ZoneModel.swift` | Mean gravity direction of the training samples, and the 90th percentile angle of the samples from it. Optional: old model files load and classify exactly as before (tested). `Trainer` fills them when at least 5 kept samples, and at least half of them, carry gravity. |
| `ZoneModelSet` | `Classifier/ZoneModelSet.swift` | One model per posture. `update(gravity:t:moving:)` follows gravity; `observe(_:t:)` takes tap evidence; `activePosture`, `activeModel`, `gravityAngle`, `angles(to:)`, `select(_:)`, `resetSelection()`, `setModel(_:for:)`, `setZoneCenters(_:)`, `hasGravityForEveryModel`. Codable (models and tuning; the selection starts fresh). |
| `ZoneModelSet.train(_:)` | same file | Trains one model per posture from samples tagged with their posture (details below). |
| `TapEngine.modelSet`, `.activePosture`, `.postureGravityAngle`, `.setZoneCenters(_:)` | `Engine.swift` | Opt-in. With a set installed, the engine calls `update` on every gravity tick (about 100 Hz) and `observe` on every candidate before classifying it, and makes the chosen model the live `model`. Without a set, nothing changes. |

**Selection rules** (`ZoneModelSet`):

- **Gravity with hysteresis.** Another posture must be at least 5 degrees closer than the live one for 1 s without a break, and never while the machine is moving (the engine's motion gate). The first placement after start-up needs no hold.
- **Tap evidence** (`tapEvidence`, on by default):
  - A candidate counts only if some model is at least 80% sure it is a zone tap. Junk says nothing about posture.
  - It points at another posture when it sits more than 6 typical calibration distances from the live model, and within 2 of that posture's model, which accepts it as a zone.
  - Two such taps in a row, within 30 s, switch at once.
  - After such a switch, gravity cannot switch back until the machine has turned by the 5 degree margin. Otherwise a flat lap would flap between "gravity says desk" and "taps say lap".
- **Models without a calibration gravity** count as 15 degrees away. They are the fallback when the machine is far from every calibrated posture.
- One model: always live.
- The numbers 5, 1 s, 6, 2, 2 taps and 30 s are round numbers, not fitted. 6 and 2 were picked from the medians in the research table below: lap taps sit at 19.5 from a desk model and 1.05 from a lap model; another desk day's taps sit at 2.9 and 3.3.

**`ZoneModelSet.train` rules:**

- A sample without a posture counts as `legacyPosture` ("desk", the daemon's default).
- A posture with at least 20 zone samples gets its own model. With fewer, its samples still reach the other models as borrowed zones.
- Each model learns its own samples. It also learns the zone samples of zones it lacks from the other postures (`borrowZones`), and every posture's "none" negatives (`poolNegatives`).
- The calibration gravity comes from the posture's own samples only.
- If no posture qualifies, the result is one model trained on everything, as today.

## Numbers

Commands:

- `daemon/analysis/bench/run.sh --compare daemon/analysis/bench/results/2026-09-27-round2.json`. Saved as `results/2026-09-27-round3.json`: 141 metrics, of which the 100 from round 2 are bit-identical ("0 better, 0 worse").
- `daemon/analysis/bench/round3/run.sh`. The research table, saved as `results/2026-09-27-round3-frame.json`.

**Data and the size of one event:**

- session1 is the only raw lap recording: 117 s, 61 labelled taps in 3 zones (left-palm, right-palm, left-grille). The engine finds 55 of them. The three calibrations (calib1, calib_bak, calib2) are desk sessions from other days, features only, no gravity.
- `posture.*.s1`: 61 held-out lap taps x 3 desk calibrations = 183 evaluations. One evaluation is 0.55 points. One lap tap, repeated with all three desk models, is 1.6 points.
- `posture.*.rest`: the 12 s desk rest recording, with the same 15 sets, sampled every 0.1 s.
- `posture.deskTaps`: 890 candidates (taps and typing negatives of another desk day, across the 3 desk models). One candidate is 0.11 per 100.

**Which model is live, and what it costs** (the bench's new rows):

| Setup | Lap model live at lap taps | Lap recall through the set | Desk rest on desk model | Switches per minute on the lap recording |
|---|---|---|---|---|
| Desk model alone (`s1x.recall`) | n/a | 0.000 (0/183) | 1.000 | 0 |
| Lap model alone, same folds (`posture.ref.lapOnly`) | n/a | 0.869 (159/183) | n/a | 0 |
| Set, gravity only (`posture.gravityOnly`) | 0.672 (123/183, all 41 right-palm and grille taps) | 0.645 (118/183) | 1.000 | 0.51 |
| **Set, gravity + tap evidence (`posture.known`, the default)** | **1.000 (183/183)** | **0.842 (154/183)** | **1.000** | 1.54 |
| Same, desk samples without gravity (`posture.legacy`) | 1.000 | 0.842 | **0.000** | 1.03 |
| Default, but each model learns only its own samples (`posture.ownOnly`) | 1.000 | 0.869 (159/183) | 1.000 | 1.54 |
| Default, zones borrowed, negatives not pooled (`posture.noNegPool`) | 1.000 | 0.852 (156/183) | 1.000 | 1.54 |

- Wrong zone and taps while handling the machine: 0 in every row.
- Desk candidates from another desk day that switched a desk + lap set to lap: 0 of 890 (`posture.deskTaps.wrongSwitchesPer100` = 0).
- What the 1.54 switches per minute are: on every run, the same three switches (after the first placement):
  - desk to lap at 14 s, on the unlabelled practice taps;
  - lap to desk at 37 s, by gravity, while the machine was being repositioned (tilted up to 24 degrees);
  - desk to lap at about 58 s, on the first right-palm taps.

  No labelled tap arrived during the desk stretch.
- Other direction, for reference (`xpost.deskByLap`): a lap model on desk taps of the same zones gets 0.117 recall (21/180) and 0.089 wrong zone (16/180). A wrong switch to the lap model on a desk would be costly, which is why the evidence bar is strict.

**Gravity-aligned frame** (research, `round3/run.sh`). Every IMU sample was rotated so the lap's gravity (a causal 0.5 s low-pass) points where the desk's does, then all 33 features were recomputed. Check: gravity at the lap taps ends up 0.28 degrees from the desk's (at most 1.09). The desk calibrations need no rotation (their posture is the desk's; the daemon's live diagnostics from that evening match the desk rest recording to 0.1 degrees). So only lap data changes.

| Test | Sensor frame | Aligned | n |
|---|---|---|---|
| A: lap taps by the 3 desk models, recall | 0.000 | 0.000 | 183 |
| A: same, wrong zone | 0.000 | 0.000 | 183 |
| B: desk taps (lap zones) by a lap model, recall | 0.117 (21) | 0.061 (11) | 180 |
| B: same, wrong zone | 0.089 (16) | 0.083 (15) | 180 |
| B: desk typing negatives accepted | 0 | 0 | 91 |
| C: lap in-session, 5 x 5 folds, recall | 0.872 (266) | 0.869 (265) | 305 |
| D: leave one session out, held-out calib1, recall / wrong | 0.479 (58) / 0.058 (7) | 0.463 (56) / 0.050 (6) | 121 |
| D: held-out calib_bak | 0.206 (21) / 0.020 (2) | 0.196 (20) / 0.020 (2) | 102 |
| D: held-out calib2 | 0.008 (1) / 0.157 (19) | 0.008 (1) / 0.149 (18) | 121 |
| D: held-out session1 (lap) | 0.000 / 0.000 | 0.000 / 0.000 | 61 |
| D: typing negatives accepted (calib1, calib_bak, calib2) | 2/31, 2/49, 1/11 | same | |
| E: lap tap distance to the nearest desk zone, median, typical distances | 19.5 | 22.6 | 165 |
| E: lap taps within 3 typical distances (strict mode's limit) | 0 | 0 | 165 |

Adoption rule was "clearly wins under leave one session out". It does not win anywhere: recall ties on 2 held-out sessions and loses 2 and 1 taps on the other 2. Wrong zone falls by 1 on 2 sessions, and false accepts do not move. Calibration-to-calibration cross-session numbers cannot change (all desk, rotation 0), so they are not repeated.

**Why the frame does not help** (research rows F, E, G, H):

- The tilt is small. Median tilt from the desk at the lap taps: left-palm 2.3 degrees, right-palm 7.6, left-grille 10.6 (range 1.9 to 11.6). Rotating by that much moves a vector feature by at most a fifth of its size.
- The differences are large. Lap minus desk, in units of the desk's own within-zone spread (mean over the 3 zones and 3 calibrations):

  | Feature | Sensor frame | Aligned |
  |---|---|---|
  | twistY | 50 | 50 |
  | twistZ | 26 | 65 |
  | impulseX | 15 | 15 |
  | twistX | 14 | 15 |
  | xHat | 14 | 11 |
  | twistPerImpY | 12 | 12 |
  | peakGyroY | 12 | 11 |
  | twistPerImpZ | 11 | 19 |
  | peakGyroZ | 10 | 18 |

  - The machine rotates far more when tapped on a soft lap.
  - The user also tapped harder: median peak left-grille 33 mg on the desk against 158 mg on the lap, right-palm 120 against 617, left-palm 179 against 188.
  - Aligning the gyro mixes the large lap rotation into the z axis. That is why twistZ, twistPerImpZ and peakGyroZ get worse, and it outweighs the gain on xHat and yHat.
- Physics agrees: a finger pushes into the palm rest along the chassis' own normal, which tilts with the chassis. The sensor frame is already the natural frame for where the finger lands.
- **What does separate the postures is the taps themselves.**
  - Held-out lap taps sit nearer a lap model than a desk model 165 of 165 times (in each model's typical distances).
  - Held-out desk taps sit nearer their own desk model 352 of 353 times.
  - But desk taps from another desk day are nearer the desk model only 67% of the time (medians 2.9 and 3.3). Hence the strict evidence bar: 88.5% of held-out lap taps meet it with a desk model live; 0 of 667 other-day desk taps meet it the wrong way.
- The noise floor also differs: desk rest median 1.0 mg (p90 2.3), lap recording median 8.2 mg (p10 1.7). It overlaps at the edges, so it is not used. It could become a third signal later.

## Tradeoffs, honestly

- **Confounded data.** The only lap recording is also a different day, a different tool (the lab recorder) and much harder taps than the desk calibrations. "Lap versus desk" above is really "that lap session versus those desk sessions". The tap-evidence thresholds were chosen after seeing its medians. There is still no recording with the same user in both postures and known posture labels. The first guided two-posture calibration should re-run `round3/run.sh` and the `posture.*` rows before anyone tunes a constant.
- **The set costs lap recall against a lap-only model:** 0.842 against 0.869 (5 of 183 evaluations, about 2 distinct taps).
  - Own samples only gives 0.869.
  - Borrowed zones cost about 3 evaluations; pooled negatives about 2.
  - The defaults still borrow and pool. A lap model that has never seen a zone would force taps on it into another zone, and lap typing negatives do not exist yet. The bench cannot measure either benefit (session1 has only 3 zones and no typing), so this is a judgement, not a measurement. `ZoneModelSet.train(_:borrowZones:poolNegatives:)` lets the daemon choose.
- **Gravity switched to the desk model during repositioning** (37 to 58 s, every run). No labelled tap fell in that stretch. A tap made then would have needed two taps to switch back, the first scored by the desk model (on the lap, that means rejected, not misfired: 0 wrong zones).
- **Tap evidence needs two taps.** The first tap after a posture change is scored by the old model. On this data that means it is dropped (desk models accept 0 of 183 lap taps, wrong zone 0), not misfired.
- **Wrong-switch risk.** 0 of 890 other-day desk candidates, but a lap model live on a desk would be costly (wrong zone 0.089). If this shows up in use, raise `evidenceCount` to 3.
- **Day-to-day drift is not addressed.** Cross-session recall between desk days is still 0.118 (`cross.all.recall`, unchanged). The set picks between postures the user calibrated; it does not make one calibration generalise.
- **Overfitting:** the library change added no fitted constants to the existing pipeline (every existing metric is identical). All new constants are listed above as round numbers.

## Daemon wiring (for the next agent)

The TODO is in `daemon/Sources/ghostkeysd/App/Daemon.swift` in the `calibration_start` case (about line 723), not in `CalibrationSession.swift`. Nothing below is done yet.

**1. Keep gravity on every stored sample.** New calibration samples already carry it: the shadow engine's `.candidate(f)` goes straight into `CalibrationSession.add` and `samples.json`. Three places rebuild `TapFeatures` and drop it:

- `Daemon.swift`, `retrain(adding:label:reply:client:)`: `TapFeatures(values: f.values, t: 0)` becomes `TapFeatures(values: f.values, t: 0, gravity: f.gravity)`. Also pass `posture: engine.activePosture` to the `LabeledSample`.
- `Feedback/UseLearner.swift`, where `Confirmed(label:features:ts:)` is built: `TapFeatures(values: p.features.values, t: 0, gravity: p.features.gravity)`.
- `Daemon.swift`, `case "sim_tap"`: `TapFeatures(values: values, t: t, gravity: sample.features.gravity)` (test hook only).
- Confirmed samples have no posture field. Either add `posture` to `UseLearner.Confirmed` (set from `engine.activePosture` when the tap fired), or leave confirmed samples out of per-posture training.

**2. Train a set wherever a model is trained from `samples.json`.** That is `finishCalibration(_:)`, `rebuildModel(reason:then:)`, `retrain(adding:...)` and the learn-from-use rebuild (about line 1290). Replace the `Trainer` block with:

```swift
let tagged = samples.filter { !disabled.contains($0.label) }
    .map { ZoneModelSet.PostureSample(features: $0.features, label: $0.label, posture: $0.posture) }
let training = ZoneModelSet.train(tagged)   // defaults: legacy posture "desk", 20 zone taps per posture
let usable = training.set.postures.count > 1 && training.set.hasGravityForEveryModel
```

- If `usable`: install with `self.engine.modelSet = training.set`, instead of `self.engine.model = model`.
- Otherwise: keep today's single-model path exactly as it is.
- For the calibration report and recommendation in `finishCalibration`, use `training.reports[cal.posture]`. Keep `trainer.recommendedZones()` on a `Trainer` of that posture's samples.
- Send `training.borrowedZones[cal.posture]` so the app can say "right-grille on the lap uses your desk taps; calibrate it here too".

**3. The legacy case (the user's state today).** Old desk samples have no gravity, so the first lap calibration gives `hasGravityForEveryModel == false` and must not be installed as a set (measured: the lap model would be live on the desk). Keep the single model, and have the app ask once: "Calibrate on the desk again so Ghostkeys can tell desk from lap". After that desk calibration, both postures carry gravity and step 2 installs the set.

**4. Zone centres.** `applyZoneCenters()` does `engine.model?.setZoneCenters(config.zoneCenters)`. With a set installed that only reaches the live posture's model (a mutation of `engine.model` is written back into the set's active slot). Change it to `engine.setZoneCenters(config.zoneCenters)`, which reaches every posture model.

**5. Saving and loading.**

- Save the set next to the single model: `ZoneModelSet` is `Codable`. For example `model/zone-models.json`, via a `ConfigStore.saveModelSet(_:)` that uses the same `write(_:to:)` with its `.bak`.
- Keep writing `zone-model.json` too (the fallback posture's model), so older builds still load a model.
- At start-up (`init`, where `engine.model = store.loadModel()`): if `zone-models.json` decodes and passes the `usable` test, use `engine.modelSet = set`; otherwise use today's line.

**6. Tell the app** (additions to `docs/PROTOCOL.md`):

- In `status()`, add `"posture": engine.activePosture ?? NSNull()` and `"postureAngle": engine.postureGravityAngle.map(Self.r4) ?? NSNull()` to `detector`.
- In the sample loop, next to the `lastUnfamiliar` check, keep a `lastPosture` and broadcast `{"type":"detection_state","unfamiliar":..., "posture":"lap"}` when `engine.activePosture` changes. Log the switch.
- An optional `select_posture` message can call `engine.modelSet?.select(name)` through a small engine helper, if the app wants a manual override. `ZoneModelSet.select` exists; the engine does not wrap it yet. The simplest route: `var s = engine.modelSet; s?.select(p); engine.modelSet = s`.

**7. Leave alone.**

- The shadow engine (calibration capture) needs no set.
- The familiarity guard resets itself when the live model changes. That is correct: its distances are relative to the model.
- `engine.model` still returns the live model, so `engine.model?.classify(f)` for the Sensors screen keeps working.

**8. Verify after wiring:**

- `daemon/scripts/run-tests.sh` (all targets).
- `daemon/analysis/bench/run.sh --compare daemon/analysis/bench/results/2026-09-27-round3.json` (the library is unchanged by the wiring, so every metric must stay equal).
- Then a live check: calibrate on the desk, then on the lap. Watch `detection_state` switch within two taps of moving to the lap, and stay on the desk while typing.

## Files

- `daemon/Sources/GhostkeysDetection/API.swift`: `TapFeatures.gravity` (optional; init gains a defaulted `gravity:` parameter).
- `daemon/Sources/GhostkeysDetection/Onset/GravityMonitor.swift`: `direction`.
- `daemon/Sources/GhostkeysDetection/Classifier/ZoneModel.swift`: `calibrationGravity`, `calibrationGravitySpread`, `gravityAngle(to:)`.
- `daemon/Sources/GhostkeysDetection/Classifier/Trainer.swift`: keeps each sample's gravity; sets the model's calibration gravity.
- `daemon/Sources/GhostkeysDetection/Classifier/ZoneModelSet.swift`: new.
- `daemon/Sources/GhostkeysDetection/Engine.swift`: gravity on candidates, `gravityDirection`, `modelSet`, `activePosture`, `postureGravityAngle`, `setZoneCenters(_:)`.
- `daemon/Tests/GhostkeysDetectionTests/PostureTests.swift` (15 tests) and `PostureSynth.swift` (helpers).
- `daemon/analysis/bench/Sources/PostureSuites.swift` (new), `Sources/main.swift`, `run.sh` (`HAS_POSTURE`, usage text). A bench built against an older library skips the posture rows.
- `daemon/analysis/bench/round3/` (`run.sh`, `frame/main.swift`): the frame research. Builds into `daemon/.build-bench/round3/`.
- Results: `daemon/analysis/bench/results/2026-09-27-round3.json`, `2026-09-27-round3-frame.json`.
- `daemon/analysis/README.md`: a short round-3 section.

**Public API:** additive only. New optional fields decode from old files. `TapFeatures(values:t:)` still compiles, and `DetectorEvent` has no new case, so the daemon's exhaustive switches are untouched. Checked: `swift build --scratch-path .build-det3 --product ghostkeysd` and `--product ghostkeys-lab` build with no daemon change.
