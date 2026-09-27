# ghostkeysd e2e test report

Generated 2026-09-27 00:17:11 -0500, exit status 0.

Daemon binary: `/Users/sohamaggarwal/Desktop/Projects/ghostkeys/daemon/.build-release-qa/debug/ghostkeysd`
Run with `--dry-run` for every test in this suite; no action a test triggers actually executes.
Every daemon instance gets its own `--config-dir` (a pytest `tmp_path`); this suite never touches the real `~/Library/Application Support/Ghostkeys/`.

## Environment

- Device: Mac17,8 / Apple M5 Pro / macbook-pro-16
- Daemon version: 0.1.0
- Sensors present at hello: {'lid': False, 'light': False, 'imu': True, 'sound': True, 'camera': True, 'gyro': True}
- Accessibility permission granted: True

## Summary

- Passed: 105
- Failed: 0
- Errors: 0
- Skipped: 4

## Skipped

- `test_actions.py::test_action_app_quit_finder_refused_when_frontmost`: Skipped: Finder is not the frontmost app (frontmost is 'Electron'); cannot exercise the Finder-quit guard without changing focus
- `test_lifecycle.py::test_sigkill_then_restore_sensors_recovers`: Skipped: needs the real motion sensor driver (GHOSTKEYS_E2E_REAL_SENSORS=1); --simulate-sensors never writes driver settings, so there is nothing to restore
- `test_streams.py::test_subscribe_light_rate_near_10hz`: Skipped: no light sensor reported by hello; cannot measure a stream rate
- `test_streams.py::test_subscribe_lid_on_change`: Skipped: no lid sensor reported by hello

## Measurements

- **imu_stream_rate_hz**: 62.0
- **post_suite_report_intervals**: |   "ReportInterval" = 0 | |   "HIDEventServiceProperties" = {"ReportInterval"=1000} | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "HIDEventServiceProperties" = {"ReportInterval"=1000} | |   "ReportInterval" = 0 | |   "ReportInterval" = 0 | |   "ReportInterval" = 197380 | |   "ReportInterval" = 0
- **rapid_200_latency_max_ms**: 21.19
- **rapid_200_latency_p50_ms**: 11.31
- **rapid_200_latency_p95_ms**: 20.2
- **soak_cpu_avg_pct**: 1.81
- **soak_cpu_max_pct**: 7.6
- **soak_duration_s**: 60.0
- **soak_rss_first_kb**: 25872
- **soak_rss_growth_kb**: 288
- **soak_rss_last_kb**: 26160
- **soak_samples**: 30
- **soak_streams_subscribed**: ['imu', 'taps']

## Fixed since earlier runs (see FINDINGS.md for detail)

- FINDINGS.md #1 (Finder/self quit guard unreachable in dry-run): fixed. `WindowActions.checkApp(_:)` now does the frontmost-app refusal checks and is called from `ActionRunner.validate("app", ...)`, so dry-run and a real run agree. `test_actions.py::test_action_app_quit_finder_refused_when_frontmost` covers it, skipping when Finder is not actually the frontmost app (this suite never changes focus to force it).
- FINDINGS.md #2 (no --config-dir): fixed. `Options.swift` gained `--config-dir PATH` / `GHOSTKEYS_CONFIG_DIR`; the default moved to `~/Library/Application Support/Ghostkeys/daemon/` so the Electron app keeps the parent folder. This suite now gives every daemon instance its own throwaway `--config-dir` and never touches the real directory at all (superseding the earlier surgical-backup workaround).
- FINDINGS.md #5 (simultaneous handshakes could all be refused): fixed. `WebSocketServer` now serializes handshakes (`admissions` queue + `admitNext()`), so two connections opened at the same instant both succeed instead of racing. `test_handshake.py::test_concurrent_handshakes_both_succeed` covers it.

## Remaining known gaps (see FINDINGS.md for repro steps and file/line)

- The `integration` action kind was an unimplemented stub when this suite was started and a full implementation landed mid-session; the suite tracks the current, working behavior (FINDINGS.md #3).
- Calibration sample capture (`calibration_zone` actually accumulating counts) needs a real physical tap on the case; this suite can only exercise the control-flow messages, not capture itself (FINDINGS.md #4).
- This daemon was under active, concurrent development while this suite was written (auth, approvals, integrations, config-dir isolation, and a sessions/air/sound subsystem all landed mid-session); the sessions/air/sound/catalog/knob surface is intentionally out of scope for this suite (FINDINGS.md #6).

