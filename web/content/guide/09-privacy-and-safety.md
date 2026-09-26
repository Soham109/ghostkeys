---
title: Privacy and safety
description: Exactly what Ghostkeys reads, what it never stores, and what it never does.
order: 9
---

## What Ghostkeys reads

- **The motion sensor** (accelerometer and gyroscope), streamed fast enough to catch the shockwave of a tap through the case.
- **The lid-angle sensor**, for lid nudges.
- **The ambient light sensor**, for cover gestures.
- **Whether you're currently typing or clicking**, as a timer (how long since your last keystroke or click), used only to tell a tap on the case apart from a keystroke or a trackpad click. Ghostkeys never reads which key you pressed or what you typed; it only knows "was there a key or click recently," the same way a screensaver knows you've gone idle.
- **Which app is frontmost**, by bundle identifier only (for example `com.microsoft.Excel`), so a binding can be scoped to one app.

That's the complete list. There is no camera or microphone input unless you explicitly turn on the optional camera or sound add-ons, and even then, only while a session is active.

## What Ghostkeys never does

- Never asks for `sudo` or an admin password, and never will.
- Never installs a kernel extension, a launch daemon, or a login item.
- Never changes a System Settings toggle on your behalf.
- Never talks to the network. The only channel it opens is a WebSocket bound to `127.0.0.1`, your own machine, so nothing it does can leave your laptop. There is no telemetry and no account.
- Never reads what you type. It only classifies whether a physical tap on the case happened, and where.
- Never runs an action unless it matches a gesture you configured yourself, or you press "test" inside the app. Pausing Ghostkeys stops every action immediately, with no delay.
- Never writes anything to disk outside `~/Library/Application Support/Ghostkeys/`, which holds your configuration, your trained model, and your calibration samples. Nothing else on your Mac is touched.
- The `shell` action never runs with elevated privileges, and always has a time limit so a stuck command can't hang forever.

## Sensor settings, and why they're restored on quit

To stream the motion sensor at all, Ghostkeys briefly adjusts a couple of low-level settings on the sensor driver (how often it reports, and whether it's actively powered). Before it changes anything, it reads and remembers exactly what was there. When it quits, whether you quit it normally, it crashes, or the system shuts it down, it puts those settings back exactly as it found them. Even in the rare case it can't (a hard force-quit that doesn't give it the chance), none of this survives a reboot anyway: it's the kind of low-level setting that resets on its own.

## No admin rights, ever

Every action kind Ghostkeys can run is deliberately chosen to need nothing more than the permissions described in [Getting started](01-getting-started.md): Accessibility for keyboard, text, media, brightness, and window actions; nothing at all for volume and mute; and macOS's own one-time Screen Recording or Automation prompts for specific actions like screenshots or controlling another app by name. None of these, individually or together, can grant an admin password or install anything.

## No network, full stop

Ghostkeys' daemon and its app talk to each other over a WebSocket that only listens on `127.0.0.1`, meaning only your own Mac can ever connect to it; it isn't reachable from your local network, let alone the internet. There's no server anywhere else it talks to, no update check that phones home, and no analytics.
