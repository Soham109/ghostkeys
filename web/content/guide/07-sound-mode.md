---
title: Sound mode
description: An optional add-on that listens for taps through the microphone, plus an inaudible sonar for gestures made in the air.
order: 7
---

Sound mode, including sonar, is an optional add-on that's still in development. The detection logic is built and wired into the daemon, and it's been tested against synthetic audio and, for sonar, one real-hardware check tool (below), but not yet broadly against real microphones and speakers. It's off by default either way, and something you turn on, not something that's listening until you do.

## What it's designed to listen to

Sound mode uses your Mac's built-in microphone to hear a tap, not just feel it through the motion sensor. That adds gesture types the motion sensor alone can't tell apart:

- **Tap type: fingertip, knuckle, or nail.** The same tap in the same zone sounds different depending on what hit the case. A short calibration teaches Ghostkeys your own taps; after that, a knuckle tap becomes its own gesture, `knock_knuckle`, while a fingertip tap stays a plain `tap`. This only works alongside a tap the motion sensor already found, so it needs the motion sensor to be working too.
- **Rubs and swipes.** Dragging a finger across a palm rest or speaker grille makes a steady hiss. Ghostkeys hears that as a `rub`, or `rub_left` / `rub_right` once it's confident which way you dragged. Unlike tap type, this doesn't need the motion sensor at all.
- **Hand waves (one tone).** The speakers play a single, inaudible tone around 20 kHz. A hand moving near it shifts the tone slightly, the same way a passing car's engine note changes pitch. Ghostkeys reads that as `wave_toward`, `wave_away`, or `wave_sweep`.

Like everything else in Ghostkeys, this runs entirely on your machine. Audio is processed locally to decide "was that one of these sounds," never recorded to a file and never sent anywhere.

## Sonar: gestures in the air, no touching

Sonar is a separate switch from the rest of sound mode. Turn it on and Ghostkeys plays two inaudible tones at once, one from each side of the keyboard, and listens for how your hand changes them. That gives it a sense of where your hand is above the keyboard, not just whether a sound happened:

- **Hover.** Raise or lower a hand above a speaker and Ghostkeys tracks the height continuously, useful for a volume-style slider.
- **Push / pull.** A quick motion down toward a speaker, or up away from it.
- **Sweep left / sweep right.** A hand passed across above the keyboard.
- **Finger slides** (left, right, up, down). Sliding a finger while it's actually touching a speaker grille, confirmed by the friction sound, so a hovering hand can't be mistaken for a slide.

Sonar pauses itself briefly after every keystroke, and whenever the motion sensor feels the laptop get moved or bumped, so ordinary typing doesn't set it off.

## Sessions and the orange dot

Sound mode and sonar share one microphone session. It's short and deliberate, not always on: it starts when you ask for it, or, if you've set it up that way, automatically while a chosen app is in front, runs for 30 seconds by default and never more than 120, and stops on its own at the end, when you pause Ghostkeys, or when that app loses focus. Turning sonar on partway through a running sound session upgrades it rather than starting a second one.

Whenever a Mac app is using the microphone, macOS shows an orange dot in the menu bar. That's the system's own indicator, not something Ghostkeys draws itself, and it's the honest, verifiable sign that a sound or sonar session is active. If you don't see it, nothing is listening. The dot disappears as soon as the session ends.

## Safety limits that can't be turned off

These are built into the code, not settings you can change:

- The two sonar tones together never exceed -30 dBFS, quiet enough to stay inaudible to almost everyone.
- Every tone fades in and out over 20 milliseconds, so starting and stopping never clicks.
- A session's tones stop by themselves after 60 seconds unless renewed, and there's a 10 second gap before new tones can start again.
- Tones only ever play through the built-in speakers. Headphones, Bluetooth, USB, HDMI, and AirPlay output all refuse to play them, and plugging in headphones mid-session cuts the tones immediately.

## Notes on speakers and pets

- **Your own speakers.** A microphone doesn't know the difference between a tap on the case and a loud, sharp sound coming from your own speakers sitting right next to it. Expect sound mode to be more prone to false triggers while you're playing loud audio.
- **Pets, and some people.** Dogs and cats hear well above 20 kHz, and some children and young adults can hear 19 to 20 kHz too, right where the sonar tones sit. Keep sonar sessions short, and don't leave them running in the background.
- **A pet's paw or nose** against the case can sound enough like a tap to matter for the tap-type side of sound mode. If a pet has regular access to your laptop, plan to keep sound mode off around it.

## Testing sonar on your own Mac

`ghostkeys-lab`, a separate command-line tool in this repository, has a `sonar-bench` command that plays the real tones on your machine and listens with the real microphone, so you can see actual numbers instead of the simulated ones this page is otherwise based on:

```sh
ghostkeys-lab sonar-bench --seconds 15
```

It explains itself first, what will play, for how long, and the pets note, and only starts once you type the exact phrase `PLAY INAUDIBLE TONES` and press return; anything else cancels without playing or recording anything. It then runs for up to 20 seconds and prints a report: the signal strength of each tone, how much interference it saw, the largest hand movement it tracked, and any gestures it recognized. It refuses to run while a Ghostkeys sound or sonar session already has the microphone open.

This is a developer tool, not something the app runs for you yet. If you try it, you're helping check the "real hardware" part this feature still needs.

Check back on this page as sound mode and sonar are validated on real hardware; details here will firm up as that happens.
