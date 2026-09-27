# Ghostkeys documentation

Every document in the repository, grouped by who it is for. Start with the [project README](../README.md) if you are new.

## For people using Ghostkeys

The user guide. It is also published on the [website](https://ghostkeys-nine.vercel.app/guide/), built from these same files.

| Chapter | What it covers |
| --- | --- |
| [Getting started](guide/01-getting-started.md) | First launch, onboarding, and the permissions Ghostkeys asks for |
| [Calibration](guide/02-calibration.md) | How to calibrate well, posture, and when to recalibrate |
| [Zones](guide/03-zones.md) | Drawing zones, starting layouts per Mac, and what makes zones easy to tell apart |
| [Gestures](guide/04-gestures.md) | Every gesture, how to do it, and which surfaces suit which gestures |
| [Actions](guide/05-actions.md) | Every action kind, macros, integrations, and per-app layers |
| [Presets and layouts](guide/06-presets-and-layouts.md) | Ready-made actions and zone arrangements |
| [Sound mode](guide/07-sound-mode.md) | The optional microphone add-on |
| [Camera add-on](guide/08-camera-add-on.md) | The optional in-air gestures |
| [Privacy and safety](guide/09-privacy-and-safety.md) | What Ghostkeys reads, never stores, and never does |
| [Troubleshooting](guide/10-troubleshooting.md) | False triggers, missed taps, lap use, the typing gate, uninstalling |
| [Compatibility](guide/11-compatibility.md) | Which Macs are supported |
| [FAQ](guide/12-faq.md) | Common questions |
| [For developers](guide/13-developers.md) | A short tour of the protocol |

Note: chapters 7, 8, 11 and 13 were written before sound mode, the camera add-on, the SDK, the CLI and the Windows port existed in code. Where they disagree with the component READMEs below, the READMEs are current.

## For developers

| Document | What it covers |
| --- | --- |
| [PROTOCOL.md](PROTOCOL.md) | The contract between the service and the app: every message, the config file, action kinds, authentication, limits |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Building, testing, and the rules a change must follow |
| [SECURITY.md](../SECURITY.md) | How to report a security problem, and the safety model |
| [daemon/scripts/README.md](../daemon/scripts/README.md) | `run-tests.sh`: running the Swift tests with only the Command Line Tools |
| [daemon/analysis/README.md](../daemon/analysis/README.md) | How detection was tuned on real recordings, with the measured accuracy numbers |
| [ghostkeys-lab](../daemon/Sources/ghostkeys-lab/README.md) | Recording tap sessions and replaying them to measure accuracy |
| [GhostkeysAcoustics](../daemon/Sources/GhostkeysAcoustics/README.md) | Sound mode and sonar: tap type, rubs, hand waves |
| [GhostkeysVision](../daemon/Sources/GhostkeysVision/README.md) | Camera add-on: hand tracking and in-air gestures |
| [GhostkeysIntegrations](../daemon/Sources/GhostkeysIntegrations/README.md) | App-aware commands (Excel, browsers, music, Finder, slides, Zoom) and their safety rules |
| [packages/sdk](../packages/sdk/README.md) | TypeScript client for the service |
| [packages/cli](../packages/cli/README.md) | The `gk` command-line tool |
| [packages/raycast](../packages/raycast/README.md) | Raycast extension |
| [Composer eval results](../packages/composer/eval-results.md) | How the AI macro composer did on its 60-prompt test set |
| [Composer break card](../packages/composer/BREAK_CARD.md) | Template for recording ways the composer can fail |
| [presets/README.md](../presets/README.md) | Preset library and layout format, and the validator's rules |
| [windows/README.md](../windows/README.md) | The Windows port: what Windows laptops can sense, feature differences, what is not validated yet |
| [web/README.md](../web/README.md) | The website: commands, structure, type, motion |
| [packaging/notarize.md](../packaging/notarize.md) | Signing and notarizing, for when there is a Developer ID |

## Testing and quality

| Document | What it covers |
| --- | --- |
| [tests/e2e/README.md](../tests/e2e/README.md) | Running the service safely for tests, and the test-only messages |
| [tests/e2e/REPORT.md](../tests/e2e/REPORT.md) | Latest end-to-end run: results and measurements |
| [tests/e2e/FINDINGS.md](../tests/e2e/FINDINGS.md) | Problems the end-to-end suite found, and their status |
| [audit/SAFETY_AUDIT.md](audit/SAFETY_AUDIT.md) | Safety and security audit of the service |
| [review/APP_CRITIQUE.md](review/APP_CRITIQUE.md) | Design critique of the desktop app |
| [review/WEB_QA.md](review/WEB_QA.md) | QA report for the website |

## Product and design

| Document | What it covers |
| --- | --- |
| [pricing/PRICING.md](pricing/PRICING.md) | Tiers, the feature matrix, licensing plan, and the reasoning behind the prices |
| [pricing/features.json](pricing/features.json) | The same feature matrix, machine-readable (the website reads it) |
| [design/BRIEF.md](design/BRIEF.md) | Visual design system for the app and site |
| [design/logo.svg](design/logo.svg) | The logo |

## Pitch material

Written for the hackathon submission. Some numbers and plans in here are older than the pricing document above.

| Document | What it covers |
| --- | --- |
| [pitch/devpost.md](pitch/devpost.md) | Submission write-up |
| [pitch/live-demo.md](pitch/live-demo.md) | Live demo script |
| [pitch/video-script.md](pitch/video-script.md) | Film script |
| [pitch/validation.md](pitch/validation.md) | Market validation notes |
| [pitch/venture.md](pitch/venture.md) | Venture pitch |
