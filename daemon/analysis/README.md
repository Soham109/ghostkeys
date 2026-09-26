# daemon/analysis

Numeric (plot-free) analysis of real lab recordings, used to tune `GhostkeysDetection`.

## Setup

```sh
cd daemon/analysis
python3 -m venv --system-site-packages .venv          # numpy, scipy, scikit-learn, pandas
../.build-lab/debug/ghostkeys-lab export ../../session1.gkrec --csv data/session1
```

`.venv/` and `data/` are gitignored: the data is regenerated from the `.gkrec` file.

## Files

- `gk.py`: loaders plus Python mirrors of the Swift code: detection level (15 Hz high-pass magnitude), gravity low-pass, onset detector, the 33 features. Keep it in step with `Sources/GhostkeysDetection` when that changes.
- `motion_gate_eval.py data/session1`: compares motion-gate variants. For each it reports how many recorded taps it would gate (bad) and how much of the repositioning period between phases it flags (good).
- `separability.py data/session1`: per-zone feature medians, and leave-one-out accuracy of LDA and 5-nearest-neighbours for 3 zones and for each zone pair. It runs on two tap sets:
  - the lab tool's recorded onsets;
  - every engine onset inside a capture phase, labelled with that phase's zone.

## Findings from session1 (26 Sep 2026)

This recording is partial: left-palm, right-palm and left-grille, with the Mac on a lap.

- **Motion gate.** On a lap, a palm tap rocks the machine. The 50 ms gravity estimate turned 1 to 6 degrees per tap, so the old gate (3 degrees within 0.5 s) gated 24 of 61 taps. The new gate gates 0 of 61 and still flags 67% of the repositioning period. It uses:
  - a 200 ms low-pass;
  - a 150 ms freeze after each onset;
  - a 150 ms persistence requirement.
- **Pulse widths, measured as time above half the pulse's own peak.**
  - Taps: left-palm 50 to 90 ms, right-palm 34 to 39 ms, grille 16 to 41 ms.
  - Handling the machine: mostly 150 ms or more.
- **Ground truth is incomplete.** The recorded onsets come from the lab tool's own simple detector. It missed long runs of regular 0.4 s-spaced taps, for example right-palm 48.8 to 61.7 s and grille 108.7 to 114.5 s. So "extra taps" in `replay` are mostly real, unlabelled taps.
- **Separability.** Leave-one-out LDA gives 0.97 for 3 zones, and 0.97 to 1.00 per pair on the recorded taps. With only the force-independent features it is 0.93 to 0.98.
- **Caveats.**
  - Each zone was recorded in its own block, so posture drift between blocks may help. An interleaved recording would settle it.
  - Right-palm taps were much harder than the others.
  - Left-palm twist is near zero where physics predicts negative.
  - Almost all spectral energy is below 60 Hz, so the band features carry little on this data.
