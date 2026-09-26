---
title: Camera add-on
description: An optional add-on, still in development, for gestures made in the air above your keyboard.
order: 8
---

The camera add-on is optional and still in development: the underlying hand-tracking is built and being tested, but it isn't wired into a released version of Ghostkeys yet. This page describes what it's designed to do.

## What it needs

The camera add-on needs an M4 or M5 Mac. Tracking a hand in real time, every frame, without lag takes real on-device processing power, and that's the generation Ghostkeys is targeting first.

## What it's designed to do

Instead of a tap on the case, this add-on reads your hand moving in the air in front of the built-in camera, using Apple's on-device hand-tracking (nothing is sent anywhere to recognize a hand). Planned gestures:

- **Air tap.** A quick pinch of thumb and index finger, held briefly and released.
- **Pinch hold.** Hold that pinch and it becomes a continuous control, like a knob, that reports how far you've moved while held.
- **Pinch drag** (left, right, up, down). Pinch, then move decisively in one direction.
- **Palm swipe** (left, right). An open hand swept to one side.
- **Two-hand zoom.** Pinch with both hands and move them apart or together, like a photo pinch-zoom, scaled by the change in distance between your two hands.
- **Point.** Extend just your index finger to move a pointer, mapped from a region in front of the camera so you don't have to reach the edges of frame.

On Macs with Apple's Desk View camera, there's a further, more experimental layer: mapping your fingertips onto the palm-rest area itself, so a finger resting and dwelling there counts as a real touch (not just a hover), with a circular finger motion recognized as a turning knob. This part needs Desk View specifically (a top-down view of your desk that some Mac and display cameras support) and is earlier-stage than the in-air gestures above.

## The green camera light

Your Mac's camera indicator is a hardware light wired directly to the camera sensor. It lights whenever the sensor is capturing, and no software, including Ghostkeys, can turn the camera on without it. If the light isn't on, the camera add-on isn't seeing anything.

Camera sessions are also designed to be short and deliberate rather than always-on: a session has a hard maximum length, after which it stops itself even if you forget to. The camera also drops to a slower capture rate whenever no hand is in frame, and speeds back up the moment one appears.

## Limits

- It needs a hand actually in frame, in reasonable lighting; a hand at the very edge of the camera's view, too small in frame, or partly hidden won't track reliably.
- It's a short, on-demand session, not a background feature: you turn it on for a stretch of use, not leave it running all day, and it has a hard time limit per session either way.
- Apple's Center Stage framing (which crops and pans to follow your face) is deliberately turned off during a session, since it would shift the image under your hand mid-gesture.
- The Desk View knob and touch mapping is the experimental part of this add-on: Apple doesn't publish the exact geometry of that camera view, so it relies on a model of the picture that a one-time calibration (touching the four corners of your palm-rest area) refines.

Camera-based gestures are off by default and will stay off until you explicitly turn the add-on on.
