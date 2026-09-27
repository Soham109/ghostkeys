# Contributing to Ghostkeys

Thanks for helping. Ghostkeys is early and built by one person, so small, focused changes are the easiest to review.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on the approach.
- There is no repository license yet (see the [README](README.md#license)). By sending a change, you agree it can be released under whatever license the project picks.
- For security problems, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Setup

You need an Apple silicon Mac on macOS 14 or later, the Xcode Command Line Tools (Swift 5.9 or later), Node 20 or later, and pnpm. Python 3 is needed for the end-to-end tests, and Rust for the Windows port.

```bash
cd daemon && swift build          # the service
cd app && pnpm install && pnpm dev # the app; it starts daemon/.build/debug/ghostkeysd itself
```

`pnpm dev:mock` runs the app against a fake service, which is enough for most UI work.

## Running the tests

```bash
cd daemon && scripts/run-tests.sh                 # Swift unit tests
cd tests/e2e && .venv/bin/pytest                  # end-to-end (see tests/e2e/README.md for setup)
pnpm --dir packages/sdk test
pnpm --dir packages/cli test
pnpm --dir packages/composer test
pnpm --dir app typecheck && pnpm --dir app lint
node presets/validate.mjs
cd windows && cargo test
```

Plain `swift test` on the Command Line Tools builds the tests and then runs none of them, while still reporting success. Use `scripts/run-tests.sh` instead ([why](daemon/scripts/README.md)).

The end-to-end tests open the real motion sensor, so quit the Ghostkeys app first. For your own experiments, run the service without touching hardware:

```bash
daemon/.build/debug/ghostkeysd --simulate-sensors --no-hardware-sessions --dry-run \
    --config-dir "$(mktemp -d)" --port 47890
```

## Rules every change must keep

These are the promises in the README. A change that breaks one will not be merged.

- No `sudo`, no admin prompts, no kernel extensions, launch daemons or login items, no System Settings changes.
- No network access from the service or the app. The only connection is the local WebSocket on `127.0.0.1`.
- Never read what the user types. Only the time since the last key or click.
- Only the accelerometer and gyroscope driver settings may be written, and the originals must be saved first and restored. Never write to the light or lid sensors.
- The service writes only inside its config directory.
- Keep the connection checks: token required, any `Origin` header refused, approvals for shell, AppleScript, Shortcuts and open actions, and the action rate limits.

## Protocol changes

[docs/PROTOCOL.md](docs/PROTOCOL.md) is the contract between the service and the app. Change it in the same commit as both sides. The Windows port has a test that reads PROTOCOL.md and checks every example, so run `cargo test` in `windows/` after editing it.

## Detection changes

Detection changes should come with evidence from real recordings, not only synthetic tests. Record a session with `ghostkeys-lab` ([how](daemon/Sources/ghostkeys-lab/README.md)) and measure before and after with `ghostkeys-lab replay`. Say in the pull request which Mac and which zones you tested on.

## Writing style

For docs, UI text and presets:

- Plain words. If a technical term is unavoidable, define it in the same sentence.
- Lead with the point.
- No em dashes or en dashes. The preset validator checks this for presets.
- Only claim what has been measured or tested.

## Pull requests

- One topic per pull request.
- Describe the change in a few bullet points: what changed, how you tested it, on which Mac.
- Include screenshots for UI changes.
