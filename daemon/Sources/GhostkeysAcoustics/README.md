# GhostkeysAcoustics (sound mode)

Optional, off by default. Uses the built-in microphone to add three things the motion sensor cannot tell apart:

1. **Tap type.** When the IMU (motion sensor) detects a tap, the sound around it says whether it was a fingertip, a knuckle or a nail. Knuckle taps become `knock_knuckle`.
2. **Rubs and swipes.** Dragging a finger over the palm rest or the speaker grille makes a steady hiss (friction noise). That becomes `rub`, or `rub_left` / `rub_right` when the direction is clear.
3. **Hand waves.** The speaker plays an inaudible ~20 kHz tone. A moving hand reflects it slightly higher or lower in pitch (the Doppler effect). That becomes `wave_toward`, `wave_away` or `wave_sweep`. Method from SoundWave (Gupta et al., CHI 2012).

Everything except `AcousticSession` is pure computation and is tested with synthetic audio only.

## Gesture names (wire format)

| gesture | source | meaning |
| --- | --- | --- |
| `knock_knuckle` | IMU tap + sound | a tap the IMU saw, classified as a knuckle |
| `rub` | sound | friction noise lasting 150 ms to 2 s, direction unsure |
| `rub_left` / `rub_right` | sound | same, with direction confidence at least 0.7 |
| `wave_toward` | sonar | hand moved toward the laptop |
| `wave_away` | sonar | hand moved away |
| `wave_sweep` | sonar | hand passed over: toward then away in one motion |

These are not yet in `docs/PROTOCOL.md`. Suggested additions: the six rows above in the gesture table, `"sound": true` under `hello.sensors`, and an optional `"tapType": "fingertip" | "knuckle" | "nail"` on `tap` messages.

## Public API

```swift
// One object does all the work. Feed it audio and IMU tap onsets; it returns events.
let processor = SoundModeProcessor(options: .init(), tapClassifier: model)   // model may be nil
let events: [AcousticEvent] = processor.process(samples, time: chunkHostTimeSeconds)
processor.noteTapOnset(imuTime: tapHostTimeSeconds)   // result arrives from a later process() call
processor.reset()                                     // when the mic session restarts

enum AcousticEvent {
  case gesture(AcousticGesture)                        // the only case that should trigger actions
  case tapClassified(onset: Double, TapClassification) // every IMU tap, including rejected ones
  case rubStarted(time: Double)                        // live feedback
  case rubCancelled(time: Double, reason: RubCancelReason)
  case rubEnded(RubSummary)                            // duration, speed, direction, comb tone
  case wave(SonarWaveEvent)
}

struct AcousticGesture: Codable { kind: AcousticGestureKind; time; confidence; duration?; speedProxy?;
                                  speedMetersPerSecond?; direction?; directionConfidence?; var name: String }
```

Building blocks, usable on their own:

- `TapFeatureExtractor`: 40 ms window to `TapFeatures` (40 log-mel bands, spectral centroid, rolloff, flux, zero-crossing rate, decay time, high/low energy ratio, level).
- `TapTypeClassifier`: k-nearest-neighbour (k-NN) vote over z-scored features (each feature rescaled to mean 0, spread 1) with a reject option. `train([LabeledTap])`, `classify(TapFeatures)`, `leaveOneOutAccuracy()`. `Codable`: save it as JSON in `~/Library/Application Support/Ghostkeys/model/`. Rejects with `.unfamiliar` (nothing in training looks like this) or `.ambiguous` (neighbours disagree).
- `TapWindowAligner`: finds the sound onset within +-15 ms of the IMU onset so every window starts 2 ms before the transient.
- `FrictionDetector`: streaming rub detector. `FrictionDetectorConfig` holds every threshold. `lastFrame` exposes per-frame diagnostics, including why a frame was not friction (`quiet`, `below_floor`, `not_band`, `impulsive`, `tonal`, `harmonic`).
- `SonarWaveDetector`: streaming Doppler detector, 4096-point Hann FFT every 1024 samples. `SonarConfig` holds thresholds and debounce. `lastFrame` shows pilot level and left/right widening for a visualizer.
- `PilotToneGenerator`: renders the pilot tone with hard safety limits (below).
- `AcousticSession`: the only hardware code. Opens the mic (mono, 48 kHz, 256-frame buffers requested; macOS may deliver larger ones), keeps a 200 ms `AudioRingBuffer`, and can play the pilot tone. Apple voice processing is deliberately left off: it removes non-speech sound, which is exactly what we need.
- `AudioRingBuffer`: last 200 ms of audio, readable by time.

All times are seconds on the caller's clock. `AcousticSession` uses host time (the `mach_absolute_time` clock), the same clock the IMU path uses, so tap onsets line up. The daemon converts to its "ms since start" `t` when sending.

## How the detectors decide

**Rub.** Every 20 ms, a 43 ms frame is a friction frame when all hold: loud enough (-65 dBFS), 10 dB above the learned background, at least half its energy in 2 to 12 kHz, not impulsive (1 ms block peak under 6x the mean, which rejects typing), not tonal (under 30% of energy in narrow peaks, which rejects music), and not voiced (autocorrelation pitch strength under 0.5, which rejects speech). A rub is friction frames sustained 150 ms to 2 s with gaps under 60 ms. Longer than 2 s is cancelled as `too_long`.
- Speed: `speedProxy` is 0 to 1 from the spectral centroid (brighter means faster; uncalibrated). On the speaker grille the holes chop the hiss at `speed / hole pitch`; the detector finds that rate by autocorrelating the loudness envelope and reports `combHz` and `speedMetersPerSecond` (set `grilleHolePitchMeters` per model).
- Direction: a straight-line fit of loudness over the rub. Rising means moving toward the mics. Confidence is the fit quality times how big the change is (6 dB counts as full). `micSide` (default `.left`) maps toward/away to left/right. Verify mic placement per model.

**Wave.** The pilot's peak in the spectrum is normally +-1 bin wide. Each frame scans outward on both sides for bins within 35 dB of the pilot (and 8 dB above noise), tolerating 2-bin gaps. Widening of 3 or more bins (35 Hz, about 0.3 m/s of hand speed) beyond the resting width counts as motion on that side. A motion episode ends after 5 quiet frames. Right-side widening wins: `wave_toward`. Left: `wave_away`. Both with balance of at least 0.35: `wave_sweep`. Episodes over 1.5 s are ignored as ambient movement, and a 0.4 s dead time follows each wave. With no pilot detected, sonar reports nothing.

## Speaker safety (hard limits in `PilotToneGenerator`)

These cannot be configured away:

- **Level cap: -30 dBFS.** Any requested amplitude above 0.0316 is clamped.
- **20 ms fade in and out**, so starting and stopping never click.
- **Auto-stop after 60 s** of playback per session unless `renew()` is called. `renew()` re-checks the output route.
- **10 s cooldown** after a session ends before a new one may start (`start()` throws `.coolingDown`).
- **Built-in speaker only.** `start()` reads the default output device from CoreAudio and refuses unless the transport is built-in (`bltn`) and the data source is the internal speaker (`ispk`). Headphones (`hdpn`), Bluetooth, USB, HDMI, AirPlay, and anything unknown are refused. `AcousticSession` also cuts the tone immediately on any audio configuration change (for example headphones plugged in).

**Pets and some people can hear 20 kHz.** Dogs and cats hear well above 20 kHz, and some children and young adults can hear it too. Keep sonar sessions short, never run the tone in the background, and say so in the UI where sonar is enabled.

## How the daemon should integrate

1. **Off by default.** Only a user setting turns sound mode on. With it off, never construct `AcousticSession`.
2. **Open the mic only in short sessions.** Start a session after a wake gesture (for example a triple tap, detected by the IMU) or while the frontmost app is one the user pinned sound gestures to. Close it automatically after N seconds without a sound gesture (suggest 8 s after a wake gesture) or when the pinned app loses focus.
3. **The orange dot.** While `AcousticSession` runs, macOS shows the orange microphone indicator in the menu bar and lists Ghostkeys (or the Electron app that spawned the daemon) in Control Center. That is correct and expected; do not try to hide it. Show a matching "listening" state in the HUD so the dot is never a surprise. Closing the session removes the dot.
4. **Permission.** Check `AcousticSession.microphoneAuthorization` first. If it is `.notDetermined`, starting will make macOS prompt, so only start from a user action in the UI. Denied: report `{"type":"error"}` and keep sound mode off. Because the daemon is a command-line child of the app, macOS attributes the permission to the responsible app (the Electron app, or Terminal in dev).
5. **Threading.** `AcousticSession` calls back on an AVFoundation thread. Hop each `Chunk` onto the daemon's detection queue and call `processor.process(chunk.samples, time: chunk.time)` there. Call `noteTapOnset` from the same queue whenever the IMU accepts a tap while a session is open.
6. **Sonar.** Only when the user enabled wave gestures, only inside an open mic session, and stop the tone when the session closes. Create a `PilotToneGenerator`, call `session.startPilotTone(generator)`, and handle its errors (route refused, cooling down) by simply running without waves. Call `generator.renew()` about every 30 s if the session is still wanted.
7. **Gating.** Respect `paused`. Suppress sound gestures while the typing gate is active (typing and hands near the keyboard can produce Doppler and friction noise). Map `.gesture` events to `{"type":"gesture", "gesture": g.name, ...}` and run bindings exactly as for IMU gestures.
8. **Calibration.** Tap types: during calibration, ask for about 20 taps of each type on one zone, collect `LabeledTap(features:label:)` from `TapFeatureExtractor` on `TapWindowAligner` windows, train, and report `leaveOneOutAccuracy()`. Save the labeled taps too, so the model can be retrained later.

## Tests

`daemon/Tests/GhostkeysAcousticsTests`, swift-testing, synthetic signals only (no mic, no speaker):

- Tap type: noise bursts with fingertip, knuckle and nail spectra and decays; held-out accuracy must exceed 90% (measured 100% on 300 synthetic taps); silence and a pure tone are rejected; JSON round trip; IMU-offset alignment; end-to-end `knock_knuckle` through the processor.
- Rub: steady rub detected with the right duration; rising and falling loudness give `rub_left` / `rub_right`; too short and too long rejected; typing at 6, 9 and 14 keys per second rejected; voice-like harmonic signals rejected (the bright variant specifically by the pitch test); music-like chords rejected; comb-tone speed within 15% at 80, 180, 350 and 600 Hz.
- Sonar: toward, away, sweep, two separate waves, pilot alone, no pilot, reflections too weak.
- Pilot tone: -30 dBFS cap, 20 ms fades, 60 s auto-stop, renew, cooldown, route refusal, frequency and phase continuity.
- Performance: 60 s of 48 kHz audio through the whole processor in 256-sample chunks under 0.5 s (measured 0.23 to 0.26 s in a debug build).

```sh
cd daemon && swift test --scratch-path .build-acoustics --filter GhostkeysAcousticsTests
```

## Not yet validated on hardware

All thresholds come from physics and synthetic tests. Before shipping, check on real MacBooks: tap-type accuracy with real calibration data; rub false positives from clothing and palm rest contact; mic position for `micSide`; grille hole pitch; whether the speaker and mic pass 20 kHz cleanly enough (look at `SonarWaveDetector.lastFrame.pilotDb` against `noiseDb`); and hand-reflection levels at typical distances.
