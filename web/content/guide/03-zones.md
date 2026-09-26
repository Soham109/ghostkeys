---
title: Zones
description: Drawing zones, recommended layouts per Mac model, and what makes zones easy to tell apart.
order: 3
---

A zone is a rectangle you draw on a blank part of your Mac's case. Each zone becomes its own class that Ghostkeys' classifier learns during calibration: a tap either lands in one of your zones, or it's rejected as "not a tap" (typing, trackpad use, or just handling the laptop).

## Drawing a zone

In Ghostkeys' zone editor you draw directly on a top-down outline of your Mac. Each zone has:

- A **surface**: `base` (the palm rests, grilles, and top strip all sit on the base), `lid` (the outside of the lid, only reachable while it's closed or from behind), `edge-left`, or `edge-right`.
- A **rectangle**, in coordinates from 0 to 1 across the surface (0 is the left edge or the hinge, 1 is the right edge or the front lip).
- A **name** and a **color**, so it's easy to recognize in the bindings list and in the live tap visualizer.

You can't draw a zone on top of the keyboard or the trackpad. Those areas are always excluded, since a tap there is either typing or a trackpad click, not a Ghostkeys gesture.

## Recommended layouts per Mac model

Ghostkeys starts you off with a layout based on the Mac model you confirmed during setup, because the case shape genuinely differs between models:

| Zone | MacBook Pro (14" / 16") | MacBook Air (13" / 15") |
| --- | --- | --- |
| Left / right palm rest | Yes | Yes |
| Left / right speaker grille | Yes, a narrow strip beside the keyboard | Not offered: the Air's case has no separate exposed grille to tap |
| Top strip (above the keyboard) | Yes | Yes |
| Left / right edge | Yes | Yes, and does double duty for the volume taps a Pro would put on its grilles |
| Back of the lid | Yes | Yes |

You can always redraw, resize, rename, or delete any starting zone, or add your own. The starting layout is a reasonable default, not a limit.

## What makes zones easy to tell apart

Ghostkeys tells zones apart using physics, not guesswork: where a tap lands decides which direction the impulse points, how much it twists the case (a tap left of center twists the opposite way from a tap right of center), and how the local structure rings and decays. That means some zone layouts are naturally easier for it to learn than others.

Zones separate well when:

- **They sit on structurally different parts of the case.** A palm rest (backed by the battery), a grille (a thin perforated sheet), an edge, and the lid (a long cantilever off the hinge) all ring at different frequencies and decay at different rates. Putting zones on different structures is the single best thing you can do for accuracy.
- **They're far enough apart to twist the case differently.** Two zones side by side on the same flat panel produce a very similar signal, because the lever arm between them is short. Spacing zones out, especially left-to-right or front-to-back, gives the classifier a clear twist to key off.
- **They're a reasonable size.** A zone that's too small invites taps near its edge, which are genuinely ambiguous between it and its neighbor.

Zones separate poorly when you draw several small zones crowded into the same small area of the same panel. If your calibration report shows two zones confused for each other (or a lower accuracy on one of them), the fix is usually to widen the gap between them, make one or both larger, or merge them into a single zone with more than one gesture bound to it.
