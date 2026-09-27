# Best practices from other tools and papers (27 Sep 2026)

What the best Mac tap tools, tap papers and ultrasonic sonar projects do, mapped to our code, ranked by expected impact. Numbers with a source URL were read from source code. "(recalled)" marks paper numbers not re-fetched this session; verify before citing.

## The short list (ranked)

1. Sonar: per-side gates, so the weaker pilot (20 to 23 dB lower at the mic) stops vetoing everything (A1).
2. Sonar: median floor for the impulse detector; it voids 150 to 1,842 blocks per window on silence (A2).
3. Sonar: read system volume and recalibrate on change, as sonar.cool does; amplitude is not the problem (A3).
4. Sonar: pilot-present gate 25 dB to 15 dB SNR (A4).
5. Sonar: per-machine pilot frequency from a startup sweep (A5).
6. Detection: jerk features, since typing never has high amplitude and high jerk together (B1).
7. Detection: align features on the first peak, not the threshold crossing (B2).
8. Detection: store raw calibration windows, then time-shift augmentation (B3).
9. Sonar: swing-centre static estimate and 2 carriers per side (A6).
10. Detection: separate tap vs non-tap gate before the zone classifier (B4).

Details, evidence and code locations follow.

---

## A. Sonar (SonarField): why it detects nothing, and what works elsewhere

### Evidence from our own hardware

Two 10 s silent captures and a 114-row `sonar_debug` log from this morning's sonar runs (`daemon/analysis/data/sonar/static_run1.wav`, `static_run2_swapped.wav`, scratchpad `sonarmeas/run2.jsonl`; MacBook Pro Microphone, output volume 0.188), re-analysed read-only:

- **The capture path is clean:** 1 channel (so the channel averaging is a no-op), 48 kHz, no resampling, voice processing and AGC off, mic mode standard.
- **Both pilots arrive, but the left speaker channel reaches the mic about 20 to 23 dB louder than the right, whichever frequency it carries.** Run 1: 19.5 kHz (left) is about 20 dB above 20.25 kHz. Swapped run: 20.25 kHz (left) is about 22 dB above 19.5 kHz; the log shows left at -83 to -75 dBFS (SNR 46 to 61 dB) and right at -103 to -97 dBFS (SNR 27 to 37 dB). The loss is speaker position, not frequency; the spectrum only falls off a cliff above about 22 kHz.
- **The gates block it:** `interference: true, reason: broadband` in 57 of 114 windows, with `ready: false` in exactly those; `impulseBlocks` 150 to 1,842 per window with nobody typing; `gateOpenShare` 0 almost everywhere.

### A1. Per-side gating (impact: highest, sonar produces nothing today)

- **Where:** `SonarField.swift` about line 675, `let pilotDb = min(db(p[binL]), db(p[binR]))`, and `SonarFieldStatus.ready` (line 116), which requires `left.pilotPresent && right.pilotPresent`.
- **Change:**
  - Run the tonal and broadband interference tests per side, each against its own pilot and its own guard band.
  - Let one healthy side produce single-side gestures (push/pull, hover) while the other side is weak. Only sweep needs both sides.
  - Show per-side status in `sonar_debug`.
- **Why:** the weak side's pilot sits about 23 dB lower, and every rule anchored to it fires on ordinary noise. sonar.cool plays **one** tone on **both** speakers and reads one mic, so it never has this problem (`work/Sonar/HardwareAudio.swift`: the same `value` goes to every output channel).
- **Fallback worth adding:** a single-pilot mode that plays the same carrier on both channels when the level gap between sides exceeds about 15 dB.

### A2. Impulse detector floor (impact: high)

- **Where:** `SonarField.swift` about line 571 onward, `residualFloor`.
- **The bug:**
  - The floor drops at once to any lower block but rises only x1.0003 per block, so it hugs the noise minimum, not the median.
  - On the silent capture, 4 ms energy in the 16.5 to 18.5 kHz band has a 99th percentile 12 to 16 dB above its median, and further above its minimum. A 12 dB jump rule therefore fires on noise many times a second.
  - The absolute guard `e > 1e-13` is far below the real band noise.
- **Change:**
  - Use a median floor, as `OnsetDetector` already does (median of block medians over about 0.5 s).
  - Require a jump of 12 dB **over the median**, plus an absolute minimum set from the measured band noise (for example median + 20 dB).
  - Better: require the jump to appear together in two separate bands (for example 8 to 12 kHz and 16.5 to 18.5 kHz). A key click is broadband; noise flicker in one band is not.
  - Keystrokes are already covered by `suppressSonar(until:)` from the typing gate, so the detector only has to catch knocks.

### A3. Output volume and calibration (impact: high)

- **sonar.cool** (https://github.com/eperez28/sonar.cool, `work/Sonar/main.swift`, `SpeakerVolume.swift`) plays one carrier on both speakers at `level = 0.008` (about -42 dBFS). It reads `kAudioDevicePropertyVolumeScalar` every 0.5 s, refuses when muted or at 0, and **restarts its 2.5 s calibration on every volume change**.
- Our -36 dBFS per channel is already 6 dB above a tool that works on Apple Silicon MacBooks. Do not raise the cap.
- **What we lack:** volume awareness (at 0.188 the acoustic level drops a lot), re-baselining on volume change, and a clear user message (sonar.cool: "raise the volume at least one step").
- **Where:** `SoundSession.maintainSonarTones` (1 s tick): read the volume, report it, and call a new `SonarField.recalibrate()` that re-runs warm-up when it changes.

### A4. Pilot-present threshold (impact: medium-high)

- sonar.cool treats the tone as clear when carrier minus floor is above **15 dB** (carrier = max of centre ±1 bin, floor = mean of the 5 outermost bins on each side of a ±600 Hz window, 8192-point FFT, hop 2048, Hann). See `main.swift` lines 282 to 330 and `SonarCore/WaveEngine.swift` line 17.
- Our `minPilotSnrDb = 25` (`SonarField.swift` line 71) is 10 dB stricter. With the weak side at 27 to 37 dB SNR, it flickers. Use 15 dB.
- sonar.cool's motion test: sideband power above 2x a frozen baseline (±2 bins excluded), over carrier power, above 0.0003; direction needs a 1.7x side ratio for 2 frames.

### A5. Per-machine frequency choice (impact: medium)

- **Others:** SoundWave (Gupta et al., CHI 2012; recalled) sweeps 18 to 22 kHz at start and keeps the loudest frequency. doppler.js (https://github.com/DanielRapp/doppler) starts at 20 kHz and locks to the loudest bin in 19 to 22 kHz (FFT 2048). doppler-android (https://github.com/Samsonsjarkal/doppler-android) re-optimises within 19 to 21 kHz after 1 s and opens the mic as `VOICE_RECOGNITION` (Android's unprocessed preset). sonar.cool uses 20 kHz with a fallback ladder of 20, 19, 18 kHz.
- **Change for us** (`SonarFieldConfig`, `SoundSession` start):
  - Add a 1 to 2 s startup sweep per channel over the 750 Hz grid from 18.0 to 21.0 kHz (18000, 18750, 19500, 20250, 21000).
  - Pick the loudest frequency per side, keeping the two sides on different grid points.
  - Store the result per machine.
  - Our data says frequency matters less than side, but response varies between models, and 20.25 kHz may be too close to the roll-off on other Macs.

### A6. Static component and multiple carriers (impact: medium, only once A1 to A4 make it run)

- **LLAP** (https://github.com/Samsonsjarkal/LLAP, `RangeFinder.h/.cpp`): 48 kHz, 40 ms frames, **8 carriers from 17.5 to 19.95 kHz, 350 Hz apart**, total volume 0.2 (a phone). CIC low-pass: 4 stages, decimation 16. Static-vector estimate ("LEVD"): only carriers above `POWER_THR 15000` count, and the static estimate moves only when the peak-to-peak swing exceeds `PEAK_THR 220`, as `DC = 0.75 DC + 0.25 (min + max) / 2`. It follows the centre of the swing, not a time average, so a slow hand is not absorbed. Distance is a weighted least-squares fit of unwrapped phase across all strong carriers. Paper: 3.5 mm accuracy, 15 ms latency.
- **sonar.cool** freezes a baseline spectrum averaged over the first 2.5 s and recalibrates only on volume change.
- **Our** `staticTimeConstant = 0.3` s absorbs any hand that moves slower than about 0.3 s, which is exactly a hover. Change `PhaseSideTracker.step` (line 229 onward) to one of:
  - LLAP's swing-centre estimate, updated only while there is a visible swing;
  - a static estimate frozen while `episode` is active.
- **Carriers:** with only one carrier per side, one multipath null kills that side. On our 750 Hz grid, use 2 per side (for example left 18000 + 19500, right 18750 + 20250) and combine phases by weighted least squares, as LLAP does. The 3x64 averaging still nulls every other carrier.

### A7. Capture path (impact: low on current evidence)

- sonar.cool skips AVAudioEngine and binds two AUHAL (`kAudioUnitSubType_HALOutput`) units directly to the built-in input and output device IDs. Our debug record shows AVAudioEngine already gives a clean unprocessed stream, so keep this as a fallback if a future macOS applies mic modes to AVAudioEngine. No source documents what processing sits behind the single exposed mic channel.

---

## B. Tap detection (OnsetDetector, FeatureExtractor, ZoneModel)

### What the other Mac tools do

- **MacTap** (https://github.com/jaskirat1616/mactap-app, `TapDetector.swift`): full 800 Hz, deliberately not decimated ("tap peaks are 8-25 ms and vanish at 100 Hz"). Threshold `max(0.88 x tapThreshold, noise x (3.0 - 1.2 x sensitivity))`, noise clamped to 3.5 to 30 mg, plus a raw gate `rawDelta > max(22 mg, 0.65 x threshold)` (line 153). Width over 0.16 s rejected, refractory 0.07 s. Typing: 0.45 s after any key-down via `CGEventSource` session and HID state (no Input Monitoring needed); a "vertical typing" reject when keyed recently and `|attackZ| > 2.2 x |attackX|` (line 287); burst lockout of 0.4 s after 4 taps in 0.5 s. Side comes from a 34 ms attack window with the 12 to 100 ms pre-onset baseline subtracted.
- **MacSlapApp** (https://github.com/AbdullahFID/MacSlapApp, `SlapDetector.swift` lines 1 to 20), tuned on real M5 captures at 805 Hz: "hard typing tops out at 0.12 g with jerk ≤ ~18 g/s, and its high-amplitude moments have low jerk while its high-jerk moments have low amplitude. They never co-occur." It fires on `(amp ≥ dynAmp AND jerk ≥ jerkThr) OR amp ≥ hardAmp`, with `jerk = (|Δax| + |Δay| + |Δaz|) x fs`, and freezes its noise floor while the signal is elevated.
- **spank** (https://github.com/taigrr/spank): decimates to 100 Hz and votes across STA/LTA (on-ratios 3.0/2.5/2.0), CUSUM, kurtosis (above 6) and peak/MAD detectors, 50 mg minimum. Built for slaps; the 100 Hz rate is the cautionary example. **Bonk, knocker, Tapify** (GitHub Alex-duh/Bonk, Gojaehyeon/knocker, versacecrispies/Tapify) are similar 100 Hz tools with 180 to 300 mg thresholds.
- **Bosch BMI323 tap engine** (https://github.com/boschsensortec/BMI3XY_SensorAPI, `bmi323.c` `tap_param_set`): across smartphone, wearable and hearable presets only the peak threshold changes (143, 250, 750); the timing windows stay fixed. The BMI286's own engine is behind Apple's SPU firmware, so this is guidance only.

**Already at best practice:** full sample rate; the 450 ms key gate, 4-in-0.5 s burst lockout, 160 ms width limit and 60 ms refractory match MacTap; our median-of-block-medians floor is more robust than their EMA floors. Keep them.

### B1. Jerk plus amplitude co-occurrence (impact: high for typing false positives)

- **Where:** `FeatureExtractor` (new features), later `OnsetDetector.process` (an optional onset qualifier).
- **Features:** `peakJerk` = max over the first 15 ms of `(|Δax| + |Δay| + |Δaz|) x 797` g/s on raw accel; `jerkAtPeak` = jerk at the peak-amplitude sample divided by peak amplitude (force-independent, so it works for light taps); the gyro equivalents.
- **Why:** MacSlapApp's typing/impact split was measured on this sensor family, and TapNet feeds its network **only first derivatives** of accel and gyro because they remove gravity and orientation bias.
- **Caution:** MacSlapApp's numbers are for 0.5 g slaps; our taps are 8 to 45 mg, so re-derive thresholds from our data. Start as features only (needs recalibration), then test a gate on session1 and the calib typing negatives with `classifier_sweep.py`.

### B2. Peak-aligned windows (impact: medium-high for weak zones and light taps)

- **TapNet** (Huang et al., CHI 2021, https://arxiv.org/abs/2102.09087):
  - Aligns every sample on the first major z-accel peak, then takes 50 samples (120 ms at 416 Hz).
  - A cheap 150 ms buffer with a peak/valley check (peak and valley under 80 ms apart) rejects non-taps before the CNN.
- **Ours:** the window and the impulse and twist integrals start at the threshold crossing (`onset-3 samples`). For a light tap the crossing lands later on the rising edge than for a hard tap, so the same tap gives different impulse and twist values depending on force.
- **Change:** in `FeatureExtractor`, anchor impulse (0 to 2), twist (6 to 8) and the ratios (12, 13, 30 to 32) on the first local maximum of the detection level after the onset, minus a fixed lead (for example 5 samples).

### B3. Raw calibration windows, then time-shift augmentation (impact: medium)

- TapNet reports that **temporal-shift augmentation helped and amplitude scaling did not**. This is our result exactly: gain augmentation tripled typing false taps (see `daemon/analysis/README.md`).
- Our notes say time-jitter augmentation is blocked because calibration stores only features.
- **Change:** store the raw 6-axis window per calibration sample (a 100 ms window plus the 100 ms pre-window is 160 x 6 floats, about 4 KB per sample). Then train on ±1 to 3 sample shifts. This also unblocks the "richer shape features" that gained 3.5 recall points on session1.

### B4. Two-stage decision (impact: medium)

- TapNet, TapLogger (Xu et al., WiSec 2012) and TouchLogger (Cai & Chen, HotSec 2011; https://www.usenix.org/legacy/event/hotsec11/tech/final_files/Cai.pdf) all separate *is this a tap* from *where is it*.
- The keystroke papers find peak magnitude does not separate keystrokes. The **shape of the rotation trajectory** does: TouchLogger's pitch/roll loop bisector angles took accuracy from 51% to over 70%.
- **Change** in `ZoneModel`: a binary tap vs non-tap model on force-independent shape features (jerk ratios from B1, twist per impulse, rise and decay time, gyro/accel ratio), with negatives pooled across calibrations and its own threshold, applied before the zone classifier. Our "none" class does part of this today, but shares features and threshold with the zones.

### B5. Do not copy MacTap's "vertical typing" rule (avoids a regression)

MacTap and knocker reject Z-dominant events because their taps are side taps. Our palm-rest and lid taps are Z-dominant too. At most, apply it to grille and edge zones inside the key gate.

### B6. Weak zones and keystrokes: what the literature predicts (informs planning)

- TapNet's reimplementation of hand-crafted statistics plus SVM (the BackTap and BeyondTouch style) plateaus at F1 0.55 for 6 directions. A small 1-D CNN over peak-aligned derivatives, trained on 135K samples, reached 0.85. User fine-tuning helped the hardest task most (location F1 0.42 to 0.54). For us: spend per-user calibration effort on lid and left edge; a CNN only pays off with a large pooled dataset, so B1 to B3 come first.
- Keystroke-inference papers (TapLogger, ACCessory, TapPrints; survey https://arxiv.org/abs/1410.7746; (sp)iPhone, recalled) all rely on rotation trajectory, not magnitude, to see keystrokes. Typing peaks at about 18 g/s of jerk even when hard (MacSlapApp).

---

## Sources

URLs are inline above. Not retrievable this session (paywalled or rate-limited): Knocker, TapLoc, Toffee, SurfaceSight, BackXPress, ForceTap, GripSense full texts; ST LIS3DH/LSM6DSO tap app notes.
