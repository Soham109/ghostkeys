---
title: Compatibility
description: Which Macs are fully supported, which are limited, and what's planned.
order: 11
---

Ghostkeys needs Apple silicon. The motion sensor it streams from only reports the way Ghostkeys needs on M-series Macs; Intel Macs don't expose it at all, no matter how new the machine otherwise is.

| Tier | Macs | What to expect |
| --- | --- | --- |
| **Full support** | MacBook Pro and MacBook Air with M1 Pro, M1 Max, or M2 and later (M2, M3, M4, M5, and Pro/Max variants) | Every zone, every gesture, full accuracy. Ghostkeys recognizes newer, not-yet-listed Apple silicon MacBooks automatically by screen size, so a brand-new model still works even before its exact identifier is added to the built-in list. |
| **Camera add-on** | M4 and M5 Macs | Adds the optional in-air and Desk View gestures described in [Camera add-on](08-camera-add-on.md), on top of full support. Still in development. |
| **Limited** | Base M1 (the 2020 MacBook Air 13" and 2020 13" MacBook Pro) | These Macs don't publish the motion sensor that taps rely on, so tap zones don't work. Covering the light sensor works. Sound and sonar gestures, which use the microphone and speakers instead, are planned for these Macs. |
| **Not supported** | Any Intel MacBook | No streaming motion sensor exists on this hardware, so Ghostkeys cannot detect taps at all, regardless of the rest of the machine's specs. |
| **Planned** | Windows | Not available yet. Everything Ghostkeys does today is built on macOS-specific sensor and system APIs; Windows support is a future direction, not a current target. |

One more requirement applies everywhere: macOS 14 (Sonoma) or later. Ghostkeys mostly identifies your exact model directly; the one case where it also checks your built-in screen size is as a fallback, for a brand-new model it doesn't recognize yet, so this only matters if you're using such a Mac in clamshell mode with an external display before Ghostkeys has been updated to know it.

If you're ever unsure what your specific machine actually streams, `ghostkeysd --selftest` (see [Troubleshooting](10-troubleshooting.md)) tells you directly rather than leaving it to a table.
