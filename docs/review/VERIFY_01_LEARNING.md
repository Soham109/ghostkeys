# Verify 01: learn from use + raw calibration windows

Date: 27 Sep 2026. Scope: `settings.learnFromUse` / `UseLearner` (confirmed taps, ship guard, merge relabeling) and
the raw calibration window recordings (`model/raw/*.gkrec`), per docs/PROTOCOL.md ("Feedback loop" section) and
`daemon/Sources/ghostkeysd/Feedback/UseLearner.swift` + `App/Daemon.swift`.

**Bottom line:** the core confirm/promote/retrain/ship-guard cycle works and is not easy to break head-on. But two
real, fairly serious bugs came out of the adversarial scenarios the review brief asked for, plus two smaller ones and
one thing worth knowing about the ship guard's limits:

1. **Recalibrating a subset of zones (e.g. "redo a zone that comes back weak", which the app's own UI and guide
   explicitly support) silently drops every other zone from disk and from the live model**, and as a side effect
   zeroes out their learn-from-use eligibility. This is the most impactful finding — it is not exotic, it is the
   documented recommended workflow for fixing one weak zone.
2. **`sim_undo` (Cmd+Z) discards every currently-pending confirmable tap, not just the one(s) behind the gesture it
   is meant to undo.** A single undo can wipe several seconds of unrelated, legitimate learn-from-use data.

Nothing here was fixed; this is a verification pass only. No source under `daemon/Sources/**` was modified.

## How it was checked

- Built the daemon into an isolated scratch dir: `cd daemon && nice -n 10 swift build --scratch-path .build-verify1
  --product ghostkeysd` (succeeds, 0 errors; 1 pre-existing warning in `Server/WebSocketServer.swift` unrelated to
  this feature).
- Read `docs/PROTOCOL.md` ("Feedback loop", `learnFromUse`, config sections), `Feedback/UseLearner.swift` in full,
  and the relevant slices of `App/Daemon.swift` (`onGesture`, `learnFromUseTick`, `adaptIfDue`, `finishCalibration`,
  `applyMerge`, `rebuildModel`, `saveRawWindow`/`flushRawCalibration`/`capDirectory`, the `sim_*` test hooks, and
  `ActionLimiter`).
- Wrote a standalone async Python probe (not part of `tests/e2e`, kept in my scratch dir) reusing
  `tests/e2e/harness.py` / `ws_client.py` against my own build, always with `--simulate-sensors
  --no-hardware-sessions --dry-run`, a throwaway `--config-dir`, and port 47980 (this machine is also running other
  overnight verification agents on their own ports/scratch dirs — confirmed via `ps aux`, no collisions). Drove real
  calibration (`sim_spike` with `live: true`), real gesture/action firing (`sim_tap`), `sim_undo`, `sim_adapt`, feedback
  messages, config changes, zone merges, and direct filesystem edits to `model/confirmed.json` between daemon
  restarts (never touching `~/Library/Application Support/Ghostkeys`).
- Regression check: `daemon/scripts/run-tests.sh` (all 4 Swift-testing targets) and the existing `tests/e2e` pytest
  suite (`GHOSTKEYS_E2E_SCRATCH=.build-verify1 GHOSTKEYS_E2E_PORT=47980`).
- Noted, but did not chase further for lack of a safe way to force it deterministically without editing daemon
  source: a 3-way async retrain race between `finishCalibration`, `applyMerge`/`rebuildModel`, and `adaptIfDue`
  (see "Also noted" below).

## Pass/fail

| # | Check | Result |
| --- | --- | --- |
| 1 | Build (`swift build --product ghostkeysd`) | PASS |
| 2 | `daemon/scripts/run-tests.sh` (all 4 suites) | PASS — 69+44+55+88 = 256 tests, 0 failures |
| 3 | `tests/e2e` pytest (existing suite, regression) | PASS — 105 passed, 4 skipped (Finder not frontmost; real-sensor restore; no light/lid sensor in simulation — all legitimate) |
| 4 | Happy path: confirmed taps accumulate, `sim_adapt` retrains and keeps a good model | PASS |
| 5 | Confirmed entries land in `model/confirmed.json` with `source: "confirmed"` | PASS |
| 6 | Cmd+Z at t≈4.9s (just inside the nominal 5s window) still cancels the pending tap | PASS — promotion only runs on the 1Hz tick, so there is real slack past 5.0s by design |
| 7 | Undo *after* a tap is already confirmed/promoted has no effect on `confirmed.json` | PASS — `cancelPending` only touches the in-memory `pending` list |
| 8 | `sim_undo` scoped to only the tap(s) behind the gesture it stands in for | **FAIL — bug 1** |
| 9 | Per-zone cap (`min(20, floor(calibrationCount * 0.5))`) | PASS — 45-sample calibration + 30 confirmable taps capped at exactly 20 |
| 10 | "Keep 1 in 3" throttle for taps at confidence ≥ 0.97 | **FAIL (minor, unconfirmed root cause) — bug 4**: 15 sent, 5 expected kept, 6 observed |
| 11 | `none` is never added to `confirmed.json` | PASS |
| 12 | `learnFromUse: false` blocks all confirmation and makes `sim_adapt` a no-op | PASS |
| 13 | `calibration_apply_merge` relabels confirmed entries via `UseLearner.relabel` | PASS for whichever zone's data was still on disk — but see bug 2, which is what determines that |
| 14 | Recalibrating a subset of zones does not affect other, previously-calibrated zones | **FAIL — bug 2** |
| 15 | Ship guard discards a confirmed set that would hurt calibration accuracy | PASS in one run, **FAIL (inconsistent) — bug 3** in an identical rerun |
| 16 | `feedback_missed`/`feedback_false` only cancel pending taps when actually admitted | **FAIL — bug 5** |
| 17 | `confirmed.json` truncated to half its bytes, daemon restarted | PASS — starts cleanly, empty confirmed set, fully responsive |
| 18 | `confirmed.json` replaced with garbage (`{not json at all[[[`), daemon restarted | PASS — same |
| 19 | Raw calibration windows written to `model/raw/<session>.gkrec`, folder capped at 20MB | PASS for the base case (file written, capped correctly for small sessions). Could not force the >20MB single-session case live in reasonable time — see bug 6 (static only) |

## Bugs

### Bug 1 (high) — `sim_undo` / Cmd+Z wipes ALL pending learn-from-use taps, not just the undone gesture's

`UseLearner.cancelPending(reason:)` (`Feedback/UseLearner.swift:66-71`) is:

```swift
func cancelPending(reason: String) {
    guard !pending.isEmpty else { return }
    Log.debug("learn-from-use: dropped \(pending.count) pending tap(s): \(reason)")
    pending.removeAll()
}
```

It is called identically from a real Cmd+Z (`App/Daemon.swift:1082-1085`), `sim_undo`, and both feedback messages
(line 727) — there is no way to scope it to "the tap(s) behind the gesture just undone." `pending` can hold taps from
several distinct, unrelated gestures at once (anything fired in the last 5s), so one undo clears all of them.

**Repro:** calibrated `right-grille`, bound it to a dry-run action, fired 12 confirmable `sim_tap` (each with
`ok: true`), then one more tap immediately followed by `sim_undo`. Waited 8s (past the 5s confirm window) and read
`model/confirmed.json`:
- One run: **0 of 12** legitimate taps survived (all still `pending` when undo fired, given the pacing used).
- Another run: only the **5** taps old enough to have already crossed the 5s promotion boundary survived; the rest
  (unrelated to the actual undo target) were lost, and this also dropped `newSinceTrain` below `retrainAfter` (10),
  silently skipping the next scheduled retrain too.

Real-world consequence: a burst of legitimate taps (e.g. several quick volume presses) followed within 5 seconds by
an unrelated real Cmd+Z in whatever app is frontmost (undoing a text edit that has nothing to do with Ghostkeys)
discards that whole batch of learn-from-use data.

### Bug 2 (high) — recalibrating a subset of zones destroys every other zone's calibration and model data

`ConfigStore.saveSamples` (`Config/ConfigStore.swift:146-148`) is an unconditional overwrite:

```swift
func saveSamples(_ samples: [LabeledSample]) throws {
    try write(JSONEncoder().encode(samples), to: samplesURL)
}
```

`finishCalibration` (`App/Daemon.swift:528-565`) calls it with `samples = cal.samples` — only the current
`CalibrationSession`'s own captured samples for the zones passed to *this* `calibration_start`. The same function's
`Trainer` is also fed only `samples` (line 542-544), so the freshly installed `engine.model` only knows the zones
just (re)calibrated.

This is not a theoretical misuse: `docs/guide/02-calibration.md` line 20 explicitly tells users to "**redo a zone
that comes back weak**," and the app's "Choose zones" step (`app/src/renderer/src/screens/Calibration.tsx`,
`beginCapture()`: `client.send({ type: 'calibration_start', zones: picked, target })`) lets the user pick any subset
— including just one zone — to (re)calibrate.

**Repro (live):** calibrated `right-grille` (20 samples) then, as a *separate* `calibration_start`/`calibration_zone`/
`calibration_finish` session, `left-grille` (20 samples) — exactly what "redo one zone" looks like over the wire.
Bound both zones to a dry-run action and sent 11 confirmable taps each. `model/confirmed.json` ended up with **10
`left-grille` entries and zero `right-grille` entries** (all silently dropped once `right-grille`'s calibration count
went to 0, since `promoteDue`'s cap is `min(20, Int(calibrationCounts[zone] ?? 0) * 0.5)` and the guard is
`cap > 0 else { continue }`). Then `calibration_apply_merge` on the two zones relabeled only `"samples": 20` — i.e.
only left-grille's — confirming right-grille's rows were gone from `samples.json`, not just from the confirmed set.

In the real app this means: `right-grille`'s bindings would stop firing entirely (the classifier can no longer emit
that label) the moment the user finishes recalibrating just `left-grille`, with no warning.

### Bug 3 (medium) — the ship guard is non-deterministic against the exact "poisoned confirmed data" scenario, because it only re-scores calibration samples

The review brief's suggested attack ("mislabeled via sim_tap with a wrong zone at high confidence") does not actually
work over the wire: `sim_tap`'s handler (`App/Daemon.swift` ~line 706) always pulls
`store.loadSamples().last(where: { $0.label == zone })` — i.e. it fetches the *real* calibration sample for whatever
zone you claim, so a wire-level "wrong zone" tap is always internally consistent (correct features for the zone it
claims). There is no protocol message that can construct a genuinely mislabeled (features, zone) pair; I had to seed
`model/confirmed.json` on disk directly, between two daemon runs, to build one.

**Repro:** stopped the daemon after a normal calibration, wrote 6 entries into `confirmed.json` with `label:
"right-grille"` but `features.values` scaled to `real*(-4)-5` (nowhere near the real cluster), restarted, drove 10
genuine confirmations live, then sent `sim_adapt`. Two runs, identical setup:

- Run A: `{"kept": false, "accuracyBefore": 1, "accuracyAfter": 0.95, "reason": "the updated model did worse on the
  calibration taps; confirmed taps discarded"}` — guard worked, `confirmed.json` back to 0 entries.
- Run B (same seed, same steps): `{"kept": true, "accuracyBefore": 1, "accuracyAfter": 1}` — the same poisoned data
  was silently folded into the live model.

This follows directly from how the guard is defined (`App/Daemon.swift:1096-1098`, `1116`): it only re-scores the
*original calibration samples*, not the confirmed ones. A poisoned point whose extreme feature values land in a
region the calibration samples don't cover can shift the model (creating a new, wrong decision region somewhere) with
no effect on calibration accuracy at all — whether it does is sensitive to exactly where those values fall relative
to the trainer's decision surface, which is why the two runs disagreed. The guard defends "the new model still
recognizes your real calibration taps," not "the new model is not corrupted."

### Bug 4 (low, unconfirmed root cause) — possible off-by-one in the "keep 1 in 3 of very-confident taps" throttle

`UseLearner.register` keeps a tap at confidence ≥ `highConfidence` (0.97) only when `highCounter[zone] % 3 == 1`
(`Feedback/UseLearner.swift:52-56`) — 1 in 3. Sending 15 `sim_tap` at `confidence: 0.99` on `right-grille` should
keep 5 (positions 1, 4, 7, 10, 13). I measured **6** kept. `right-grille` is one of the zones the daemon logs as
"needing multi-tap" at startup, which routes taps through `SessionCoordinator.holdTapGesture`'s up-to-150ms
hold-for-tap-type path before `onGesture` runs. I did not have time to confirm whether that path can occasionally
double-count one tap into `register()`, or whether this is an artifact of the test harness (e.g. a retried send after
a transient timeout). Flagging for a follow-up rather than asserting a cause.

### Bug 5 (medium) — `feedback_missed`/`feedback_false` cancel pending taps even when the message itself is about to be rejected by the rate limiter

```swift
case "feedback_missed", "feedback_false":
    learner.cancelPending(reason: type)
    guard admitFeedback() else { return sendError("\(type): at most one every 2 s and 20 per minute", to: c) }
```

(`App/Daemon.swift:726-728`) — `cancelPending` runs unconditionally, *before* the rate-limit check. Confirmed live:
sending two `feedback_missed` back to back gets `{"type":"error","message":"feedback_missed: at most one every 2 s
and 20 per minute"}` for the second one, but the cancel already ran as a side effect of that same, supposedly-refused
message. Combined with bug 1's blast radius, a client that retries a rejected feedback call, or a user who
double-clicks "Missed a tap" / "That wasn't me" in the app, wipes pending confirmations twice over for no additional
reason — the second wipe is pure collateral damage from a message that did nothing else.

### Bug 6 (low, static analysis only — could not force live) — the 20MB raw-window cap can delete the file it just wrote

`capDirectory` (`App/Daemon.swift:1184-1197`) sorts every file in `model/raw/` oldest-first and removes from the
front while the running total exceeds `maxBytes` (20MB). The just-written session file sorts last (newest), so if
*that single new file alone* is already ≥ 20MB, the loop still reaches and deletes it too, since removing every older
file still leaves the total over budget. Per docs/PROTOCOL.md, a raw window is 0.1s before to 0.25s after every
captured tap (zones and negatives) at ~800Hz; a large multi-zone calibration (target up to the protocol's 500 max)
could plausibly produce a single session file over 20MB. I could not build a calibration large enough to trigger this
live within a reasonable time budget (would need on the order of thousands of captured taps in one session), so this
is flagged from reading the code, not from a confirmed repro.

## Also noted (not independently confirmed live)

**A 3-way async retrain race with no version guard.** Three separate call sites each kick off an async retrain on a
background queue and, on completion, unconditionally do `self.engine.model = model` with no check that nothing more
recent has happened in the meantime: `finishCalibration` (line 528), `applyMerge`/`rebuildModel` (line 949, used by
merges, `calibration_apply_recommendation`, and zone-enable toggles via `config_set`), and `adaptIfDue`'s
learn-from-use retrain (line 1099). `adaptIfDue` guards its *start* on `calibration == nil`, but nothing re-checks
that condition — or that `engine.model` is still the same reference it started from — once the background training
finishes; whichever of the (possibly several) in-flight retrains finishes last wins, regardless of which was started
last. I read this clearly in the code but did not find a way to force the interleaving deterministically from a
black-box WebSocket client without adding an artificial delay to the daemon's training path, which would mean
editing `daemon/Sources/**` — out of scope for a verification pass. Recommend either a monotonic "model epoch"
counter checked before each of the three completion handlers applies its result, or serializing all three retrain
paths through one queue/flag.

## Confirmed working (no repro needed beyond the pass/fail table)

- `confirmed.json` corruption resilience is solid: `UseLearner.init`'s `try? Data(contentsOf:)` /
  `try? JSONDecoder().decode(...)` swallow both truncation and garbage JSON and just start with an empty confirmed
  set — no crash, no hang, fully responsive daemon either way.
- `none` is never added to the confirmed set, both by construction (`register()`'s `$0.zone != ZoneModel.noneLabel`
  filter) and in practice.
- `learnFromUse: false` fully suppresses confirmation and makes `sim_adapt` inert.
- No existing automated test exercises any of `learnFromUse` / `UseLearner` today: neither `tests/e2e/*.py` nor
  `tests/e2e/sdk_scenario.mjs` sends `sim_undo`, `sim_adapt`, or drives `sim_tap` far enough to reach
  `promoteDue`/`adaptIfDue` (checked with grep). This review's probe is the only exercise these paths have had; worth
  turning at least the happy path, bug 1's repro, and bug 2's repro into permanent regression tests.
