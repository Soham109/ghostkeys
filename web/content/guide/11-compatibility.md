---
title: Compatibility
description: Which Macs are fully supported, which are limited, and what's planned.
order: 11
---

Ghostkeys needs Apple silicon. The motion sensor it streams from only reports the way Ghostkeys needs on M-series Macs; Intel Macs don't expose it at all, no matter how new the machine otherwise is.

| Tier | Macs | What to expect |
| --- | --- | --- |
| **Full support** | MacBook Pro and MacBook Air with M1 Pro, M1 Max, or M2 and later (M2, M3, M4, M5, and Pro/Max variants) | Every zone, every gesture, full accuracy. Ghostkeys recognizes newer, not-yet-listed Apple silicon MacBooks automatically by screen size, so a brand-new model still works even before its exact identifier is added to the built-in list. |
| **Sound mode and sonar add-on** | Any Mac with a working microphone and, for sonar, working built-in speakers | Tap type (fingertip, knuckle, nail), rubs and swipes heard through the microphone, plus sonar's in-air hover, push, pull, sweep and finger-slide gestures, played and heard through two inaudible tones. Off by default. Built and wired into the daemon, but tested so far against synthetic audio rather than real microphones and speakers; see [Sound mode](07-sound-mode.md), including how to check your own Mac's real numbers with `ghostkeys-lab sonar-bench`. |
| **Camera add-on** | M4 and M5 Macs | Adds the optional in-air and Desk View gestures described in [Camera add-on](08-camera-add-on.md), on top of full support. Built and wired into the daemon, but tested so far against synthetic hand movement rather than a real camera. |
| **Limited** | Base M1 (the 2020 MacBook Air 13" and 2020 13" MacBook Pro) | These Macs don't publish the motion sensor that taps rely on, so tap zones don't work. Covering the light sensor works. Sound mode's rubs, waves and sonar gestures don't need that sensor either, so they should work the same as anywhere else, though that hasn't specifically been checked on this tier yet. Telling a knuckle tap from a fingertip does need it, since that only works alongside a tap the motion sensor already found, so that part doesn't apply here. |
| **Not supported** | Any Intel MacBook | No streaming motion sensor exists on this hardware, so Ghostkeys cannot detect taps at all, regardless of the rest of the machine's specs. |
| **Windows** | Any Windows laptop | A separate port, `ghostkeysd-win`, lives in this repository's `windows/` folder and speaks the same protocol as the Mac daemon. It compiles for Windows and passes its own test suite on macOS, but it has not yet been run on a real Windows machine. See [For developers](13-developers.md) for what works differently there. |

One more requirement applies everywhere on the Mac side: macOS 14 (Sonoma) or later. Ghostkeys mostly identifies your exact model directly; the one case where it also checks your built-in screen size is as a fallback, for a brand-new model it doesn't recognize yet, so this only matters if you're using such a Mac in clamshell mode with an external display before Ghostkeys has been updated to know it.

If you're ever unsure what your specific machine actually streams, `ghostkeysd --selftest` (see [Troubleshooting](10-troubleshooting.md)) tells you directly rather than leaving it to a table.
