---
title: Camera add-on
description: An optional add-on, still in development, for gestures made in the air above your keyboard.
order: 8
---

The camera add-on is optional and still in development. The gesture-recognition logic is built and wired into the daemon, and it's been tested against synthetic hand movement, but the code that actually opens the camera has not yet been run against real hardware, so treat this page as accurate to the design rather than to something fully proven yet.

## What it needs

The camera add-on needs an M4 or M5 Mac. Tracking a hand in real time, every frame, without lag takes real on-device processing power, and that's the generation Ghostkeys is targeting first.

## What it's designed to do

Instead of a tap on the case, this add-on reads your hand moving in the air in front of the built-in camera, using Apple's on-device hand-tracking (nothing is sent anywhere to recognize a hand). Gestures:

- **Air tap.** A quick pinch of thumb and index finger, held briefly and released.
- **Pinch hold.** Hold that pinch a little longer and it becomes a continuous control, like a knob, that reports how far you've moved while held.
- **Pinch drag** (left, right, up, down). Pinch, then move decisively in one direction.
- **Palm swipe** (left, right). An open hand swept to one side.
- **Two-hand zoom.** Pinch with both hands and move them apart or together, like a photo pinch-zoom, scaled by the change in distance between your two hands.
- **Point.** Extend just your index finger to move a pointer, mapped from a region in front of the camera so you don't have to reach the edges of frame.
- **Circle.** Draw a small circle with a finger or the pointer, clockwise or counterclockwise, and Ghostkeys counts it in steps, one for every 30 degrees turned, like a scroll wheel.

On Macs with Apple's Desk View camera, there's a further, more experimental layer: mapping your fingertips onto the palm-rest area itself, so a finger there can register as a real touch rather than a hover, and the same circle gesture works as a turning knob on the desk surface too. Because a camera looking straight down can't tell height apart from a still finger, a touch only counts once the motion sensor also feels an actual tap; a finger that's merely resting still doesn't count on its own. This needs Desk View specifically (a top-down view of your desk that some Mac and display cameras support) and is earlier-stage than the in-air gestures above.

## The green camera light

Your Mac's camera indicator is a hardware light wired directly to the camera sensor. It lights whenever the sensor is capturing, and no software, including Ghostkeys, can turn the camera on without it. If the light isn't on, the camera add-on isn't seeing anything.

Camera sessions are also designed to be short and deliberate rather than always-on: a session starts when you ask for it, or, if you've set it up that way, automatically while a chosen app is in front, runs for 30 seconds by default and never more than 120, and stops itself early after about 10 seconds with no hand in frame, when you pause Ghostkeys, or when the lid closes. The camera also drops to a slower capture rate whenever no hand is in frame, and speeds back up the moment one appears.

## Limits

- It needs a hand actually in frame, in reasonable lighting; a hand at the very edge of the camera's view, too small in frame, wearing a glove, or partly hidden won't track reliably. Which hand is which (left versus right) is sometimes read wrong too.
- It's a short, on-demand session, not a background feature: you turn it on for a stretch of use, not leave it running all day, and it has a hard time limit per session either way.
- Apple's Center Stage framing (which crops and pans to follow your face) is deliberately turned off during a session, since it would shift the image under your hand mid-gesture.
- The Desk View knob and touch mapping is the experimental part of this add-on: Apple doesn't publish the exact geometry of that camera view, so it relies on a model of the picture that a one-time calibration (touching the four corners of your palm-rest area) refines, and that model hasn't yet been checked against a real Desk View image. It's also possible the built-in camera simply can't see the palm rests well at normal screen angles, in which case desk mode would need a different angle to work at all.

Camera-based gestures are off by default and will stay off until you explicitly turn the add-on on.
