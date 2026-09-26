"""Runs last (filename sorts after every other test_*.py). Verifies we left no
stray process behind and logs the motion sensor's idle state, per the task's
safety requirements."""
from __future__ import annotations

import harness
import results


def test_no_stray_ghostkeysd_processes_from_this_suite():
    strays = harness.no_stray_ghostkeysd(match=str(harness.BINARY_PATH))
    assert strays == [], (
        "found process(es) still running from our own e2e binary after the suite finished:\n" + "\n".join(strays)
    )


def test_log_motion_sensor_idle_state(capsys):
    info = harness.motion_sensor_report_intervals()
    results.record("post_suite_report_intervals", info.replace("\n", " | "))
    with capsys.disabled():
        print("\nAppleSPUHIDDriver ReportInterval snapshot after the suite (run with -s to see this live):")
        print(info)
