# Sonar on the M5 Pro MacBook Pro: report (27 Sep 2026, overnight)

## Short answer

- **Why nothing fired:** our own safety gates blocked every sample. The microphone and speakers were fine.
- **What changed:** the gates are fixed and each speaker side now works on its own. A still room, typing, and noise bursts produce no gestures in any test.
- **What still limits it:** at your volume (19%), a hand's echo is about as quiet as the microphone's own hiss. Sonar needs the volume at 50% or more to find hands. Sweeps do not work yet on this Mac.

## What I measured

Six short runs of my own daemon build, tones at the existing -36 dBFS per channel, built-in speakers only (route checked each time), nobody at the laptop. Four 10-second raw recordings are in `daemon/analysis/data/sonar/` (gitignored, local only).

Recording path:

- Microphone: 1 channel, 48 kHz, nothing resampled, voice processing off, automatic gain off, mic mode standard.
- So "channel averaging cancelling 20 kHz" cannot happen: there is only one channel.
- The microphone's own filter starts cutting near 20 kHz and is silent above 21.5 kHz. Both pilots (19.5 and 20.25 kHz) still pass.
- Output: MacBook Pro Speakers, 2 channels, 48 kHz. Volume slider 19%, which CoreAudio reports as 36 dB below full.

Pilot levels at the microphone (dBFS means level relative to the loudest possible signal):

| | left speaker | right speaker |
| --- | --- | --- |
| level | -75 to -77 dBFS | -87 to -100 dBFS |
| above the noise next to it | 44 to 58 dB | 14 to 44 dB |

- Swapping the two frequencies moved the weakness with the speaker, not the frequency. The right speaker is simply far from the microphones.
- The old rule needed 25 dB on **both** sides, so the right side could block everything.

## Why zero gestures fired

In order of impact:

1. **Click detector stuck on.** It learned its "quiet" level from the first near-silent audio, then treated every later moment as a key click and threw it away. The live debug stream showed 300 of 300 samples discarded, so the hand trackers never ran.
2. **False "interference".** With nobody there, it fired in 48 of 104 live windows and 91% of the time on replay. Two causes: it compared room noise against the weak right pilot, and it flagged any single random noise spike as a music tone.
3. **Hand tracker listening to noise.** Its noise estimate read 5 to 10 times too low on real audio. With gates 1 and 2 fixed, it would have "tracked" noise all the time: the right side wandered 225 mm in 10 seconds of a still room.
4. **Clock-drift corrector could lock onto noise.** On the weak right pilot it once settled on a fake 23 Hz drift, which then looked like endless motion.
5. **Both sides required.** A weak right pilot disabled the left one too.

## What I changed

All in `daemon/Sources/GhostkeysAcoustics` and `ghostkeysd/Sessions/SoundSession.swift`:

- **Click detector:** energy that stays up for 40 ms is a new normal level, not a click.
- **Interference:** a tone must sit on the same frequency in two frames running. Broadband noise is compared with its own usual level. Short noise bursts now blank only the 85 ms they cover instead of blocking half a second.
- **Hand tracker:** removes the pilot's slow natural wobble, keeps only the frequencies a moving hand makes, and learns its noise level from real quiet moments. It opens only 6 dB above that.
- **Motion must go one way.** Noise pushes the measured distance back and forth; a hand pushes it steadily one way. A gesture now needs that steadiness. This is what stopped a false pull and a false hover seen in one live run.
- **Each side on its own.** One healthy side is enough for push, pull and hover. The side is picked by which speaker's echo is clearly stronger.
- **Drift corrector:** learns slowly and never believes more than 2 Hz (real drift here was under 0.01 Hz).
- **Pilot threshold:** 25 dB down to 15 dB.
- **Volume:** the daemon reads the volume slider. Muted: tones pause until unmuted. Under 50%: a hint appears in the log and in `sonar_debug`. A volume change resets the trackers.
- **Diagnostics:** `sonar_debug` gains `overFloorDb` (how far the moving part sits above noise), `burstFrames`, `outputVolume`, `outputMuted` and `volumeHint`.
- **Measurement knobs** for development daemons only (never the installed app): raw capture, pilot frequencies, level. Listed in the module README.
- **Test daemons no longer write** the `mic.active` marker into the real app folder.

Not changed: the -30 dBFS tone cap, the built-in-speaker-only rule, the frequencies.

## The simulator

`SonarRealSceneTests` plays the real still-room recordings with made-up hand echoes on top. The echo strength follows the hand's distance to each speaker and to the microphones, set so a hand 15 cm above a speaker echoes 30 to 45 dB below the direct tone (the range reported in published work). The real recording supplies all the noise, wobble and bursts.

Results, strongest echoes (30 dB below the direct tone), 9 gestures x 3 stretches of real noise = 27 tries:

| volume | found | wrong gesture | notes |
| --- | --- | --- | --- |
| before my changes, any volume | 0 | 0 | everything blocked |
| as recorded (19%) | 0 | 0 | echo is at the noise level |
| 15 dB louder | 10 | 3 | |
| 30 dB louder | 13 | 4 | |

- Weaker echoes (35 dB and below) are mostly missed even at 30 dB louder.
- Most misses in one stretch come from a real noise burst landing on the gesture.
- **Sweeps:** 0 found. The left side's own wobble drowns its echo, so only the right side tracks, and a sweep then looks like a pull. This needs real hand data to fix.
- **No false triggers:** 40 s of still room, typing on top of it (with no typing suppression at all), and noise bursts right at the weak pilot all produced nothing.
- "Louder" is modelled by scaling the tones. I could not read the slider's exact curve, so treat "15 dB louder" as roughly the middle of the slider, and "30 dB" as near full.

## Morning test (60 seconds)

1. Unplug headphones. Set the volume to about 60% (sonar tones are inaudible; your other sounds will be louder).
2. Open Ghostkeys, turn Sonar on.
3. In a terminal at the repo root: `node docs/review/sonar-check.mjs 60 ~/Desktop/sonar-morning.jsonl`
4. Keep your wrists off the laptop. Hold one hand 10 to 20 cm above the keyboard, then:
   - 0 to 15 s: hold still (should print nothing but status lines);
   - 15 to 30 s: three quick pushes down above the right speaker, then three pulls up;
   - 30 to 45 s: slowly raise and lower your hand above the right speaker (hover);
   - 45 to 60 s: the same above the left speaker.
5. Send me the last lines and keep `~/Desktop/sonar-morning.jsonl`: it lets me tune on your real hand.

What the status line means:

- `ready 10/10`: nothing is blocking detection.
- `echo over noise`: 10 dB or more while your hand moves means sonar can hear it. Under 6 dB means it cannot; turn the volume up.
- `volume`: under 50% you will see the hint.

## Left open

- **Typing and laptop-motion pause, outside my files:** `App/Daemon.swift` pauses sonar when the motion sensor reads more than 0.05 g off rest or more than 15 degrees per second of rotation. I could not test it (the sensors were simulated). In the older tap recording, still moments crossed it only about 1% of the time. Wrists resting on the laptop while waving could still keep sonar paused; `suppressedByDaemon` in `sonar_debug` shows it.
- Sweeps, and which side a hover belongs to, need real hand recordings.
- Frequencies: not changed. The weak side is about position, so moving to 18.75 kHz would not help.

## Build and tests

- `daemon/scripts/run-tests.sh Acoustics`: 74 tests pass. The debug speed budget for the 60-second processing test went from 0.5 s to 0.75 s; the release build takes 0.06 s.
- Release daemon rebuilt at `daemon/.build/release/ghostkeysd`: old binary deleted first, then built.
