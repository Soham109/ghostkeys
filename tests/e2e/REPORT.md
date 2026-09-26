# ghostkeysd e2e test report

Generated 2026-09-26 17:23:25 -0500, exit status 0.

Daemon binary: `/Users/sohamaggarwal/Desktop/Projects/ghostkeys/daemon/.build-e2e/debug/ghostkeysd`
Run with `--dry-run` for every test in this suite; no action a test triggers actually executes.

## Environment

- Device: Mac17,8 / Apple M5 Pro / macbook-pro-16
- Daemon version: 0.1.0
- Sensors present at hello: {'sound': True, 'light': True, 'camera': True, 'lid': True, 'gyro': True, 'imu': True}
- Accessibility permission granted: False

## Summary

- Passed: 108
- Failed: 0
- Errors: 0
- Skipped: 0

## Measurements

- **imu_stream_rate_hz**: 61.5
- **lid_messages_observed**: 1
- **light_stream_rate_hz**: 5.0
- **post_suite_report_intervals**: |   "ReportInterval" = 0 | |   "HIDEventServiceProperties" = {"ReportInterval"=1000} | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "HIDEventServiceProperties" = {"ReportInterval"=1000} | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "ReportInterval" = 197380 | |   "ReportInterval" = 0
- **rapid_200_latency_max_ms**: 21.68
- **rapid_200_latency_p50_ms**: 11.82
- **rapid_200_latency_p95_ms**: 20.74
- **soak_cpu_avg_pct**: 2.68
- **soak_cpu_max_pct**: 5.4
- **soak_duration_s**: 60.0
- **soak_rss_first_kb**: 24224
- **soak_rss_growth_kb**: 432
- **soak_rss_last_kb**: 24656
- **soak_samples**: 30
- **soak_streams_subscribed**: ['imu', 'lid', 'light', 'taps']

## Notes

- test_action app/quit reported ok=true under --dry-run regardless of frontmost app (FINDINGS.md #1); the real refusal logic is unreachable without a live, non-dry-run run
- concurrent-handshake race: 2/2 valid-token connections rejected due to the 'cannot tell simultaneous handshakes apart' ambiguity guard (FINDINGS.md #5)

## Known gaps (see FINDINGS.md for repro steps and file/line)

- `--dry-run` skips `execute()` entirely, so the Finder/self quit guards in `WindowActions.app(_:)` are never exercised by this suite (FINDINGS.md #1).
- No `--config-dir` flag exists; this suite backs up and restores ghostkeysd's own files inside `~/Library/Application Support/Ghostkeys` around the whole session instead, and uses the `GHOSTKEYS_TOKEN` env var so it never has to read the shared token file (FINDINGS.md #2).
- The `integration` action kind was an unimplemented stub when this suite was started and a full implementation landed mid-session; the suite tracks the current, working behavior (FINDINGS.md #3).
- Calibration sample capture (`calibration_zone` actually accumulating counts) needs a real physical tap on the case; this suite can only exercise the control-flow messages, not capture itself (FINDINGS.md #4).
- Two WebSocket connections opened at the same instant can both be refused even with a valid token (Network.framework cannot tell simultaneous handshakes apart); a sequential retry always works (FINDINGS.md #5).
- This daemon was under active, concurrent development while this suite was written (auth, approvals, integrations, and a sessions/air/sound subsystem all landed mid-session); the sessions/air/sound/catalog/knob surface is intentionally out of scope for this suite (FINDINGS.md #6).
- The config directory is shared with the real app's Electron userData profile (Cache, GPUCache, Session Storage, etc. were found there); this suite's ConfigSandbox now touches only the specific files/dirs ghostkeysd itself owns, never the directory as a whole (FINDINGS.md #7).

