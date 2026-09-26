---
title: Troubleshooting
description: False triggers, missed taps, lap use, the typing gate, missing sensors, permission issues, and a full uninstall.
order: 10
---

## False triggers

A tap firing when you didn't mean to tap:

- **Recalibrate the zone.** Most false triggers come from a zone the classifier hasn't learned cleanly yet, not from a setting.
- **Lower sensitivity a little.** This raises the bar a movement has to clear before Ghostkeys treats it as a candidate tap at all.
- **Move the zone off a resting spot,** or switch its gesture to a double tap instead of a single tap (see [Zones](03-zones.md) and [Gestures](04-gestures.md)). Palm rests are the most common source of this, since your hand naturally rests there.
- **Check what Ghostkeys says it rejected.** Ghostkeys shows the reason it threw out a candidate tap: recent typing, recent trackpad use, general motion, a burst of several taps close together (treated as rattling, not intent), or low confidence from the classifier. That reason tells you which gate to adjust.

## Missed taps

A tap that doesn't register at all:

- **Raise sensitivity a little,** if taps genuinely aren't being felt at all.
- **Recalibrate with more, cleaner taps**, ideally with the same finger and motion you use day to day.
- **Tap in the middle of the zone**, not right at its edge.
- **Check it isn't being rejected as typing or a trackpad click.** If you tap right after typing or clicking, within the typing gate window (see below), it's deliberately ignored.

## Lap use

Ghostkeys works on your lap, but expect somewhat more rejected taps there than on a desk: your lap naturally shifts and settles under you, and Ghostkeys treats real motion of the laptop (as opposed to a sharp, local tap) as a reason to reject a candidate, so it doesn't mistake you adjusting your position for an intentional tap. If you use your Mac on your lap most of the time, calibrate there rather than at a desk; see [posture in Calibration](02-calibration.md).

## The typing gate

Ghostkeys ignores any candidate tap that lands too soon after your last keystroke or trackpad click, by default under half a second. This is what stops the vibration from typing itself from being read as a tap. If you often want to tap a zone immediately after typing a word and it's getting swallowed, you can shorten this gate in settings, but shortening it too far will let more real typing vibration back in as false triggers. It's a trade-off, not a bug to eliminate entirely.

## Sensors missing on older Macs

Ghostkeys needs the motion sensor hardware that streams on Apple silicon; see [Compatibility](11-compatibility.md) for exactly which Macs are fully supported, limited, or unsupported. If you're not sure what your Mac can actually stream, run:

```
ghostkeysd --selftest
```

from a Terminal in the `daemon` folder (or wherever the built binary lives). It opens the sensors for a few seconds and prints exactly what streamed and at what rate: the accelerometer, gyroscope, lid angle, and light sensor, each marked available or not. If the accelerometer doesn't stream at all, Ghostkeys cannot work on that Mac, and this is how you confirm it either way.

## Accessibility permission issues

- **Grant it under System Settings → Privacy & Security → Accessibility.** Ghostkeys should appear in the list once you've opened it once.
- **If it doesn't seem to take effect, toggle it off and back on** for Ghostkeys in that same list.
- **If you're a developer and rebuilt the daemon,** macOS treats a rebuilt binary as new and may ask you to re-grant Accessibility for it, separately from the app.
- **If a specific action still fails after granting it,** confirm you granted it to Ghostkeys itself and not a different app with a similar name; also confirm the action you're testing actually needs it (volume and mute don't, see [Getting started](01-getting-started.md)).

## Full uninstall

1. Quit Ghostkeys.
2. Delete the Ghostkeys app from your Applications folder.
3. Delete `~/Library/Application Support/Ghostkeys/`, which holds your configuration, your trained model, and your calibration samples. This is the only folder Ghostkeys ever wrote to.

That's everything. There's no login item, no launch daemon, and no kernel extension to remove, because Ghostkeys never installs any of those. If you'd also like to revoke the Accessibility permission you granted, remove Ghostkeys from the list under System Settings → Privacy & Security → Accessibility; this is optional cleanup, since the permission does nothing once the app it was granted to is gone.
