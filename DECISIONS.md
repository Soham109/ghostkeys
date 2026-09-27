# DECISIONS.md: decision log

Short, dated entries for non-obvious technical or design choices: what was chosen, over what, and why. Newest at
the top. Add an entry whenever such a choice is made (see CLAUDE.md). Entries marked "reverse-engineered" were
inferred from code, comments and docs during onboarding, not recorded by the person who made them.

Format:

```
## YYYY-MM-DD: title
- Decision:
- Instead of:
- Why:
- Consequences / revisit if:
```

---

## 2026-09-26 (late night): Lagged reference window for the onset tail guard
- Decision: after a pulse, a new onset must exceed 2x the highest level of the 25 ms window ending 25 ms before it
  (`OnsetDetector.tailLag = 20` samples), instead of the 25 ms immediately before it.
- Instead of: removing the guard (every single tap's 80 to 95 ms rebound would become a double tap), or a minimum
  re-tap interval (a hard tap's decaying ring could then re-trigger once the interval passed).
- Why: real taps ring up, so the old window compared a second tap with its own rising edge; 0 of 9 real doubles
  were detected. With the lag: 6 of 9 became doubles, no single-tap recording changed. Details in
  `daemon/analysis/README.md`.
- Revisit if: hard taps start producing phantom doubles (watch `double` gestures after single taps in `--log-taps`).

## 2026-09-26 (late night): Do not drop ringFrequency/decay features to fix live misses
- Decision: keep the feature set; fix the right-palm misses by recalibrating in the real posture instead.
- Why: the live taps' largest deviations were ringFrequency (~1 Hz shift, huge in z because calibration spread was
  0.7 Hz) and decayTime, but retraining with those (and pulse width, and all spectral shape) ignored still left 2 of
  5 live taps as `none 1.00`, and some variants lowered calibration recall or raised typing-as-tap. The taps differ
  from calibration broadly, not in one feature.
- Revisit if: after a fresh calibration, taps again fail as soon as the laptop is moved; then ringFrequency
  (whole-laptop rocking mode) is a candidate for ZoneModel.TrainingOptions.ignored with more data.

## 2026-09-26 (late night): Four zones on Mac17,9: both palm rests and both edges
- Decision: enable left-palm, right-palm, left-edge, right-edge; disable both grilles, top strip and lid. Keep
  minConfidence 0.8.
- Instead of: the previous set (left-palm, left-edge, right-edge, lid) with bindings on the disabled grilles, or
  all 8 zones.
- Why: exhaustive 5-fold cross-validation on this Mac's saved taps, counting only taps at confidence >= 0.8:
  this set had weakest-zone recall 87%, 1% wrong zone, 5% of typing read as a tap; with the lid instead of the
  right palm, 14% of typing was read as a tap; all 8 zones gave a weakest zone of 37%. Minimum confidence 0.7
  did not raise recall. These are calibration-session taps, so live numbers will be lower.
- Revisit if: `--log-taps` shows a zone failing live, or after a fresh calibration with more taps per zone.

## 2026-09-26 (late night): Bindings are double taps
- Decision: all tap-zone bindings on this Mac use `double`.
- Why: it needs two taps in the same zone within 350 ms, so a single stray spike or palm bump cannot fire an
  action. The cost is recall (both taps must be accepted; a second tap at 0.5 or more still counts).
- Revisit if: live logs show many doubles broken by one rejected tap; then consider `tap` for low-risk actions.

## 2026-09-26 (late night): Per-tap diagnostics as an opt-in flag, not always on
- Decision: `--log-taps` (and `pnpm dev:taps`) prints one line per spike and per gesture outcome; off by default.
- Instead of: always logging, or showing it only in the app's Sensors screen.
- Why: every keystroke makes a spike, so always-on output floods the terminal; the terminal is where the person
  debugging already is. Spikes seen by the gate-free shadow engine give rejected taps a zone guess and a runner-up.

## 2026-09-26 (night): Feature window anchored on the tap's own peak; feature versioning (uncommitted)
- Decision: impulse, twist and DFT windows start 3 samples before the first sample reaching 30% of the tap's peak
  (`FeatureExtractor.anchorFraction`). `TapFeatures.version` = 2; models and samples of other versions are ignored.
- Instead of: anchoring on the fixed 17.5 mg threshold crossing.
- Why: real taps ring up, so a tap under ~50 mg crossed the threshold one half cycle late and its impulse and twist
  flipped sign. Light taps looked like a different zone. Scaled replay kept `impulseDirZ` at +1.00 down to 0.25x.
- Consequences: every existing calibration is invalid and must be redone; old samples are dropped from
  `samples.json` on the next save. Any future change to a feature's meaning must bump the version again.

## 2026-09-26 (night): Strength augmentation on by default (uncommitted)
- Decision: train on copies of each calibration tap scaled 0.4x, 0.6x, 1.6x, 2.5x.
- Instead of: off (it had tripled typing read as taps before the anchored window).
- Why: with the anchored window, cross-session right-zone taps went 21/69 to 33/69 and 58/133 to 65/133, typing
  read as a tap unchanged (0/12, 1/9). Small samples, one user.
- Revisit if: false taps while typing go up on real use.

## 2026-09-26 (night): Partial recalibration keeps other zones' samples (uncommitted)
- Decision: `calibration_finish` merges the run with saved samples (`CalibrationMerge`): recaptured labels are
  replaced, other known zones kept, saved `none` kept unless the run captured negatives.
- Instead of: every run replacing all samples.
- Why: the wizard lets users redo a few zones; redoing two must not erase the other six.

## 2026-09-26: Light-touch detection is opt-in (reverse-engineered)
- Decision: `DetectionSettings.lightTouch` defaults to false; weak taps (0.5 to 0.8 confidence) may only complete a
  double/triple within their own zone after a strong tap, never start or break a group.
- Why: the adaptive low onset floor let in ~2.5x more junk spikes (some read as grilles) and live accuracy regressed
  for a user calibrated with firm taps. See `daemon/analysis/README.md`.

## 2026-09-26: Default minConfidence 0.8 (reverse-engineered)
- Decision: a tap must reach 0.8 classifier confidence to count.
- Why: operating-point sweep on the first real calibration: 0.8 gave 2% wrong-zone and 0.02 false taps per typing
  negative; recall is recovered by turning weak zones off (91% without left-edge and lid) rather than lowering it.

## 2026-09-26: Per-user kNN + LDA classifier with a "none" class, trained on device (reverse-engineered)
- Decision: standardize by pooled within-zone spread, whiten with shrunk pooled covariance, k=5 distance-weighted
  kNN including keystroke/trackpad negatives as `none`, LDA posterior for confidence, Mahalanobis reject distance.
- Instead of: a pre-trained or neural model; logistic regression, class-balanced votes, other kNN/Gaussian mixes
  (tested, no better).
- Why: each chassis and each person's taps differ; 20 taps per zone is all the data there is; no dependencies;
  the `none` class is what keeps typing from firing zones.

## 2026-09-26: Physics-based features, 33 of them (reverse-engineered)
- Decision: signed impulse direction, gyro twist (torque = lever arm = position), twist per impulse (force
  independent), band energies, ring frequency, decay, rise, pulse width, strength.
- Why: where a finger lands decides force direction and chassis rotation; parts of the case ring differently.
  Keystrokes are small, sharp, low-twist. Documented at the top of `FeatureExtractor.swift`.

## 2026-09-26: Motion sensor through private AppleSPUHID IOKit services (reverse-engineered)
- Decision: read accel/gyro from `AppleSPUHIDDevice`, set `ReportInterval` 1250 us (~800 Hz) and power/reporting
  state on `AppleSPUHIDDriver`; save originals to `spu-originals.json` before writing and restore on every exit
  path, and after a crash on next start. Never write the light or lid drivers.
- Instead of (inferred): a kernel extension or root helper, which the project's safety rules forbid; macOS has no
  public API for MacBook chassis motion.
- Why: the only no-root, no-kext way to get a fast motion stream on Apple silicon MacBooks.
- Risk: undocumented Apple internals; a macOS update could break it. Base M1 and Intel do not expose it.

## 2026-09-26: Separate Swift daemon + Electron app over a loopback WebSocket (reverse-engineered)
- Decision: `ghostkeysd` owns sensors, detection and actions; the Electron app is only a client; JSON over
  `ws://127.0.0.1:47823`, contract in `docs/PROTOCOL.md`.
- Why: native APIs need Swift; UI iterates faster in React; the same protocol serves the CLI, SDK, Raycast, the
  mock daemon, the e2e tests and the Rust Windows port.

## 2026-09-26: Local connection hardening (reverse-engineered, from SAFETY_AUDIT)
- Decision: per-launch 32-byte token (header `X-Ghostkeys-Token`), reject any handshake with an `Origin` header,
  daemon-computed SHA-256 approval hashes for shell/AppleScript/Shortcuts/open, a dangerous-command filter even
  when approved, rate limits that auto-pause (5/s, 60/min).
- Why: an earlier version accepted connections from any web page (`docs/audit/SAFETY_AUDIT.md`).

## 2026-09-26: Integrations as fixed AppleScript handlers with data-only arguments (reverse-engineered)
- Decision: every script is a constant defining `on gk_main(args)`, called via a subroutine Apple Event with args as
  event data; one serial queue for all NSAppleScript use; never launch an app; Excel selection capped at 5,000 cells.
- Why: no script injection from user text; NSAppleScript instances on different threads corrupted each other in
  tests; launching apps from a tap would surprise users.

## 2026-09-26: Default zone geometry lives in the app, embedded into the daemon by codegen (reverse-engineered)
- Decision: `app/src/shared/zone-defaults.json` is the single source; `daemon/scripts/gen-zone-defaults.sh` writes
  `ZoneDefaults.generated.swift` with its SHA-256.
- Why: the app draws zones and the daemon seeds configs; one source means the two cannot disagree.

## 2026-09-26: Custom Swift test runner for Command Line Tools (reverse-engineered)
- Decision: `daemon/scripts/run-tests.sh` builds each test target into a generated executable package.
- Why: plain `swift test` on the Command Line Tools builds swift-testing suites and runs none, reporting success.
- Caveat found in onboarding: on Swift 5.10 tools, where swift-testing is missing entirely, the script skips every
  target and still exits 0 unless `--strict` is passed.

## 2026-09-26: Windows port has no zone classifier (reverse-engineered)
- Decision: every knock lands in one pseudo-zone `anywhere`; tap/double/triple/rhythm and tilt still work.
- Why: most Windows laptop accelerometers report too slowly and coarsely to tell zones apart.
