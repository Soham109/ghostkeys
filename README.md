# Ghostkeys

Turn the blank aluminum next to your trackpad into buttons only you know are there.

Ghostkeys watches the sensors already built into your MacBook and turns taps on the palm rests, the speaker grilles, the strip above the keyboard, the edges, and the lid into real shortcuts: volume, media keys, window snapping, app switching, multi-step macros, anything you can bind. No extra hardware, no keyboard shortcuts to memorize or fight over with other apps.

## What it does

- **Draw your own zones.** Pick any blank area of the case (palm rest, grille, top strip, edge, lid) and tell Ghostkeys it's a button.
- **Calibrate in about 3 minutes.** Tap each zone a few times, then go about your normal typing and trackpad use for a bit so Ghostkeys learns what a tap looks like versus everything else you do with your hands.
- **Get a real gesture set.** Single tap, double tap, triple tap, a two-zone sequence, a tap-pause-double "rhythm," tilting the lid back and forward, tilting the whole laptop left or right, and covering the camera (briefly or held).
- **Bind gestures to actions**, per app if you want (Excel gets different taps than Chrome), including keystrokes, volume/brightness/media, opening apps or URLs, window management, shell commands, AppleScript, Shortcuts, macros, and more.
- **See it happen.** A small heads-up display confirms which zone fired and what it triggered.

It never reads your keyboard or your typing content: it only asks "was that a tap on the case, or something else?"

## How it works

```
 SENSORS                        DAEMON (ghostkeysd, Swift)                 APP (Ghostkeys.app)
 ─────────────────────          ────────────────────────────────           ──────────────────────
 Motion sensor + gyro   ──┐      ┌─────────────┐   ┌──────────────┐        ┌───────────────────┐
   (up to 800 Hz)         │      │   Feature   │   │  Per-user    │        │  Zone editor,      │
 Lid angle sensor       ──┼───▶ │  extraction │─▶│  zone         │─▶ ...  │  bindings, HUD,    │
 Ambient light sensor   ──┘      │             │   │  classifier  │        │  visualizer         │
                                 └─────────────┘   └──────┬───────┘        └─────────▲──────────┘
                                                           ▼                          │
                                                  ┌──────────────────┐   WebSocket    │
                                                  │  Gesture grammar  │  ws://127.0.0.1:47823
                                                  │  tap · double ·   │────────────────┘
                                                  │  sequence · rhythm│    (loopback only)
                                                  └──────────────────┘
```

1. The daemon reads the motion sensor (accelerometer + gyroscope, sampled fast enough to catch the shockwave of a tap through the case), the lid angle sensor, and the ambient light sensor.
2. Every candidate tap is turned into a small set of numbers ("features": how sharp, how it echoed through the frame) and classified into one of your zones, or rejected as typing, trackpad use, or general motion.
3. Accepted taps are matched against a gesture grammar (tap, double, triple, sequence, rhythm, lid nudge, cover, tilt) with whatever modifier keys (shift, control, option, command, fn) were held.
4. The daemon sends the result over a WebSocket that only listens on your own machine (`127.0.0.1`, never your network) as one JSON message per event. See [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the full message contract.
5. The app matches the gesture against your bindings and runs the action, showing a brief confirmation in the HUD.

## Supported Macs

Ghostkeys needs Apple silicon: the motion sensor streaming it relies on only exists on the M-series sensor hardware, not on Intel Macs.

| Family | Chip generation | Example models |
| --- | --- | --- |
| MacBook Air 13" | M1 - M4 | MacBook Air 13" (2020-2025) |
| MacBook Air 15" | M2 - M4 | MacBook Air 15" (2023-2025) |
| MacBook Pro 14" | M1 Pro/Max - M4 | MacBook Pro 14" (2021-2024) |
| MacBook Pro 16" | M1 Pro/Max - M4 Pro/Max | MacBook Pro 16" (2021-2024) |
| Other Apple silicon MacBooks | Auto-detected by screen size | Newer models not yet in the built-in lookup table |
| Intel MacBooks | Not supported | No streaming motion sensor to read |

The 13" MacBook Pro (2020, M1) uses the same layout as the 13" Air since it shares that older case. `ghostkeysd --selftest` tells you exactly which sensors your machine actually streams. Requires macOS 14 (Sonoma) or later.

## Install and run

Ghostkeys is three independent pieces you run separately during development: a Swift daemon, an Electron app, and a Next.js marketing site.

### Daemon (`daemon/`): Swift, no external dependencies

Requires Xcode Command Line Tools (or Xcode) for Swift 5.9+ on macOS 14+.

```bash
cd daemon
swift build                        # debug build   -> .build/debug/ghostkeysd
swift build -c release             # release build -> .build/release/ghostkeysd
swift run ghostkeysd --selftest    # opens the sensors for 3s, prints rates/lid/light, exits 0 or 1
swift test                         # unit tests (GhostkeysDetection, GhostkeysAcoustics, GhostkeysVision; GhostkeysIntegrations is a stub)
```

Other flags: `--port N` (default `47823`), `--verbose`, `--dry-run` (logs actions instead of running them), `--dump-imu SECONDS` (prints raw motion samples as CSV), `--help`.

`GhostkeysAcoustics` (sound mode: telling a fingertip tap from a knuckle tap or a nail tap by its sound) and `GhostkeysVision` (camera add-on: hand tracking and in-air gestures for Macs with Desk View) are built out as their own tested libraries, but aren't wired into the running daemon's action pipeline yet. `GhostkeysIntegrations` (per-app commands over Apple Events, for things like Excel or Finder) is still a placeholder. `ghostkeys-lab` is a working CLI for recording tap sessions and measuring detection accuracy: see `daemon/Sources/ghostkeys-lab/README.md`.

### App (`app/`): Electron + React, pnpm

```bash
cd app
pnpm install
pnpm dev            # electron-vite dev; auto-starts a built ghostkeysd, or connects to one already
                     # running on the port, or use pnpm dev:mock to skip the daemon entirely
pnpm dev:mock        # runs a mock daemon (no Swift build required) alongside the app
pnpm typecheck
pnpm lint
pnpm build           # electron-vite build
pnpm build:mac       # electron-vite build && electron-builder --mac --dir --arm64 -> release/
```

Set `GHOSTKEYSD_PATH` to point `pnpm dev` at a specific daemon binary instead of the default `daemon/.build/{release,debug}/ghostkeysd` search.

**In progress**: the renderer UI (onboarding, zone editor, calibration wizard, bindings screen, live laptop map, HUD) is scaffolded but not yet built. Main, preload, and shared code (daemon supervisor, IPC, protocol types, action defaults) are in place. `TBD`.

### Web (`web/`): Next.js, static export, pnpm

```bash
cd web
pnpm install
pnpm dev            # next dev
pnpm build          # next build -> static export in out/
pnpm start          # serves the export: npx serve out
pnpm typecheck
pnpm shots           # scripts/screenshots.mjs
```

**In progress**: layout, fonts, and the data layer (zones, device dimensions, theme) are in place; the actual page content and 3D scene components are `TBD`.

## Safety and privacy

Ghostkeys never does any of the following:

- Never asks for `sudo` or an admin password, and never will.
- Never installs a kernel extension, launch daemon, or login item.
- Never changes System Settings.
- Never talks to the network. The only channel it opens is a WebSocket bound to `127.0.0.1` (your own machine): nothing reaches the internet, there is no telemetry and no account.
- Never reads what you type. It only classifies whether a physical tap on the case happened and where; the optional sound and camera add-ons (not yet wired into the daemon) will be off by default and opt-in when they ship.
- Never runs an action unless it matches a gesture you configured, or you press "test" in the app. Pausing Ghostkeys stops every action immediately.
- Never writes anything to disk outside `~/Library/Application Support/Ghostkeys/` (your config and your trained model).
- The daemon does briefly adjust a couple of internal sensor-driver settings so it can stream the motion sensor at all; it records whatever was there before and puts it back on exit (including if you force-quit or restart), and none of it survives a reboot anyway.
- The `shell` action type never runs with elevated privileges and always has a timeout.

## Repo layout

```
ghostkeys/
├── daemon/            Swift daemon (ghostkeysd): sensors, detection, gestures, actions, WebSocket server
│   ├── Sources/GhostkeysDetection/   pure logic: features, classifier, gesture grammar (unit tested)
│   ├── Sources/ghostkeysd/           the executable: sensors, actions, config, calibration, server
│   ├── Sources/GhostkeysAcoustics/   optional sound mode: fingertip vs. knuckle vs. nail, by sound (built, not yet wired in)
│   ├── Sources/GhostkeysVision/      optional camera add-on: hand tracking, in-air gestures (built, not yet wired in)
│   ├── Sources/GhostkeysIntegrations/ optional per-app commands via Apple Events (stub)
│   └── Sources/ghostkeys-lab/        record/replay accuracy tool (working CLI, own README)
├── app/               Electron + React desktop app (Ghostkeys.app)
├── web/               Next.js marketing site (static export)
├── presets/           Shared preset library, in progress
├── docs/
│   ├── PROTOCOL.md            the contract between the daemon and the app
│   ├── design/BRIEF.md        visual design system for the app and site
│   ├── design/logo.svg
│   └── pitch/                 hackathon submission material
└── README.md
```

## License

Not yet chosen. This is a hackathon project; a permissive open-source license (MIT is likely) will be added before any public release.
