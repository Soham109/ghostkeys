"""Calibration message flow (Calibration/CalibrationSession.swift, the
"calibration_*" cases in App/Daemon.swift `handle()`).

Actually accumulating captured samples (`calibration_zone` -> count going above
0) requires a real physical tap on the laptop case to cross the onset detector's
threshold; there is no protocol message that injects a synthetic sensor sample.
So this file exercises the full control-flow (start, zone selection, negatives
countdown, finish, cancel) deterministically, and separately pins down the
finish-with-zero-samples error, without depending on anyone physically tapping
the machine during the run. See FINDINGS.md #4.
"""
from __future__ import annotations


async def test_calibration_start_broadcasts_started(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm", "right-palm"], "target": 12})
    started = await c.recv_type("calibration", timeout=3)
    assert started["phase"] == "started"
    assert started["zones"] == ["left-palm", "right-palm"]
    assert started["target"] == 12


async def test_calibration_start_defaults_target_to_20(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"]})
    started = await c.recv_type("calibration", timeout=3)
    assert started["target"] == 20


async def test_calibration_start_defaults_zones_to_config_zones(connected):
    c = connected.client
    await c.send({"type": "calibration_start"})
    started = await c.recv_type("calibration", timeout=3)
    assert set(started["zones"]) == {z["id"] for z in connected.config["config"]["zones"]}


async def test_calibration_start_target_clamped_to_500_max(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5000})
    started = await c.recv_type("calibration", timeout=3)
    assert started["target"] == 500


async def test_calibration_start_target_clamped_to_1_min(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 0})
    started = await c.recv_type("calibration", timeout=3)
    assert started["target"] == 1


async def test_calibration_zone_broadcasts_capturing_with_zero_count(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 7})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_zone", "zone": "left-palm"})
    capturing = await c.recv_type("calibration", timeout=3)
    assert capturing["phase"] == "capturing"
    assert capturing["zone"] == "left-palm"
    assert capturing["count"] == 0
    assert capturing["target"] == 7


async def test_calibration_zone_without_start_errors(connected):
    c = connected.client
    await c.send({"type": "calibration_zone", "zone": "left-palm"})
    err = await c.recv_type("error", timeout=3)
    assert "calibration_start first" in err["message"]


async def test_calibration_zone_requires_nonempty_non_none_zone(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_zone", "zone": ""})
    err1 = await c.recv_type("error", timeout=3)
    assert "calibration_zone needs a zone" in err1["message"]

    await c.send({"type": "calibration_zone", "zone": "none"})
    err2 = await c.recv_type("error", timeout=3)
    assert "calibration_zone needs a zone" in err2["message"]


async def test_calibration_negatives_full_countdown(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_negatives", "seconds": 2})
    msgs = await c.drain(duration=3.2)
    seen = [m["secondsLeft"] for m in msgs if m.get("type") == "calibration" and m.get("phase") == "negatives"]

    assert seen, "expected at least one negatives countdown broadcast"
    assert seen[0] == 2
    assert seen[-1] == 0
    assert seen == sorted(seen, reverse=True), f"countdown should be non-increasing, got {seen}"


async def test_calibration_negatives_seconds_clamped_low(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_negatives", "seconds": -5})
    neg = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "negatives", timeout=3)
    assert neg["secondsLeft"] == 1


async def test_calibration_negatives_seconds_clamped_high_and_cancel_stops_it(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_negatives", "seconds": 99999})
    neg = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "negatives", timeout=3)
    assert neg["secondsLeft"] == 600, "seconds should clamp to 600 max"

    # Cancel immediately rather than waiting out a 600s timer.
    await c.send({"type": "calibration_cancel"})
    cancelled = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "cancelled",
                                       timeout=3)
    assert cancelled is not None

    leftover = await c.drain(duration=1.5)
    assert not any(m.get("type") == "calibration" and m.get("phase") == "negatives" for m in leftover), (
        "no further countdown ticks should arrive once cancelled"
    )


async def test_calibration_finish_with_no_samples_errors(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    await c.recv_type("calibration", timeout=3)

    await c.send({"type": "calibration_finish"})
    err = await c.recv_type("error", timeout=3)
    assert "no samples captured yet" in err["message"]


async def test_calibration_finish_without_start_errors(connected):
    c = connected.client
    await c.send({"type": "calibration_finish"})
    err = await c.recv_type("error", timeout=3)
    assert "no calibration in progress" in err["message"]


async def test_calibration_cancel_flow(connected):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["left-palm"], "target": 5})
    started = await c.recv_type("calibration", timeout=3)
    assert started["phase"] == "started"

    await c.send({"type": "calibration_cancel"})
    cancelled = await c.recv_type("calibration", timeout=3)
    assert cancelled["phase"] == "cancelled"

    # calibration is gone entirely now, not just idle.
    await c.send({"type": "calibration_zone", "zone": "left-palm"})
    err = await c.recv_type("error", timeout=3)
    assert "calibration_start first" in err["message"]
