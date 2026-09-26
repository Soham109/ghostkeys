# Devpost submission: Ghostkeys

Answers for Devpost's standard project questions. Copy each section into the matching field.

## Inspiration

Every laptop has dead zones: palm rests, speaker grilles, the strip above the keyboard, the edges, the lid. They're aluminum for structure, not for anything else. Meanwhile, the moment you want one more shortcut, the answer is either external hardware (a Stream Deck, an extra remote) or fighting other apps for a keyboard combo that isn't already taken.

The trigger for this project: a MacBook already has the sensors to solve this without new hardware. The same motion sensor Apple uses to feel you shake the trackpad, the lid-angle sensor that wakes the display, and the ambient light sensor that dims the screen in a dark room are all still running when nobody but macOS is looking at them. Nobody was using them to let a person add their own buttons. That gap is the whole idea: turn sensors that are already inside every MacBook into a programmable surface, using nothing but software.

## What it does

Ghostkeys lets you draw a zone anywhere on the blank parts of your MacBook's case and turn it into a button. Tap the right speaker grille, get volume up. Double-tap the left palm rest, get play/pause. Tap the top strip then the right edge in sequence, get "screenshot area." Tilt the lid back and let it spring forward, mute the mic.

Under the hood, a small background daemon (`ghostkeysd`, written in Swift) streams the built-in motion sensor at up to 800 Hz, the lid-angle sensor, and the ambient-light sensor. A roughly 3-minute calibration walks you through tapping each zone you drew a few times, then has you type and use the trackpad normally for a bit so the classifier learns what a real tap looks like versus everything else your hands do all day. From then on, taps are matched against a small gesture grammar (tap, double, triple, a two-zone sequence, a tap-then-double "rhythm," lid nudges, tilts, camera-cover) and any modifier keys you're holding, and the matching action runs immediately: a keystroke, a volume or brightness step, opening an app, a shell command, an AppleScript, a macOS Shortcut, a multi-step macro, window snapping, or app switching. Bindings can be scoped per app, so Excel and a video call can use the same tap differently.

The daemon and the desktop app talk over a WebSocket that only ever listens on the machine's own loopback address; nothing leaves the laptop, and the full message contract is written down in `docs/PROTOCOL.md`.

## How we built it

- **Daemon (`daemon/`):** a dependency-free Swift package. `GhostkeysDetection` is the pure-logic half: feature extraction from raw accelerometer/gyroscope samples, the per-zone classifier and its trainer, onset detection (deciding "something happened" before deciding "what"), and the gesture grammar state machine. It's unit-testable without touching any hardware. `ghostkeysd` is the executable half: it reads the sensors through IOKit (adjusting a couple of `AppleSPUHIDDriver` properties to get the motion sensor to stream at all, and always restoring them on exit), runs calibration sessions, stores config, runs actions (CGEvents for keystrokes, `osascript` for volume, NSAppleScript, Accessibility APIs for window management, and more), and serves the WebSocket.
- **App (`app/`):** Electron with a React 19 renderer, built with `electron-vite`. The main process supervises the daemon: it finds a built binary, spawns it, or falls back to a mock daemon for UI development without a Swift toolchain at all. Shared TypeScript types mirror the wire protocol so both sides agree on the shape of every message.
- **Web (`web/`):** a Next.js site exported fully static (`output: "export"`), built around a design brief (`docs/design/BRIEF.md`) that treats the empty aluminum itself as the visual subject: a near-black stage, one accent color that only appears where a touch happens, and a scroll-driven 3D MacBook built with React Three Fiber.
- We deliberately kept the daemon's core (`GhostkeysDetection`) free of any external SwiftPM dependency, so it builds offline with just the Command Line Tools. That's useful when you're compiling on a dorm Wi-Fi network during a hackathon.

## Challenges we ran into

- **Telling a tap apart from typing.** The same motion sensor that feels a tap on the palm rest also feels every keystroke and every bit of normal laptop handling. Getting the false-positive rate down while typing at full speed is the actual hard problem in this project, not the sensor plumbing.
- **The sensor isn't a public API.** Streaming the motion sensor at a usable rate means reaching into IOKit properties that aren't part of any documented, ordinary app-facing SDK, and being careful to always put them back the way we found them, even on a crash or a forced quit.
- **Three codebases, one weekend.** A Swift daemon, an Electron app, and a Next.js site all had to agree on the same protocol without drifting, which is why `docs/PROTOCOL.md` exists as a contract both sides change together.
- **Building the demo and the daemon in parallel.** Sensor and classifier work and interface work had to happen at the same time on a tight clock, which is why the app ships with a mock daemon: UI work never had to block on the Swift side being ready.

## Accomplishments that we're proud of

- A working, dependency-free Swift daemon that streams a MacBook's motion, lid-angle, and light sensors and turns raw samples into classified, per-zone taps in real time.
- A real gesture grammar, not just "tap equals click": doubles, triples, cross-zone sequences, rhythms, lid nudges, tilts, and cover gestures, each with modifier-key support.
- A protocol contract clean enough that the daemon and the UI could be built by different people at the same time without either one blocking the other.
- A safety model we're comfortable putting in writing: no `sudo`, no kernel extensions, no network, nothing written outside one config folder, everything reversible on exit.

## What we learned

- How much of "just use the hardware you already have" is actually "carefully negotiate with IOKit properties nobody documents for third parties, and put them back exactly as you found them."
- That the hard part of a gesture system is rejection, not detection: most of the engineering effort goes into confidently ignoring typing and trackpad use, not into recognizing an intentional tap.
- That writing the protocol down first, before either side of the app existed, saved real time: it turned "what does the app expect" into a file both of us could point at instead of a conversation we had to keep repeating.

## What's next for Ghostkeys

- Finish the renderer UI: onboarding, the zone editor, the live laptop map, and the HUD are scaffolded but not yet built.
- Ship the preset library (200+ target) so most people never have to draw a zone by hand.
- Wire the optional sound mode (fingertip vs. knuckle vs. nail, by sound) and the camera add-on for Macs with Desk View into the running daemon; both already exist as their own tested libraries, they just aren't hooked into the action pipeline yet. Build out `GhostkeysIntegrations`, the per-app command layer, which is still a placeholder.
- Package and notarize (Apple's automated check that an app is safe to open without a warning) a real installer instead of a dev build.
- Keep validating with real students: what people actually want to bind matters more than how many gestures we support.

## Built with

Swift, SwiftPM, IOKit, AppKit, CoreGraphics, Accelerate, AVFoundation, Vision, Electron, React, TypeScript, Zustand, electron-vite, Vite, Next.js, React Three Fiber, Three.js, GSAP, Tailwind CSS, Radix UI, pnpm, WebSocket
