# GhostkeysAcoustics (sound mode)

Optional, off by default. Uses the built-in microphone (and, for sonar, the speakers) to add what the motion sensor cannot tell apart:

1. **Tap type.** When the IMU (motion sensor) detects a tap, the sound around it says whether it was a fingertip, a knuckle or a nail. Knuckle taps become `knock_knuckle`.
2. **Rubs and swipes.** Dragging a finger over the palm rest or a speaker grille makes a steady hiss (friction noise). That becomes `rub`, or `rub_left` / `rub_right` when the direction is clear.
3. **Hand waves (single pilot).** The speakers play one inaudible ~20 kHz tone. A moving hand reflects it slightly higher or lower in pitch (the Doppler effect): `wave_toward`, `wave_away`, `wave_sweep`. Method from SoundWave (Gupta et al., CHI 2012).
4. **SonarField (stereo pilots, no camera).** Two inaudible tones, one per speaker group, give in-air gestures above the speakers and finger slides: a continuous `hover_level` slider (raise or lower a hand above a speaker, for volume), `push` / `pull`, `sweep_left` / `sweep_right`, and `finger_slide_left/right/up/down` (sliding while touching, confirmed by friction sound).

Everything except `AcousticSession` and `SonarBench` is pure computation, tested with synthetic audio only.

## Gesture names (wire format)

Discrete gestures, sent as `{"type":"gesture","gesture":...}`:

| gesture | source | meaning |
| --- | --- | --- |
| `knock_knuckle` | IMU tap + sound | a tap the IMU saw, classified as a knuckle |
| `rub` | sound | friction noise lasting 150 ms to 2 s, direction unsure |
| `rub_left` / `rub_right` | sound | same, with direction confidence at least 0.7 |
| `wave_toward` / `wave_away` / `wave_sweep` | single-pilot sonar | hand moved toward / away / passed over |
| `push` / `pull` | SonarField | quick hand motion (under 0.45 s) down toward / up away from a speaker; `side` says which |
| `sweep_left` / `sweep_right` | SonarField | hand passed across above the keyboard, right to left / left to right |
| `finger_slide_left` / `_right` / `_up` / `_down` | SonarField + friction | finger slid while touching; up = toward the hinge |

Continuous values, sent like the camera's `air` messages: `{"type":"air","gesture":"hover_level","phase":"began|changed|ended","side":"left","value":0.3,"displacementMm":45}`:

| gesture | fields |
| --- | --- |
| `hover_level` | `side`; `value` = displacement / 150 mm, clamped -1...1, positive = hand raised; `displacementMm` since `began` |
| `finger_slide` | `dxMm` (positive right), `dyMm` (positive toward the hinge), `value` = dyMm / 40 mm clamped -1...1 |

`ended` carries `cancelled: true` when the gesture was abandoned (typing, interference, contact began). SonarField gestures also carry `side` and `distanceMm` where meaningful.

`docs/PROTOCOL.md` lists the first three groups. Still to add there: the SonarField rows above, the two `air` kinds, and a `"sonarField": true` flag on the sound `session` message.

## Public API

```swift
// One object does all the work. Feed it audio and IMU tap onsets; it returns events.
var options = SoundModeProcessor.Options()
options.sonarField = true                             // stereo mode (replaces single-pilot `sonar`)
let processor = SoundModeProcessor(options: options, tapClassifier: model)   // model may be nil
let events: [AcousticEvent] = processor.process(samples, time: chunkHostTimeSeconds)
processor.noteTapOnset(imuTime: tapHostTimeSeconds)   // tap type arrives from a later process() call
processor.suppressSonar(until: now + 0.45)            // on every keystroke and on IMU motion or bumps
processor.reset()                                     // when the mic session restarts

enum AcousticEvent {
  case gesture(AcousticGesture)                        // the only case that should trigger discrete actions
  case air(AcousticAirEvent)                           // continuous SonarField values (hover_level, finger_slide)
  case tapClassified(onset: Double, TapClassification) // every IMU tap, including rejected ones
  case rubStarted(time: Double)                        // live feedback
  case rubCancelled(time: Double, reason: RubCancelReason)
  case rubEnded(RubSummary)                            // duration, speed, direction, comb tone
  case wave(SonarWaveEvent)
}
```

Building blocks, usable on their own:

- `TapFeatureExtractor`, `TapTypeClassifier`, `TapWindowAligner`: tap type (40 log-mel bands plus spectral centroid, rolloff, flux, zero-crossing rate, decay, high/low ratio; k-nearest-neighbour vote with reject; `Codable`).
- `FrictionDetector`: streaming rub detector; `lastFrame` says why a frame was not friction.
- `SonarWaveDetector`: single-pilot Doppler detector.
- `SonarField`: stereo-pilot tracker. `process`, `noteContactBegan/Ended/Cancelled` (the processor wires these to the friction detector), `suppress(until:)`, and `status` (per-side pilot level, noise, accumulated path in mm, moving-part level, Doppler widening; `interference`, `suppressed`, `ready`) for a live visualizer.
- `PilotToneGenerator` (one tone) and `StereoPilotGenerator` (left and right tones): render samples; all speaker-safety limits live in them (below).
- `AcousticSession`: the only hardware code. Opens the mic (mono, 48 kHz, 256-frame buffers requested; macOS may deliver larger ones) with a 200 ms `AudioRingBuffer`, and plays `startPilotTone` / `startStereoPilots`. Apple voice processing is deliberately left off: it removes non-speech sound.
- `SonarBench`: consent-gated real-hardware check for the lab tool (below).

All times are seconds on the caller's clock. `AcousticSession` uses host time (the `mach_absolute_time` clock), the same clock the IMU path uses.

## How the detectors decide

**Rub.** Every 20 ms, a 43 ms frame is friction when: loud enough (-65 dBFS), 10 dB above the learned background, at least half its energy in 2 to 12 kHz, not impulsive (rejects typing), not tonal (rejects music), and not voiced (pitch strength under 0.5, measured below 16 kHz so sonar pilots don't count; rejects speech). A rub is friction sustained 150 ms to 2 s. Speed: `speedProxy` from brightness, plus `combHz` / `speedMetersPerSecond` when grille holes chop the hiss periodically (the envelope is band-limited to 1.5 to 12 kHz so sonar pilots cannot fake a comb tone). Direction from the loudness trend (rising means toward the mics; `micSide` defaults to left).

**Single-pilot wave.** The pilot's spectral peak normally spans +-1 bin. Widening of 3 or more bins beyond rest on the right is `wave_toward`, on the left `wave_away`, both `wave_sweep`, with a 0.4 s dead time after each.

**SonarField.**
- Pilots: 19,500 Hz on the left channel, 20,250 Hz on the right. Both are multiples of 750 Hz (48 kHz / 64) and land exactly on 4096-point FFT bins.
- Separation: the mic delivers one beamformed mono channel carrying both pilots. Each pilot is I/Q demodulated (multiplied by its own cosine and sine) through a low-pass made of three cascaded 64-sample averages. That puts deep nulls on every multiple of 750 Hz, so the other pilot, and its Doppler-shifted echoes next to that null, drop out. (A single average was not enough: the other pilot's echoes aliased onto the same offset as a real echo.) Output rate 1500 Hz.
- Per side, two signals:
  - (a) Doppler widening of that pilot's peak (as above, also reported per side);
  - (b) phase tracking after LLAP (Wang et al., MobiCom 2016). A two-stage static tracker (25 ms each, about 6 Hz) removes the static part (direct path, still objects) and the real pilot's slow wander; a two-pole 150 Hz low-pass keeps only the band a hand can produce. The phase change of what is left is integrated into relative path-length change: `path change = -dphi * lambda / (2 pi)`, lambda = 343 m/s / f (about 17.6 mm), but only while that side's gate is open (below). A hand moving straight up above a speaker near the mics changes the path by about twice its own movement; `displacementMm` reports half the path change.
- Common and differential motion: `common = (left + right) / 2` is dominated by the shared microphone term (distance to the mics near the hinge); `differential = left - right` cancels the microphone term and tracks lateral movement.
- Each side is judged on its own. A side counts as moving only when its gate was open for 60% of the last 50 ms and its steps went one way (net change at least 60% of all steps). An episode uses a side only if that side was tracked in at least 40% of it; with one usable side, that side alone gives the common motion (push, pull, hover; no sweeps). A gesture needs the episode's common (or, for sweeps, differential) motion to be one-directional: net at least half of the travel.
- Side (`push`, `pull`, `hover_level`): the side with the clearly stronger echo (3 dB or more; both pilots leave at the same level and reach one mic), else the side whose path changed more.
  - `hover_level`: an episode still moving after 0.5 s whose common change is at least 1.7x the differential and still progressing (12 mm of path in the last 0.25 s, so a finished push does not turn into a hover). Continuous until 0.6 s of stillness.
  - `push` / `pull`: common-dominant, monotonic, at least 30 mm of path, over in 0.45 s or less (measured where the speed is at least a third of its peak, so noise before and after does not stretch it). Confidence rises if that side's Doppler agrees.
  - `sweep_left` / `sweep_right`: differential of at least 60 mm and 1.5x the common, sign gives the direction.
  - `finger_slide_*`: only between a friction rub's start and end (contact confirmation, so hovering hands never count). Lateral if |dx| > |dy|, else up/down. Motion episodes overlapping contact never produce hover/push/sweep.
- Robustness:
  - Drift: a speaker/mic clock mismatch rotates everything; the rotation is estimated (0.2 s while warming up, 0.7 s after, 20 times slower during motion) and undone, and never believed beyond 2 Hz. (On the MacBook the real drift was under 0.01 Hz; an unbounded fast estimate once locked onto about 23 Hz from the weak right pilot's noise, which then looked like endless motion.)
  - Tracking gate: the moving part's power (30 ms average) must be 6 dB above its own noise floor, the log-average of that power while nothing is tracked (1.5 s time constant, frozen while tracking and for 0.3 s after; after 2 s of unbroken tracking it may rise 2 dB/s so the gate cannot lock open). The old estimate (half the squared sample difference) read 5 to 10 times too low on real, correlated baseband noise, so the gate was open on noise all the time.
  - Impulses (key clicks, knocks): energy in a band below the pilots (about 17.5 kHz) jumping 12 dB marks up to 8 ms of phase samples as void. Energy that stays up 40 ms is a new level, not a click, and becomes the floor (on the MacBook the floor was learned from the first near-silent buffers and every later block counted as an impulse, so the trackers never ran).
  - Noise bursts: a guard-band level 8 dB over its usual (2 s average) level voids every baseband sample of that 85 ms FFT frame. The 90 ms processing delay makes that possible.
  - Interference: a narrow peak near the pilots within 30 dB of the weaker pilot, 20 dB over the guard median and on the same bin in two frames running (music, other ultrasonic sources) suppresses detection for 0.5 s; broadband noise within 15 dB of the weaker pilot, or 15 dB over its usual level, for 0.15 s. `status.interference` shows it. Motion that goes on after interference ends starts a fresh episode (daemon suppression does not: lifting the hands after typing must not become a gesture).
  - Typing and vibration: the daemon calls `suppressSonar(until:)` on each keystroke (typing gate) and on IMU motion. Active gestures end as cancelled.
  - Missing pilot (speaker muted, blocked, wrong route): that side is not used; with both missing nothing is detected.

## sonar_debug (tuning on real hardware)

While a sonar session runs and someone subscribes to the `debug` stream, the daemon sends about 10 messages a second:

```jsonc
{ "type": "sonar_debug", "t": 1234.5, "windowS": 0.1, "basebandSamples": 150,
  "left":  { "hz": 19500, "pilotDbfs": -48.2, "noiseDbfsPerBin": -112.0, "snrDb": 63.8, "pilotPresent": true,
             "sidebandLowDbc": -41.0, "sidebandHighDbc": -38.5, "dopplerShiftBins": [0, 4],
             "pathDeltaMm": -12.4, "pathStepVarMm2": 0.02, "pathTotalMm": -80.1, "dynamicDb": -31.0, "gateOpenShare": 1.0 },
  "right": { ... same for 20250 Hz ... },
  "gates": { "ready": true, "warmedUp": true, "tonesPlaying": true, "interference": false, "interferenceReason": "broadband",
             "suppressedByDaemon": false, "guardPeakDbfs": -95.0, "guardMedianDbfs": -110.0, "impulseBlocks": 0,
             "restarts": 0, "episode": true, "hover": false, "slide": false, "toneProblem": "..." },
  "input": { "hardwareSampleRate": 48000, "measuredSampleRate": 47999.8, "channels": 1, "format": "...", "resampled": false,
             "voiceProcessing": false, "agc": false, "voiceProcessingBypassed": false, "micMode": "standard",
             "preferredMicMode": "standard", "bufferFrames": [480, 480], "maxTimestampGapMs": 0.02,
             "highBandRolloffDb": -3.0, "channelPilotDbfs": [[-48.1, -51.0], [-48.2, -50.9]], "channelRmsDbfs": [-60.0, -60.1],
             "outputVolume": 0.188, "outputMuted": false,
             "device": { "name": "MacBook Pro Microphones", "nominalSampleRate": 48000, "inputChannels": 1, ... } } }
```

- Levels are dBFS from a 4096-point Hann FFT: a full-scale sine is 0 dBFS. The tones leave at -36 dBFS per channel. Noise is per FFT bin (11.7 Hz), as the level of a sine with the median bin power 28 to 40 bins from the pilot.
- `snrDb` must reach 15 for `pilotPresent` (was 25; measured 44 to 58 dB left, 14 to 44 dB right on an M5 Pro MacBook Pro at 19% volume). `ready` needs one present pilot, not both.
- `overFloorDb`: the moving part over its learned noise floor, largest in the window; the tracking gate opens at 6 dB. At rest it wanders 0 to 8 dB; a usable hand echo sits at 10 dB or more.
- `burstFrames`: FFT frames whose baseband samples were voided by a noise burst near the pilots.
- `gates.volumeHint` and `input.outputVolume` / `input.outputMuted`: the macOS volume slider scales the pilots. Muted stops the tones until unmuted; below 50% the hint asks for more.
- `sidebandLowDbc` / `sidebandHighDbc`: strongest energy 2 to 26 bins below / above the pilot, relative to it. A moving hand should lift them by 10 dB or more.
- `pathDeltaMm`: phase-tracker path change in the window (a hand moving at 0.3 m/s gives about 60 mm per 0.1 s window); `pathStepVarMm2` is the variance of its per-sample increments (noise when still, larger in motion); `gateOpenShare` is the share of samples the tracker trusted.
- `suppressedByDaemon`: the typing gate or IMU motion called `suppressSonar`. `restarts`: analysis restarted because audio timestamps jumped over 10 ms (should stay 0).
- `input.channelPilotDbfs`: per input channel, then the mono mix the detectors get, at [left pilot, right pilot]. If the mix is much lower than the single channels, averaging the channels is cancelling the pilots.
- `input.highBandRolloffDb`: median level at 21.5 to 23.5 kHz minus 14 to 16 kHz. Around 0 to -10 dB means the input passes the top of the band; -30 dB or lower means something low-passes before 20 kHz. The MacBook Pro microphone's own filter starts near 20 kHz and is digital silence above 21.5 kHz, so this reads very low there even though 19.5 and 20.25 kHz pass (the pilots' levels differ by speaker position, not frequency).
- `voiceProcessing`, `agc`, `micMode` (`voiceIsolation` would remove the pilots), `measuredSampleRate` and `resampled` show whether anything unexpected sits in the capture path.

The session start also logs, once, the input and output device (name, transport, nominal rate, channel counts, data source), the engine's input format, voice processing and mic mode, and the tone player's source and device formats.

## Speaker safety (hard limits in the tone generators)

These cannot be configured away, and apply to both `PilotToneGenerator` and `StereoPilotGenerator` (the stereo pair counts as one session):

- **Level cap: -30 dBFS.** Per channel, and for the stereo pair the two amplitudes together (so even a mono downmix stays under -30 dBFS). Default stereo split is -36 dBFS per channel. Requests above the cap are clamped.
- **20 ms fade in and out**, so starting and stopping never click.
- **Renewal watchdog: 60 s.** The tone stops by itself after 60 s of playback without a `renew()`. An owner that wants the tone to keep going (the daemon's sonar switch has no time limit) renews it well inside that window; every renewal re-checks the output route, so the safety check keeps running for as long as the tone plays. If the owner hangs, the tone still stops.
- **10 s cooldown after a refusal or a safety stop** (route refused at `start()`, route no longer allowed at `renew()`, `stopImmediately()`, the watchdog): `start()` throws `.coolingDown` until it ends. A plain `stop()` (the user turned it off) and renewals never start a cooldown.
- **Built-in speaker only.** `start()` reads the default output device from CoreAudio and refuses unless the transport is built-in (`bltn`) and the data source is the internal speaker (`ispk`). Headphones (`hdpn`), Bluetooth, USB, HDMI, AirPlay and anything unknown are refused. `AcousticSession` also cuts the tones immediately on any audio configuration change (for example headphones plugged in), then calls `onConfigurationChange`: AVAudioEngine has stopped itself at that point, so the owner must reopen the session (the microphone delivers nothing until it does).

**Pets and some people can hear 19 to 20 kHz.** Dogs and cats hear well above 20 kHz, and some children and young adults hear 19.5 kHz. Keep sonar sessions short, never run the tones in the background, and say so in the UI wherever sonar is enabled.

## SonarBench (lab tool only, explicit consent)

A one-time real test for the user's own Mac. The lab tool must:

1. Print `SonarBench.disclosure`. It explains the mic and the orange dot, the two tones at -30 dBFS combined on built-in speakers only, up to 20 s, the pets note, and what to do with your hand.
2. Read what the user types and pass it to `SonarBench.Consent(typed:)`. Only the exact phrase `PLAY INAUDIBLE TONES` grants consent.
3. Call `try SonarBench.run(consent:seconds:printLine:)`. It is blocking, capped at 20 s, prints a reading every 250 ms (per-side pilot SNR, path in mm, moving-part level, state), and prints each gesture and `air` begin/end as it happens. Then it stops the tones (with fade) and closes the mic, also on error.

It returns a `Report`: median pilot SNR per side (SonarField needs at least 15 dB), interference share, largest path swing per side, and the gestures seen. It throws `.consentMissing`, `.routeNotAllowed(route)` or `.microphoneDenied` before touching any hardware. Nothing in the tests or the daemon calls it.

## How the daemon should integrate

1. **Off by default.** Only a user setting turns sound mode on. With it off, never construct `AcousticSession`.
2. **Short mic sessions only.** Start after a wake gesture (for example an IMU triple tap) or while a pinned app is frontmost. Close automatically after N seconds without a sound gesture (suggest 8 s) or when the pinned app loses focus.
3. **The orange dot.** While `AcousticSession` runs, macOS shows the orange microphone indicator and lists the app in Control Center. That is expected; never try to hide it. Show a matching "listening" state in the HUD. Closing the session removes it.
4. **Permission.** Check `AcousticSession.microphoneAuthorization` first. If `.notDetermined`, only start from a user action in the UI (macOS will prompt). The permission is attributed to the responsible app (the Electron app, or Terminal in dev).
5. **Threading.** `AcousticSession` calls back on an AVFoundation thread. Hop each `Chunk` onto the daemon's detection queue and call `processor.process(chunk.samples, time: chunk.time)` there. Call `noteTapOnset` and `suppressSonar` from the same queue.
6. **Sonar.** Only when the user enabled it, only inside an open mic session. Single pilot: `session.startPilotTone(PilotToneGenerator())` with `options.sonar`. SonarField: `session.startStereoPilots(StereoPilotGenerator())` with `options.sonarField = true`. Handle the errors (route refused, cooling down) by running without the tones and retrying after the cooldown. Call `renew()` while still wanted (the daemon's sonar switch renews every second, which is also how it notices a route change within a second), and stop the tones when the session closes. Set `onConfigurationChange` and reopen the session when it fires. The tones play on their own output-only engine (`TonePlayer`), never on the capture engine: on Apple Silicon MacBooks the built-in mic and speakers are separate devices, and starting output IO on the running capture engine fails with -10867 (`kAudioUnitErr_CannotDoInCurrentContext`). Create the generator at `TonePlayer.outputSampleRate()`. `ghostkeysd --sonar-tone-test S` starts that output engine playing silence (amplitude 0) to check a Mac without sound. The daemon runs SonarField continuously while `settings.sonar.enabled` is on, and holds it (mic closed, tones off) while paused, asleep (system or display) or with the lid closed.
7. **Gating.** Respect `paused`. Call `suppressSonar(until: t + 0.45)` on every keystroke and on IMU motion or bumps. Map `.gesture` to `{"type":"gesture",...}` and `.air` to `{"type":"air",...}`. A finger slide also produces a `rub` gesture; bind one or the other.
8. **Calibration.** Tap types: about 20 taps per type, `LabeledTap(features:label:)` from `TapFeatureExtractor` on `TapWindowAligner` windows, train, report `leaveOneOutAccuracy()`, save the labeled taps too.

## Tests

`daemon/Tests/GhostkeysAcousticsTests`, swift-testing, synthetic signals only (no mic, no speaker). SonarField scenes use real geometry: two speakers, a mic near the hinge, and a hand whose speaker -> hand -> mic path sets each echo's phase and Doppler sample by sample.

- Tap type: held-out accuracy above 90% (measured 100% on 300 synthetic taps), rejection, JSON round trip, IMU alignment, `knock_knuckle` end to end.
- Rub: detection, direction, duration limits, typing, voice-like and music-like rejection, comb speed within 15%.
- Single-pilot sonar: toward, away, sweep, debounce, no pilot, weak echoes.
- SonarField:
  - hover slider path within 20% for 5 to 20 cm moves above either speaker, up and down, and hand displacement within 20% above the left speaker. A 12-case randomized check during development stayed within 9%.
  - `push`, `pull` with the right side; `sweep_left`, `sweep_right`.
  - Pilot separation (one side's echo leaves the other side under 5%); clock drift (0.4 Hz) corrected.
  - Rejections: music tones near the pilots, typing, external suppression, missing pilots, still hand.
  - Finger slides in four directions with friction; none when hovering without contact or when rubbing without moving.
- Tone generators: -30 dBFS cap (per channel and combined, also across ten minutes of continuous renewal), fades, 60 s watchdog, renew, cooldown only after a refusal or safety stop, route refusal, a route change mid-play stopping the tones within the fade, correct frequency per channel.
- Real scenes (`SonarRealSceneTests`, skipped without the recordings): four static recordings from the MacBook never fire; typing on top of them never fires; bursts of noise right at the weak pilot never add up to a gesture; at the recorded volume nothing wrong fires; with 30 dB more pilot at least 10 of 27 strong-echo gestures are found with at most 7 wrong. `SONAR_REPORT=1` prints the full table (`SONAR_GAINS`, `SONAR_VERBOSE`, `SONAR_CFG` for tuning), `SONAR_CASE=n` traces one scene.
- Performance: 60 s of 48 kHz audio through the full processor in 256-sample chunks: 0.22 s with single-pilot sonar and about 0.55 s with SonarField and rubs in a debug build (budget 0.75 s), 0.03 s and 0.06 s in release.

```sh
cd daemon && scripts/run-tests.sh Acoustics      # swift test runs no swift-testing suites on the Command Line Tools
```

## Measured on hardware (M5 Pro MacBook Pro, 16 inch, macOS 26)

Numbers from `docs/review/SONAR_REPORT.md` (static room, tones at -36 dBFS per channel, volume slider at 19%):

- Microphone: one channel, 48 kHz, no voice processing, standard mic mode, nothing resampled.
- Left pilot at the mic -75 to -77 dBFS (SNR 44 to 58 dB); right pilot -87 to -100 dBFS (SNR 14 to 44 dB). Swapping the frequencies moves the weakness with the channel: the right speaker is simply farther from the mics.
- Hand echoes at 19% volume are at or below the mic's own noise in the hand's Doppler band: simulated echoes 30 dB under the direct path were detected in almost no scene. With 30 dB more pilot (a much higher slider) about half were. The left pilot also carries its own wander 26 to 33 dB under it, which limits the left side at any volume.
- Short ultrasonic noise bursts (about 0.1 s, a few per 10 s) are common in this room; they are voided rather than suppressing everything.

Still unknown: real hand echo levels (the simulator assumes 30 to 45 dB under the direct path at 15 cm), the exact mic position, and fingertip friction's ultrasonic energy.

## Measurement knobs (development daemons only)

A daemon started with its own `--config-dir` (never the installed app's) honours:

- `GHOSTKEYS_SONAR_CAPTURE=/path/file.wav` (+ `_SECONDS`, 1 to 10, default 10; `_DELAY`, default 3): record the raw mic input once, as a local float WAV.
- `GHOSTKEYS_SONAR_PILOTS=19500,20250`: pilot frequencies (snapped to the 750 Hz grid).
- `GHOSTKEYS_SONAR_LEVEL_DB=-36`: per-channel level; the -30 dBFS combined cap still applies.

The recordings in `daemon/analysis/data/sonar/` drive `SonarRealSceneTests`: the real static signal plus synthetic hand echoes (`RealScene`).
