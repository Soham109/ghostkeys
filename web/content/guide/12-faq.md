---
title: FAQ
description: Common questions about how Ghostkeys works day to day.
order: 12
---

**Does Ghostkeys read what I type?**
No. It only measures the vibration your keystrokes cause, as a way to tell them apart from a tap on the case. It never sees which keys you pressed or what the text was. See [Privacy and safety](09-privacy-and-safety.md).

**Does it need the internet?**
No. Ghostkeys never makes a network connection of any kind. The daemon and the app talk to each other over a WebSocket that only your own Mac can reach.

**Will it slow my Mac down or drain the battery?**
Ghostkeys keeps the motion sensor streaming continuously while it's running, so there is some small, ongoing cost in the background, the same way any app that watches a live sensor has one. We haven't published exact battery numbers yet.

**Does covering the camera to mute my mic actually turn on the camera?**
No. The "cover" and "cover hold" gestures read the ambient light sensor next to the camera, not the camera lens itself. Nothing about them turns on the camera or its indicator light.

**Can I use Ghostkeys gestures on a video call?**
Yes. Bindings can be scoped to a specific app, so you can, for example, bind a tap to mute yourself in Zoom specifically, without that same tap doing anything (or doing something else) in every other app. See [Actions](05-actions.md).

**What happens when I close the lid or my Mac goes to sleep?**
Like any other background app, Ghostkeys stops doing anything while your Mac is asleep, and picks back up automatically once it wakes.

**Can the same zone have more than one gesture bound to it?**
Yes. A tap, a double tap, a triple tap, and a rhythm can each have their own separate binding in the same zone; Ghostkeys tells them apart by the gesture itself, not just the zone.

**Can I see Ghostkeys detecting taps without granting any permission?**
Yes. Detection and the live visualizer work without Accessibility. You'll only notice a difference once a binding tries to actually run an action that needs it (see [Getting started](01-getting-started.md) for which actions do).

**Will Ghostkeys conflict with trackpad gestures or normal typing?**
It's built specifically to avoid that: recent trackpad activity and recent keystrokes both suppress candidate taps for a short window, and a burst of several closely spaced spikes (like rattling or fast typing) is treated as noise rather than a series of taps.

**Can I use an external keyboard, mouse, or display?**
Yes. Ghostkeys reads the sensors built into the physical laptop itself, which are unaffected by whatever you have plugged in.

**Is there a paid tier or a license?**
Not something this guide covers; check the Ghostkeys site for the current state of pricing and licensing.

**What if my question isn't answered here?**
Start with [Troubleshooting](10-troubleshooting.md) for anything behavior-related, or [Privacy and safety](09-privacy-and-safety.md) for anything about what Ghostkeys reads or stores.
