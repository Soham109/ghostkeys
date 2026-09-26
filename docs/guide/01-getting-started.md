---
title: Getting started
description: Install Ghostkeys, launch it for the first time, and grant the permissions it needs.
order: 1
---

Ghostkeys turns the blank aluminum on your MacBook (the palm rests, the speaker grilles, the strip above the keyboard, the edges, the lid) into taps you can bind to shortcuts. It reads the motion sensor, the lid-angle sensor, and the ambient light sensor that are already built into your Mac. No extra hardware, nothing plugged in.

## Install

Move the Ghostkeys app to your Applications folder and open it.

Because Ghostkeys is a young, independently distributed app, macOS Gatekeeper may say it's from an unidentified developer the first time you open it. Right-click (or Control-click) the app and choose **Open**, then confirm. You only need to do this once.

When Ghostkeys opens, it starts a small background helper called `ghostkeysd`. This is the piece that actually reads the sensors. You never open or run it yourself; the app starts it and closes it for you, and it quits automatically when you quit Ghostkeys.

## First launch

The first time Ghostkeys opens, it walks you through four steps:

1. **Welcome.** A short introduction to what Ghostkeys does.
2. **Your Mac.** Ghostkeys detects your model automatically (it reads your Mac's model identifier, and falls back to your screen size if it doesn't recognize the exact identifier). Confirm it, or pick your model by hand if it guessed wrong. This choice decides where your starting zones go, since a 14-inch MacBook Pro and a 13-inch MacBook Air have different case shapes.
3. **Accessibility.** Ghostkeys asks for the Accessibility permission (see below). You can skip this and grant it later, but most actions won't run until you do.
4. **Calibrate.** A short guided session where you tap each zone a few times and then use your laptop normally for a bit, so Ghostkeys can tell your taps apart from typing and trackpad use. See [Calibration](02-calibration.md).

## Permissions, and why each one matters

Ghostkeys asks for exactly two things, and only when a feature needs them. It never asks for your password and never asks to be an admin.

**Accessibility.** This is the one real permission Ghostkeys needs. Without it, Ghostkeys can still detect taps and gestures and show them in its interface, but it cannot run most actions:

- Keyboard shortcuts, typed text, media keys (play/pause, next, previous), and brightness steps are all sent as system key events, which macOS only allows for apps you've trusted under **System Settings → Privacy & Security → Accessibility**.
- Window actions (snapping a window left, maximizing it, moving it to another display) and app actions (hide, quit, switch app) read and move the frontmost window through the same Accessibility API.
- Two things work without it: **volume** and **mute**, which go through a different system call that doesn't need Accessibility. If you haven't granted it yet, these are worth testing first to see Ghostkeys do something end to end.

Grant it from the onboarding screen, or later from Ghostkeys' own settings, or directly in System Settings. If you ever rebuild or update the helper binary yourself (developers only), macOS may treat it as a new program and ask you to re-grant the permission.

**Camera** (only if you turn on the camera add-on). Ghostkeys never opens your camera unless you explicitly turn this optional feature on. See [Camera add-on](08-camera-add-on.md).

Two other macOS prompts can show up the first time you use a specific action, and they come from macOS itself, not from a Ghostkeys onboarding step:

- **Screen Recording**, the first time you bind a screenshot action.
- **Automation**, the first time an AppleScript or app-integration action controls a specific app (for example Excel or Zoom). Each app you control this way gets its own one-time prompt.

Ghostkeys never asks for anything beyond this. It has no network permission to ask for, because it never talks to the network at all: everything runs locally on `127.0.0.1`. See [Privacy and safety](09-privacy-and-safety.md) for the full picture.
