# Security

Ghostkeys runs actions on your Mac, so security problems matter more than usual. Thank you for reporting them privately.

## Reporting a problem

- Report privately through GitHub: [open a security advisory](https://github.com/Soham109/ghostkeys/security/advisories/new) (the "Report a vulnerability" button on the repository's Security tab).
- Please do not open a public issue for a security problem.
- Include what you did, what happened, the Mac model and macOS version, and the commit you tested. A short script that reproduces it helps most.
- Once a fix is ready, you will be credited in it unless you ask not to be.

There is no bug bounty.

## What counts

Anything that breaks one of the promises below. For example:

- A web page, another user, or another machine getting any response from the service.
- An action running without a matching gesture, a test from the app, or (for scripts) your approval.
- A refused command (such as `sudo` or `rm -rf`) getting through.
- The service writing outside its config directory, or leaving sensor settings changed after it exits.
- Anything that reveals what you typed.

## The safety model

**What Ghostkeys reads.** The motion sensor, the lid angle sensor, the ambient light sensor, the time since your last keystroke or click (never which key), and which app is in front. The microphone and camera only while an optional session you started is running, with a time limit.

**The local connection.**
- The service listens only on `127.0.0.1`, so only your own Mac can connect.
- On each launch it writes a new random token (64 hex characters) to a file only your user can read. Every connection must send it.
- Any connection carrying an `Origin` header is refused. Browsers always send one, so a web page cannot connect.
- At most 8 clients, 200 messages a second per client, and 2 test actions a second per client.

**Actions.**
- Actions run only for a gesture you bound, or a test you pressed in the app. Pausing stops all of them.
- Shell commands, AppleScript, Shortcuts and "open" actions run only after you confirm the exact command in a native dialog. The service records a fingerprint (SHA-256 hash) of the approved action, so any edit cancels the approval.
- Even when approved, commands using `sudo`, `rm -rf`, `diskutil`, `csrutil`, `launchctl`, `defaults write`, `networksetup`, `curl | sh`, or AppleScript administrator privileges are refused. This list is a guard rail. Your approval is the real control.
- Shell commands time out after 10 seconds. Macros stop at 50 steps or 30 seconds.
- At most 5 actions a second and 60 a minute. Crossing either pauses Ghostkeys. Each binding also has a short cooldown.

**Sensors.**
- To stream the motion sensor, the service changes two settings on the accelerometer and gyroscope drivers. It saves the originals to disk before the first change, restores them on exit, and restores them on the next start after a crash. The app also runs a restore if the service dies.
- It never writes to the light or lid sensors, which macOS itself uses.
- These settings reset on reboot anyway.

**Disk and network.**
- The service writes only inside `~/Library/Application Support/Ghostkeys/daemon/`. The app keeps its own settings in the parent folder.
- The service and app make no network connections. No telemetry, no account, no update check.

**Permissions.** Accessibility, for keys, text, media, brightness and windows. macOS asks separately for Screen Recording the first time a screenshot action runs, and for Automation the first time a script or integration controls a given app. Nothing ever needs an admin password.

## Known limits

- The app is not yet signed or notarized. Build it from source.
- License keys are not yet checked for a real signature. Today nothing is gated, so this has no security effect.
- The Windows port has the same rules but has never run on Windows hardware.
- The full audit, including what was found and fixed, is in [docs/audit/SAFETY_AUDIT.md](docs/audit/SAFETY_AUDIT.md). The exact rules are in [docs/PROTOCOL.md](docs/PROTOCOL.md).
