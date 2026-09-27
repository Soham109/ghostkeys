# Devpost submission: Ghostkeys

## Project name
Ghostkeys

## Tagline (short)
Turn the blank parts of your MacBook into buttons.

## Built with
swift, iokit, coreaudio, avfoundation, electron, react, typescript, tailwindcss, radix-ui, next.js, three.js, react-three-fiber, gsap, remotion, elevenlabs, vercel, python, pytest

## Links
- Website: https://ghostkeys-nine.vercel.app
- Code: https://github.com/Soham109/ghostkeys

## Story

### Inspiration
A MacBook has a lot of surface that does nothing: the palm rests, the speaker grilles, the strip above the keys, the edges. Every day we reach for a shortcut we can't remember, or leave the keyboard for the trackpad just to do one thing. We wanted that dead space to become useful, with no new hardware.

### What it does
Ghostkeys turns blank MacBook surfaces into programmable buttons. Tap the left palm rest to mute a call. Double tap the right grille to take a screenshot. Tap the top strip to switch apps. Each zone runs whatever you bind: a shortcut, an app, a script, or a system action like volume or brightness.

- **Taps** are felt through the Mac's built-in motion sensor, read 797 times a second.
- **Sonar** (optional) plays two inaudible tones from the speakers and listens for how your hand changes them, for in-air push, pull and hover gestures.
- **Per-app layouts**, so the same tap does different things in Excel, Figma or Zoom.
- **Calibration and training** learn your own taps in a minute, including your double-tap rhythm and whether you are at a desk or on your lap.
- **Everything stays on the device.** No audio, sensor data or taps ever leave the Mac.

### How we built it
- **Sensor service (Swift):** reads the hidden motion sensor through IOKit without root, detects tap onsets on an adaptive noise floor, and blocks false taps from typing, trackpad use and moving the laptop.
- **Tap classifier:** 33 features per tap feed a nearest-neighbour and logistic ensemble with calibrated confidence. It also rejects anything unfamiliar and keeps separate desk and lap models.
- **Sonar:** stereo inaudible pilot tones with phase tracking, with a strict cap on speaker output so the hardware is never stressed.
- **App (Electron, React):** calibration, a tap test, a "why didn't that fire" helper, a training session and a live sonar view. It talks to the service over a local, token-protected WebSocket.
- **Website:** Next.js with a real-time 3D MacBook (three.js), scroll-driven with GSAP.
- **Promo film:** Remotion, with an ElevenLabs voiceover and an original score.

### Challenges we ran into
- **Taps are tiny.** A soft palm-rest tap is a few thousandths of a g, about the same as typing or setting down a coffee cup. Telling a real tap apart from everyday bumps took a real-data benchmark built from our own recordings and many rounds of tuning.
- **Desk versus lap.** A calibration made on a desk barely worked on a lap, because the laptop wobbles and people tap harder there. We added separate models per position, and lap accuracy went from 0% to 84%.
- **Sonar at first detected nothing.** Our own safety filters were throwing away every sample. Measuring on real hardware found four separate causes.
- **Staying safe on real hardware.** We cap speaker output, restore every sensor setting on exit, and fuzz-tested the local service.

### Accomplishments that we're proud of
- **Wrong or false taps:** from 16.5% down to 1.4% on real recordings.
- **False taps while handling the laptop:** from about 2 a minute down to 0.
- **Tests:** over 280 automated tests, 117 end-to-end tests, and a 30-minute attack test plus a 2-hour endurance test.
- **Existing Macs:** it works on Macs people already own, with nothing to buy.

### What we learned
Never trust detection numbers from synthetic data; real recordings changed every conclusion. Independent verification of every claim caught errors in our own analysis more than once.

### What's next for Ghostkeys
- Stronger sonar at normal volume, and left and right sweeps
- Learning from everyday use once it is proven safe
- A signed public release, and the Windows port that already speaks the same protocol
