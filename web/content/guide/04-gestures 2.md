---
title: Gestures
description: Every gesture Ghostkeys recognizes, how to perform it, and which surfaces suit which gestures.
order: 4
---

A gesture is the pattern Ghostkeys matches your taps and movements against. Once a gesture is recognized, Ghostkeys looks up what you bound it to and runs that action. Every gesture can also require modifier keys (shift, control, option, command, fn) held at the moment it fires, so the same tap can mean something different while you're holding shift.

## Tap-based gestures

These happen in one zone (or, for a sequence, across two).

**Tap.** One tap in a zone. If nothing else is bound to a double, triple, rhythm, or sequence in that same zone, a tap fires the instant it's detected, with no waiting.

**Double.** Two taps in the same zone, close enough together (roughly a tenth of a second to a third of a second apart) to count as one gesture rather than two separate taps. Taps faster than that are treated as a single bouncy tap, not a double.

**Triple.** A third tap in the same zone, inside that same window after the second one.

**Sequence.** A tap in one zone, then a tap in a different zone shortly after (within about half a second). Bind it to two zones in a specific order, for example left palm rest then right palm rest. This is a good way to get one more distinct gesture out of two zones you're already using for single taps, since it needs both zones in order and won't be triggered by tapping either one alone.

**Rhythm.** A tap, a deliberate pause (roughly a third of a second to just under a second), then a double tap in the same zone. It reads as "tap... tap-tap" and replaces what would otherwise be a plain double tap in that spot. Use it when you want a second, more deliberate action layered onto a zone that already has a double tap bound to something you reach for more casually.

To perform any of these cleanly: tap with a consistent motion, inside the zone rather than at its edge, and don't rest your hand on the zone right before or after (see [Troubleshooting](10-troubleshooting.md) if taps are being missed or misread).

## Whole-machine gestures

These aren't tied to a zone at all, so they can't be bound per zone, only per modifier.

**Lid nudge.** Push the lid back a little, or pull it slightly forward, and let it return. It has to move a noticeable amount (roughly 3 to 15 degrees) quickly, and come back close to where it started within about a second and a half. A small, slow drift while you're adjusting the screen angle on purpose won't trigger it.

**Tilt left / tilt right.** Roll the whole laptop over to one side (more than about 8 degrees) and bring it back level within a couple of seconds. Feels like tipping the machine like a steering wheel and straightening it back out.

**Cover.** Briefly cover the ambient light sensor (near the camera) with your hand or a finger, then uncover it within about 2 seconds. The room has to be reasonably lit for this to register; it's ignored in an already-dark room, since covering the sensor changes nothing measurable there.

**Cover hold.** Cover the light sensor and keep it covered for more than about 1.2 seconds. This is a separate gesture from a quick cover, and only one of the two fires per cover: a hold doesn't also fire a second event when you finally uncover it.

## Which surfaces suit which gestures

- **Palm rests: prefer double taps.** Your hands already rest here while you type, so single taps are the ones most likely to fire by accident from ordinary contact. A double tap is a deliberate, unambiguous signal that you meant it.
- **Speaker grilles and edges: single taps work well.** These aren't resting surfaces, so an accidental tap is much less likely, and a quick single tap (for something you reach for often, like volume) feels natural.
- **Top strip: good for a distinctive gesture you don't want to fire by accident.** Bind a triple tap, or a tap with a modifier held, to something you use rarely but want available fast, like an area screenshot.
- **The lid: good for taps while it's closed.** Since you can't be typing at the same time, taps here have less to be confused with. Useful for a quick action you'd otherwise need to open the laptop for.
- **Sequences: pick two zones that are far apart,** like the two palm rests, or a palm rest and an edge. That keeps a sequence from being confused with two independent single taps.
