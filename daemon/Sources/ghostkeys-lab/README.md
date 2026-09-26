# ghostkeys-lab

Collects real motion-sensor data and measures how well `GhostkeysDetection` turns it into zone taps.
It has its own small sensor reader (it does not use `ghostkeysd`) and needs no root and no Input Monitoring.

Build (from `daemon/`):

```sh
swift build --scratch-path .build-lab --product ghostkeys-lab
LAB=.build-lab/debug/ghostkeys-lab
```

## Commands

### record: guided data collection (needs a human at the laptop)

```sh
$LAB record --zones left-palm,right-palm,left-grille,right-grille,top-strip,left-edge,right-edge,lid --reps 20 --out session.gkrec
```

- For each zone it prints a big prompt ("Tap RIGHT GRILLE 20 times, one every second") and a TAP pulse every second,
  and counts detected taps live (a simple onset detector built into the lab tool).
- A zone ends by itself 1.2 s after the target count is reached. Keys: ENTER finishes a zone early, `r` redoes it,
  `q` saves what you have and quits. Ctrl+C also saves a partial file.
- Then 45 s "type and use the trackpad normally" (negatives), then 20 s "hands off" (rest).
- Options: `--reps 20`, `--interval 1.0`, `--negatives 45`, `--rest 20`.
- Sensor settings are restored on exit, including Ctrl+C (a second Ctrl+C restores and exits immediately).

### replay: accuracy report

```sh
$LAB replay session.gkrec                      # train on 75% of each zone's taps, test on the other 25%
$LAB replay session.gkrec --holdout 0.3 --sensitivity 0.7
$LAB replay session.gkrec --kfold 5            # every tap is tested once
$LAB replay session.gkrec --save-model model.json   # also save a model trained on everything (for `live`)
```

What it does:

1. Runs `TapEngine` (no model, calibration-capture mode) over the recording and matches its `.candidate` features to
   the recorded tap onsets (within `--match-ms`, default 80). Prints how many taps the engine's onset stage found.
2. Trains a `Trainer` on the training taps, plus candidates from the training part of the negatives phase labeled
   `none` (turn off with `--no-negatives`).
3. Runs `TapEngine` again with the trained model and scores the held-out taps.

Output: per-zone precision and recall, confusion matrix (rows = true zone, `none` = rejected or missed, with the
rejection reasons), false triggers per minute in the held-out part of negatives and in rest, and latency
(`emit - tap.t` is the engine's decision delay; `emit - true onset` includes onset-time error), plus the engine's
compute cost per sample. Precision counts as false positives: taps given the wrong zone, extra taps in a capture
phase that match no recorded tap, and taps accepted during negatives or rest.

Other options: `--seed 42`, `--min-confidence X`, `--typing-gate-ms X`.

### info, export

```sh
$LAB info session.gkrec                 # header, sample rate, gaps, per-phase onsets, peak and noise
$LAB export session.gkrec --csv out/    # imu.csv, activity.csv, segments.csv, onsets.csv, header.json
```

### live: watch the detector

```sh
$LAB live                       # until Ctrl+C
$LAB live --seconds 10 --model model.json --sensitivity 0.5
```

Prints every lab onset, engine candidate (feature summary: length, norm, first 8 values, and the classified zone if a
model is given), accepted tap, rejection and gesture, plus a status line every 2 s (rate, noise floor, time since
the last key and trackpad event). `--no-lab-onsets` hides the lab detector lines.

### synth: fake session for testing without a human

```sh
$LAB synth --out synth.gkrec [--reps 20] [--seed 7] [--noise 0.0015]
$LAB replay synth.gkrec
```

Taps are damped sinusoids with a per-zone direction, frequency and decay; negatives contain typing and trackpad
impulses with matching key and mouse timestamps. Good for checking the pipeline, not for judging accuracy.

## File format (.gkrec)

```
"GKREC\0\0\x01"            8 bytes magic
UInt32 LE                  header length H
H bytes                    JSON header
Float32 LE arrays          in the order of header.arrays: imu.t, imu.ax..az (g), imu.gx..gz (deg/s),
                           act.t, act.sinceKey, act.sinceMouse, act.flags
```

Times are seconds from the first sample. The header holds the zones, reps, and `segments`: phase (`capture`,
`negatives`, `rest`), zone, start, end, the tap onsets found while recording, and whether the segment was discarded.
Accelerometer and gyroscope come from separate reports at about 797 Hz each; each stored sample is one accelerometer
report paired with the latest gyroscope report. Activity is `CGEventSource.secondsSinceLastEventType` polled at
100 Hz (key down; mouse = any move, click, drag or scroll) and the modifier flags (shift, control, option,
command, fn bits of `CGEventFlags`).

Python:

```python
import json, struct, numpy as np
b = open("session.gkrec", "rb").read()
n = struct.unpack_from("<I", b, 8)[0]; h = json.loads(b[12:12 + n]); off = 12 + n; cols = {}
for a in h["arrays"]:
    cols[a["name"]] = np.frombuffer(b, "<f4", a["count"], off); off += 4 * a["count"]
```

## Sensor access

For the accelerometer and gyroscope `AppleSPUHIDDriver` services only: reads `ReportInterval`, sets
`SensorPropertyReportingState=1`, `SensorPropertyPowerState=1` (only if the driver was idle) and `ReportInterval=1250`,
then opens the `AppleSPUHIDDevice` services with page 0xFF00, usage 3 and 9. On exit it writes the original
`ReportInterval` back and switches the state properties off again only if it switched them on.
