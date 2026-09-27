# Tap detection audit (27 Sep 2026)

Scope: `daemon/Sources/GhostkeysDetection` (onset, gates, features, classifier, gesture grammar), plus the parts of the daemon and app that decide what the user sees. Trigger: after real use the user called detection "very rudimentary", "false detecting things", "not able to know what I'm doing", "sloppy, noisy and weird".

Every number here comes from the user's own data, replayed by the new benchmark (`daemon/analysis/bench/run.sh`). Terms:

- **Recall**: share of real taps accepted with the right zone.
- **Wrong zone**: share of real taps accepted as another zone.
- **False accept**: a tap fired for something that was not a tap (a keystroke, a bump) or for the wrong zone.
- **In-session**: the model is tested on taps from the same calibration it was trained on (held out).
- **Cross-session**: the model is trained on one calibration and tested on another calibration's taps. This is what live use looks like when posture, surface or tap strength differ from calibration day.

---

## Corrections (added after `VERIFY_07_DETECTION.md` and `DETECTION_ROUND2.md`)

The numbers below are right; some of the credit and two costs were wrong. Where this list and the text disagree, this list wins.

1. **Handling taps (2.2 to 0 per minute) were removed by the tail-guard fix, not the familiarity guard.** The tail fix alone takes them to 0, and turning the guard off leaves them at 0. Sections 1.3, 4.2 and the table in section 5 say the guard "now catches them"; it does not.
2. **The saved-model win (0.165 to 0.014) comes from `ZoneModel.upgraded()`**, which tightens the reject distance when an old model loads. The guard adds nothing to it (section 1.1 and 4.4).
3. **The guard's one measured win** is cross-session false accepts with retrained models, 0.055 to 0.033. It also cost 1.6 points each on `robust.sens0.2` and `robust.sens0.8` (half of the 3.3 points reported there).
4. **Strict mode did switch on in normal use** (section 4.4 says 0%). 10.5% of real lap taps arrived while it was on, and 61% of calib2 taps when one typing spike got past the gates before each. Round 2 feeds the guard only confident taps: now 9.5% and 0%.
5. **The upgrade cost the live model 3.4 points of in-session recall**, not "at most 0.2" (that holds for freshly trained models only). Round 2 adds per-zone reject distances on upgrade: the cost is now 1.8 points (0.953 as saved, 0.935 upgraded), with the saved-model false accepts unchanged at 0.014.

---

## 1. The answer

1. **The model only knows the session it was calibrated in, and it does not know that it doesn't.** Applied to another session's taps it picked the right zone 0 to 56% of the time, yet fired a confident wrong zone or accepted a typing spike for 6.8% of all candidates. With the model files the user actually has, that was 16.5%. The in-session score the app shows (0.90) hides this completely. Main cause: the live model's reject distance was set by one outlier, 31.2 against a normal spread of 10, so it rejected nothing. **Fixed tonight:** cross-session false accepts fell to 3.3% (1.4% with the user's saved models).
2. **Double-taps, the user's only bindings, were nearly impossible on a lap.** A guard meant to ignore a tap's own ringing blocked the second tap of any quick double. The second tap then triggered 20 to 70 ms late and was rejected. Composed doubles made from real taps fired 0 of 19 times. **Fixed tonight:** 14 of 19 (74%).
3. **Taps fired while the laptop was being handled.** On the lap recording this was 2.2 false taps per minute during repositioning, each at 0.9 to 1.0 confidence. **Fixed tonight:** 0.
4. **The app shows every tap, bound or not, plus tilts.** The HUD (the pop-up that names the gesture) fires on every gesture event. That includes palm and edge taps with no binding, and tilt gestures (5 fired while repositioning on the lap). This is most of the "noisy" feeling, and it is a daemon/app change (spec in section 6).
5. **Calibration measures the wrong thing.** Each zone is 20 taps in about 10 s, in one posture, then scored with a shuffled cross-validation. It cannot see posture drift, softer live taps or doubles. A guided training session (section 6.6) is the most valuable next step, because it gives the data every further improvement needs.

Honest costs of tonight's changes: in-session recall moved at most 0.2 points; recall with the onset threshold shifted fell 3.3 points (2 of 61 lap taps); slowest-tap latency rose from 108 to 112 ms (p90, meaning 90% of taps are faster).

---

## 2. Before and after

`daemon/analysis/bench/run.sh --compare daemon/analysis/bench/results/2026-09-27-before.json`. "Before" is the library as it was at the start of tonight. Both runs are saved in `daemon/analysis/bench/results/`.

**Precision (lower is better)**

| Metric | Before | After |
|---|---|---|
| Cross-session false accepts per candidate, models retrained from the 3 calibrations | 0.068 | **0.033** |
| Same, with the model files the daemon saved (the live model is calib2's) | 0.165 | **0.014** |
| calib2 model: typing negatives from calib1 accepted | 0.129 | 0.065 |
| calib2 model: typing negatives from calib_bak accepted | 0.122 | **0.000** |
| calib_bak model: calib2 taps accepted as a wrong zone | 0.158 | 0.117 |
| Lap recording: taps fired while handling the machine, per minute | 2.25 | **0.00** |
| Lap recording scored by other sessions' models: wrong zone | 0.022 | **0.000** |
| Composed doubles: stray gestures | 6 | 1 |
| Desk at rest, taps per minute | 0 | 0 |

**Recall and doubles (higher is better)**

| Metric | Before | After |
|---|---|---|
| Composed grille doubles that fire (real lap taps, 250 ms apart) | 0.000 | **0.737** |
| Lap recording: onset recall (labelled taps the detector finds) | 0.869 | **0.902** |
| Lap recording: recall, 5-fold | 0.856 | **0.872** |
| calib1 in-session recall | 0.687 | 0.685 |
| calib_bak in-session recall | 0.735 | 0.735 |
| calib2 in-session recall | 0.928 | 0.928 |
| Estimated grille double success, calib1 / calib2 | 0.536 / 0.800 | 0.524 / 0.798 |
| Recall, onset threshold moved to sensitivity 0.2 / 0.8 | 0.869 / 0.902 | 0.836 / 0.869 |
| Recall with taps 0.6x as strong as calibrated | 0.885 | 0.885 |

**Look-ahead** (the "Composed doubles" rows): with it switched off, 74% of doubles followed by a key press 150 ms later still fire; with it on, 0%. Plain doubles are unchanged, so it costs nothing.

**Latency**: onset to tap event median 80 ms (unchanged), p90 108 to 112 ms.

---

## 3. The benchmark (the gate for every change)

`daemon/analysis/bench/`, one command: `run.sh` (build and run, about 10 s), `--save`, `--compare`, `--src` (benchmark another copy of the library), `--settings` (any `DetectionSettings` as JSON). It uses only the library's public API, exactly as the daemon does: `Trainer` to train, `TapEngine` to detect, `classifyDetailed` plus `minConfidence` to decide. `fetch-data.sh` copies new calibrations and diagnostics from the daemon's folder; it only copies.

| Suite | Data | What it answers |
|---|---|---|
| `cv.*` | calib1, calib_bak, calib2 (features only; 142 to 152 samples, 11 to 49 typing negatives each) | In-session recall, wrong zone, negatives accepted, 10x repeated stratified 5-fold |
| `cross.*`, `xsaved.*` | Same three, train on one, test on the others | What happens when live conditions differ from calibration |
| `s1.*` | session1.gkrec: 117 s lab recording, laptop on a lap, 3 zones, raw IMU | Real engine end to end: onset recall, recall, handling false taps, latency |
| `s1x.*` | session1 through the other calibrations' models | Cross-session on raw data |
| `robust.*` | session1 replayed with the threshold moved and taps scaled 0.6x | Do features depend on where the onset triggers |
| `splice.*` | Real grille taps from session1 composed into doubles on the real desk rest recording | Double-tap success, look-ahead cancel |
| `rest.*`, `diag.*` | 12 s desk rest recording; the two feedback_missed diagnostics | Junk taps at rest |

**Limits, stated plainly.** There is no raw recording of typing, trackpad use, desk taps, or real double-taps. The calibrations store features, not signals. The splice suite is semi-synthetic: real taps, composed timing. session1's handling windows were read off the recording by hand (section 4.2). Differences of one tap (0.016 on session1) are noise. The guided training session (6.6) fixes most of this.

---

## 4. Stage by stage

### 4.1 Onset (OnsetDetector)

How it works: a 15 Hz high-pass on accel, magnitude as the "level", an adaptive noise floor, trigger at max(17.5 mg, 6 x noise). Then pulse tracking, a 160 ms width limit, a ringing-tail guard, and a burst lockout.

**Failure: second taps of doubles triggered late. Fixed.**
- The tail guard said: for 300 ms after a pulse ends, a new onset must be twice the highest level of the preceding 25 ms.
- That window contains the new tap's own rising edge. A real rise grows about 1.5x per sample (measured every second sample: 3, 8, 20, 41, 63 mg), never 2x, so the guard blocked the whole rise until it expired.
- Result: composed doubles 300 ms apart triggered 22 to 67 ms late (median 55 ms). Only 9 of 18 second taps were accepted, against 12 of 13 of the same taps when isolated.
- Fix: compare against the tail from 30 to 10 ms before the sample. One ringing swing always falls in that span, so ringing still cannot retrigger (the existing test `ringingTailDoesNotRetrigger` still passes). Doubles went from 0% to 74%.
- New test: `PrecisionTests.secondTapOfADoubleTriggersOnTime` runs the old and new rule on the same stream.

**Not a failure: the "missed" lap taps.** The 6 labelled taps with no candidate are all left-palm taps at 17 to 21 s. The lab tool's simple detector marked them mid-pulse inside 200 to 250 ms rocking pulses; the engine's candidates are 150 to 440 ms away. This is label noise.

**Open:** a quiet-before-tap test was checked and rejected. Real lap taps are not isolated: left-palm taps have rocking up to 5x their own peak in the 300 ms before them.

### 4.2 Gates (typing, trackpad, burst, motion)

How it works: a key down 450 ms before to 80 ms after the onset rejects it, as does a key up within 150 ms, pointer activity within 150 ms, 4 onsets in 0.5 s, sustained rotation, or a pulse over 160 ms.

**Failure: nothing looked ahead.**
- A spike just before typing (palms landing on the palm rest) or just before pointer use passed every gate, because the gates only look backwards (plus 80 ms).
- Fix: a key down or pointer event within 300 ms after a multi-tap zone's tap now cancels its pending double or triple. Those gestures already wait out the double window, so this adds no delay.
- Immediate zones cannot look ahead without adding delay. They have no binding for this user; see 6.1.

**Failure: the pointer gate is blind to most trackpad use (daemon, spec 6.3).**
- `InputMonitor` reads only `mouseMoved`, `leftMouseDown` and `scrollWheel`.
- Drags (`leftMouseDragged`), right clicks, mouse up, force clicks, and three- and four-finger swipes produce no pointer event, so taps during them are not gated.
- The Force Touch trackpad also makes haptic clicks that vibrate the chassis.

**Failure: handling on a lap. Fixed.**
- Measured on session1 in the windows without intended taps: 0.5 to 11 s, 15.3 to 17.2 s, 28 to 47.5 s and 74 to 75.2 s.
- Left out: 11 to 15.3 s, which holds a run of real practice taps 0.5 s apart.
- Three events fired at 0.89 to 1.0 confidence: 3.75 s (46 mg, left-palm), 38.07 s (a grille, while the machine sat 25 degrees tilted), and 41.01 s (inside a second-long disturbance).
- The motion gate only sees rotation within 0.5 s, not a posture that has changed and stayed. The familiarity guard (4.4) now catches them: 2.2 to 0 per minute.

### 4.3 Features (FeatureExtractor)

**Failure: key features depend on where the onset triggered.**
- Taps on this machine ring at about 25 to 35 Hz: the whole chassis on its support.
- The impulse (features 0 to 2) is a 15 ms integral from the threshold crossing, about half a period. Its sign flips with small shifts in alignment, and alignment moves with tap strength and noise.
- Evidence: the median impulse direction on z flips between sessions for the same zone. Left-grille is -0.84 in calib1 and +0.93 in calib2; calib_bak reads -0.94 for every zone and for typing.
- Energy ratios shift by up to 4.8 within-zone standard deviations between calib2 and the others.

**Failure: `ringFrequency` and the band energies are artifacts.**
- The median "ring frequency" is 23 to 31 Hz for every zone in every session. That is the DFT's second bin (24.9 Hz), where the search starts.
- The 80 ms window is not detrended, so the lowest bins win. These five features still separate zones within a session (dropping them costs 9 points of in-session recall), but they shift between sessions.

**Tested and not shipped:**
- Peak-aligned integrals (research item B2): anchor on the first envelope peak. Lost on 8 to 9 metrics: lap recall, doubles 0.737 to 0.632, and junk taps at rest.
- Dropping the spectral, impulse-direction or energy-ratio features: always worse cross-session or in-session.
- A feature redesign can only be judged on cross-session raw data, which does not exist yet (6.6).

### 4.4 Classifier and confidence (ZoneModel)

How it works: kNN plus a Gaussian (LDA) posterior over whitened features, averaged with a logistic regression. Platt scaling then maps the result to a confidence. A reject distance sends taps far from every zone to "none".

**Failure: no rejection in practice. Fixed.**
- The reject distance was max(1.3 x q95, 1.1 x max) of the held-out spread, where q95 is the 95th percentile and "held-out spread" means how far calibration taps sit from their zone's centre when they were not used for training. On calib2 the max term (one outlier) gave 31.2 against a q95 of 10.0.
- New models: q99 of the held-out spread. With the familiarity guard doing the cross-session work, this keeps the doubles; 1.3 x q95 was also measured (section 5).
- Models saved by older builds are upgraded when the engine loads them (`ZoneModel.upgraded()`). Their spread is estimated from the stored samples (leave-one-out) and the reject distance is only ever tightened. This is what took the user's saved models from 16.5% to 1.4% cross-session false accepts without recalibrating.

**Failure: confidence is calibrated inside the session.**
- Platt scaling is fitted on shuffled folds of 20 consecutive taps, so 0.95 means "95% right if nothing changed since calibration".
- Refitting it on time-blocked folds did not help: cross false accepts 0.068 to 0.085.

**Fix: `FamiliarityGuard`.**
- It keeps the distance of the last 8 classified candidates (10 minutes memory), in units of the calibration's typical distance.
- In-session candidates have a median ratio of about 1. Cross-session ones sit at a median 0.40 to 1.21 of the reject distance, against 0.16 to 0.33 in-session.
- When the median passes 1.8 the guard enters strict mode, where a tap needs confidence at least 0.9 and distance at most 3 typical.
- Measured: strict mode engaged on 0% of in-session candidates and 65% of cross-session ones.
- `TapEngine.isUnfamiliar` exposes the state for the app (spec 6.4).

**Tested and not shipped:**
- A per-zone strength range (reject taps under 0.5x the zone's p10 or over 2.5x its p90): no gain once the reject distance was tight.
- Margin rules: a pure precision/recall trade, no better than raising minConfidence.
- A separate tap vs non-tap model with negatives pooled across calibrations (research item B4): on held-out sessions it still passed 37 to 91% of typing negatives and lost 1 to 30% of taps, so it cut accepted negatives only from 8 to 6 of 182.

### 4.5 Gesture grammar

- Doubles, triples, rhythm and sequence rules are sound. Their failure was upstream (4.1).
- New: `cancelPending()` for the look-ahead (4.2).
- The weak follow-up rule (second tap at 0.5 confidence may complete a double) stays. Every double still needs one tap at minConfidence, and in strict mode the weak tap also needs 0.9.
- **Open:** the double window is a fixed 350 ms, and nobody knows this user's double-tap rhythm. The calibration has no doubles, so it cannot be learned yet (spec 6.6).

### 4.6 Calibration

Evidence from the sample timestamps (the calibration files keep them):

- **Blocked:** each zone's 20 taps are consecutive, 0.4 to 0.6 s apart, done in 10 s, in one posture. The model learns "what the machine felt like during those 10 s".
- **Scored with shuffled cross-validation.** Within one session, testing on the last 40% of each zone's taps gives about the same accuracy. Across sessions it collapses (section 1), and the calibration never measures that.
- **Every spike during a zone phase becomes a sample of that zone.** A keystroke or bump during capture is labelled as the zone; only a 0.25x-median strength filter protects it.
- **Typing negatives are thin:** 11 in 39 s for calib2. The 17.5 mg floor does not hear most keystrokes, so only the strong ones are learned.
- **Tap strength differs by session:** grille peaks were 33 to 42 mg (calib1), 22 to 24 mg (calib_bak) and 55 to 75 mg (calib2).
- **No doubles, no posture labels, no lap and desk in one model.**

### 4.7 Feedback and learning from use (daemon)

- `feedback_missed` adds samples straight into training. Earlier, 3 wrong samples dropped right-grille accuracy from 0.93 to 0.87 (`analysis/README.md`).
- Learn-from-use is **on by default**. A tap that fired an action and was not undone within 5 s is added as a positive. A false double that changes the volume, which the user then simply turns back, is learned as a real tap. With false accepts as high as they were, this can reinforce errors. No confirmed taps have been stored yet (`model/confirmed.json` does not exist).
- Diagnostics record `sinceKey` and `sinceMouse` but not key-up times or which pointer event happened, so a replay cannot reproduce every gate.

### 4.8 What the user sees

- The HUD shows every gesture event: plain taps in unbound zones and tilt gestures included. The user's bindings are grille doubles only, so almost everything the HUD shows is noise by definition.
- `tiltEnabled` is on in the daemon's engine regardless of bindings. On the lap recording, 5 tilt gestures fired during repositioning.

---

## 5. What was tried tonight, and the verdict

| Change | Verdict | Deciding numbers |
|---|---|---|
| Tail guard compares with the tail before the rise (10 ms skip) | **Shipped** | Doubles 0 to 0.737, lap recall +1.6 points, handling false taps to 0 (with the guard) |
| Familiarity guard | **Shipped** | Cross false accepts 0.055 to 0.033 on top of the others; in-session recall unchanged |
| Reject at q99 of held-out spread, old models upgraded on load | **Shipped** | Saved models 0.165 to 0.014 cross-session; in-session recall -0.2 points at most |
| Look-ahead cancel of pending doubles (keys, pointer) | **Shipped** | Doubles followed by a key or pointer event 0.737 to 0; no cost |
| Reject at 1.3 x q95 | Not shipped | Slightly better cross-session (0.031), but 2 of 19 doubles lost |
| Strict-mode distance cap 1.5 x typical | Not shipped | Lap recall -4 points |
| Per-zone strength range | Not shipped | No gain once the reject distance is tight |
| Platt scaling on time-blocked folds | Not shipped | Cross false accepts 0.068 to 0.085 |
| Dropping spectral, direction or energy features | Not shipped | Worse in-session or cross-session |
| Peak-aligned integrals (B2) | Not shipped | Loses on 8 to 9 metrics |
| Pooled tap vs non-tap gate (B4) | Not shipped | Negatives 8 to 6 of 182 at best; up to 30% of taps lost |
| Quiet-before-tap test | Not shipped | Real lap taps are not isolated |
| Jerk features (B1) | Not tested | Needs raw typing data; features need recalibration |
| Time-shift augmentation (B3) | Not tested | Needs raw calibration windows; the daemon now saves them, none exist yet |
| MacTap's "vertical means typing" (B5) | Not adopted | Palm and lid taps are vertical here too |

Unit tests: 88 pass (7 new in `PrecisionTests.swift`). The daemon and lab tool build unchanged against the library.

---

## 6. Specs outside the detection library

### 6.1 HUD: only what fires (app and daemon; highest value, smallest change)
- Show the HUD only for gestures that matched an enabled binding (the daemon already knows: it resolves bindings). Everything else goes to the Sensors screen, not the HUD.
- Add a "show every detection" toggle for testing, off by default.

### 6.2 Tilt only when bound (daemon)
- `engine.tiltEnabled = config.bindings.contains { $0.enabled && $0.gesture.hasPrefix("tilt_") }` in `applyConfigToEngine()`.

### 6.3 Complete the pointer gate (daemon, `InputMonitor.snapshot`)
- Include `leftMouseDragged`, `rightMouseDragged`, `otherMouseDragged`, `rightMouseDown`, `otherMouseDown`, `leftMouseUp` and `rightMouseUp` in `mouseIdle`.
- Include the gesture (29), magnify (30), swipe (31), rotate (18) and pressure (34) event types, if `CGEventSource.secondsSinceLastEventType` accepts them on macOS 14+ (check each; Apple does not document these raw values).
- Pass key-up idle time and a "which pointer event" code into `DiagnosticsRecorder`, so replays can reproduce the gates.

### 6.4 Tell the user when taps look unfamiliar (daemon and app)
- Broadcast `TapEngine.isUnfamiliar` on change: `{"type":"detection_state","unfamiliar":true}`.
- App: a quiet banner, for example "Taps don't look like your calibration. Only clear taps will work. Calibrate in this position?", with one button that starts a calibration for the current posture (6.7).

### 6.5 Learn-from-use off by default (daemon)
- Default `learnFromUse = false` until the training session exists.
- When on, confirm only taps whose `FamiliarityGuard` state was familiar and whose distance is at most 1.5 typical. A confirmed sample should come from the calibrated conditions, never from strict mode.

### 6.6 Guided training session, run in the morning (app, daemon, detection)

Purpose: give the model the data it lacks, and give the benchmark the recordings it lacks.

**Protocol (about 40 prompts, the user follows on-screen cues):**
1. **Posture tag first.** The app asks "desk" or "lap"; the daemon also stores the gravity vector (the low-passed accel at rest) and the noise floor for the session.
2. **Interleaved zones, not blocks.** Prompts cycle through the enabled zones in random order, one tap each, with a 1.5 to 3 s random gap. Target 12 taps per zone per posture.
3. **Doubles in the user's own rhythm.** For each multi-tap zone, 8 prompts "double-tap here": store both taps and the gap. Detection sets `doubleWindowMs` to the 95th percentile of the user's gaps plus 80 ms, clamped to 250 to 500 ms. The second taps become training samples too, because they look different (they ride on the first tap's ringing).
4. **Soft and firm.** Half the prompts say "lightly", half "normally", so the model sees the strength range the user will really use.
5. **Negatives with context:**
   - 30 s of real typing (a prompt sentence);
   - 20 s of trackpad use (move, click, drag, scroll, swipe);
   - 10 s of "rest your palms, lift them, rest again";
   - 10 s of "pick up your drink, put it down".

   Each is labelled `none` with its phase name. Skip the input gates while capturing (as today), but store the key and pointer event times with them.
6. **Second posture.** Repeat steps 2 to 5 on the lap (or desk), if the user agrees.

**Storage (daemon):**
- Keep raw windows, 0.1 s before to 0.35 s after, for every captured candidate. The daemon started saving these tonight as `model/raw/*.gkrec`. Also keep the whole session as one continuous `.gkrec` with segments, so the benchmark can replay it end to end with real timing.
- Keep a negative bank across calibrations: all `none` samples with their raw windows, capped at 500.

**Scoring shown to the user:**
- Train on posture A's first half and test on its second half (time order), and test on posture B. Report "on the desk: 94% right, on your lap: 81% right" instead of one shuffled number.

**What it unlocks (detection):**
- Time-shift augmentation (B3).
- Re-extracting features when the extractor changes: the model stores a feature version, and old sessions are recomputed from raw.
- Jerk features (B1) and an evaluation of peak alignment on real cross-posture data.
- Learned double rhythm.
- Per-posture models (6.7).

### 6.7 Per-posture models (daemon, detection)
- Store one model per posture tag, with its gravity vector.
- At runtime, pick the model whose gravity vector is closest to the current one (within 15 degrees), else the last used. The familiarity guard stays as the safety net.
- Library side: a `ZoneModelSet` holding models plus their gravity vectors, with `select(gravity:)`. `TapEngine` tracks gravity internally (`GravityMonitor`); it needs a public read-only accessor for this.

### 6.8 Calibration capture quality (daemon)
- During a zone phase, drop a candidate if a key or pointer event happened within 450 ms before it or 300 ms after it (the look-ahead). Today such spikes become samples of that zone.

---

## 7. Ranked plan from here

| # | Fix | Owner | Why this rank |
|---|---|---|---|
| 1 | HUD only for bound gestures; tilt only when bound (6.1, 6.2) | App, daemon | Most of the "noisy" feeling, no risk, small change |
| 2 | Ship tonight's detection fixes (done in the library) | Detection | Measured wins above; old models upgrade automatically |
| 3 | Complete the pointer gate (6.3) | Daemon | Drags, right clicks and swipes are ungated today |
| 4 | Learn-from-use off by default (6.5) | Daemon | Stops errors from reinforcing themselves |
| 5 | Guided training session with raw storage (6.6) | App, daemon | Unblocks every remaining improvement and the benchmark's missing data |
| 6 | Unfamiliar banner (6.4) | App, daemon | Turns silent strict mode into something the user understands |
| 7 | Per-posture models (6.7) | Daemon, detection | Needs 6.6 data first |
| 8 | Feature v2: jerk, alignment, detrended spectrum, time-shift augmentation, measured on 6.6 data | Detection | Only judgeable once cross-posture raw data exists |

---

## 8. Files changed tonight

- `Onset/OnsetDetector.swift`: tail guard compares with the tail before the rise.
- `Classifier/ZoneModel.swift`: q99 reject distance, `typicalDistance`, `upgraded()` for older models.
- `Classifier/FamiliarityGuard.swift`: new.
- `Engine.swift`: upgrade on model assignment, guard in the decision, look-ahead cancel, `isUnfamiliar`, `familiarity`.
- `Gestures/GestureGrammar.swift`: `pendingLastTap`, `cancelPending()`.
- `Tests/GhostkeysDetectionTests/PrecisionTests.swift`: new.
- `daemon/analysis/bench/`: new benchmark, results in `bench/results/`.

**Public API:** all additive. `TapEngine.model` is still a stored `ZoneModel?`, now with an observer. New: `TapEngine.familiarity`, `TapEngine.isUnfamiliar`, `ZoneModel.typicalDistance`, `ZoneModel.upgraded()` and `FamiliarityGuard`. Models saved by older builds decode unchanged.
