---
title: Sound mode
description: An optional add-on, still in development, that listens for the sound a tap makes.
order: 7
---

Sound mode is an optional add-on that is still in development and not shipped yet. This page describes what it's designed to do, so you know what to expect when it lands, and what to think about before you turn it on.

## What it's designed to listen to

Sound mode uses your Mac's built-in microphone to hear a tap, not just feel it through the motion sensor. The idea is to add gesture types the motion sensor alone can't tell apart:

- **Knuckle versus fingertip.** A knuckle rap and a fingertip tap sound different even when they land in the same spot, so they're planned as two separate gestures on the same zone.
- **Swipes.** A finger dragged across a surface makes a distinct sound Ghostkeys can listen for, as a gesture of its own.
- **Hand-wave sonar.** A very quiet, inaudible tone played and listened for its echo, so Ghostkeys can sense a hand waving near the case without any contact at all.

Like everything else in Ghostkeys, this is designed to run entirely on your machine. Audio would be processed locally to decide "was that one of these sounds", never recorded to a file and never sent anywhere. It will be off by default and something you turn on, not something that's listening until you do.

## The orange microphone dot

Whenever a Mac app is using the microphone, macOS shows an orange dot in the menu bar. That's the system's own indicator, not something Ghostkeys draws itself, and it's the honest, verifiable sign that sound mode is actively listening. If you don't see it, sound mode isn't active. If you turn sound mode off, the dot should disappear as soon as the microphone stops.

## Notes on speakers and pets

- **Your own speakers.** A microphone doesn't know the difference between a tap on the case and a loud, sharp sound coming from your own speakers sitting right next to it. Expect sound mode to be more prone to false triggers while you're playing loud audio, and expect it to need a way to quiet down or pause during playback once it ships.
- **Pets.** A cat's paw or a dog's nose against the case can sound enough like a tap to matter. If a pet has regular access to your laptop, plan to either keep sound mode off, or expect a higher sensitivity setting once one is available, the same way the motion-sensor side of Ghostkeys lets you tune how easily it triggers.

Check back on this page as sound mode ships; details here will firm up once it's real and testable rather than designed.
