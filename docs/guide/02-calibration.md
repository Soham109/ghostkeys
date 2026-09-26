---
title: Calibration
description: How to calibrate well, what posture profiles mean, and when to recalibrate.
order: 2
---

Calibration is how Ghostkeys learns what your taps look like. It has two parts for each zone you want to use: you tap the zone a set number of times (the default is 20, and yours may differ), and then you keep typing and using the trackpad normally for a while so Ghostkeys can learn what a tap is *not*. Nothing you bind will fire during calibration, so tap freely.

## How calibration works, briefly

Every tap is turned into a set of physical measurements: which direction the force pointed, how hard it hit, how the case twisted, and how the vibration rang and decayed. A palm rest (backed by the battery), a speaker grille (a thin perforated sheet), and the lid (a long, hinge-mounted cantilever) all ring differently, so these measurements are usually enough to tell zones apart. Calibration is what teaches Ghostkeys the pattern for your zones, on your specific Mac, in your hands.

When you finish, Ghostkeys tests the model against your own samples (it holds back a slice of them, trains on the rest, and repeats this several times so every tap gets tested once) and reports an overall accuracy plus one accuracy number per zone. If one zone's number is noticeably lower than the rest, or a confusion shows two zones being mixed up, that zone likely needs more taps, a different position, or more separation from its neighbor. See [Zones](03-zones.md) for what makes zones easy to tell apart.

## How to calibrate well

- **Tap the way you actually will later.** Use the finger and the motion you'll naturally use day to day. Calibrating with unusually hard or unusually soft taps teaches Ghostkeys the wrong thing.
- **Tap inside the zone, not its edge.** A tap near the border of two zones is genuinely ambiguous to the sensor, not just to you.
- **Do the negatives step for real.** When Ghostkeys asks you to type and use the trackpad normally, actually do that (write a sentence, click around, scroll) rather than sitting still. During this step, gates that normally filter out keystrokes and clicks are turned off on purpose, so every bit of vibration from your normal use gets captured and labeled as "not a tap." Skipping this, or sitting idle, is the single most common cause of taps being missed later during typing.
- **Redo a zone that comes back weak.** A low per-zone accuracy or a confusion between two zones in the results means recalibrating (with more taps, or in a cleaner, more consistent position) will help more than raising sensitivity in settings.

## Posture profiles

Ghostkeys keeps one trained model at a time; it doesn't currently store several profiles you can switch between. So "posture" is something to plan for going into calibration, not a setting you flip afterward:

- If you almost always use your Mac in one position (desk, propped up, on your lap), calibrate in that position. The model will fit it best.
- If you regularly switch between very different positions, for example a desk most of the day and your lap in the evening, do some of your calibration taps in each position. A model trained across both generalizes better than one trained in only one.
- If you settle into a new setup for good (a new desk height, a new habitual position), recalibrate. The old model was fit to the old conditions.

Ghostkeys keeps your raw labeled taps on disk after calibration finishes, specifically so that improvements to the classifier can retrain from them later without asking you to tap through calibration again.

## Recalibrating

Run calibration again the same way you did the first time, from Ghostkeys' calibration screen. Starting a new calibration session replaces the model you're training from scratch: it does not build on top of the old one. Once you finish and it saves, the new model takes over immediately.

Recalibrate when:

- You've drawn a new zone, moved one, or deleted one.
- Ghostkeys keeps missing taps in a zone you use often, or keeps confusing two zones for each other.
- Your typical posture has changed for good (see above).
- You're on a different Mac (a trained model isn't portable between machines, or even between users on the same machine).

You don't need to recalibrate after every small tweak. Adjusting sensitivity, the double-tap timing window, or the typing gate in settings changes how existing detections are filtered and grouped; it doesn't touch the trained model itself.
