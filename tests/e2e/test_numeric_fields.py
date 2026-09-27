"""Huge or non-finite numbers in message fields must never crash the daemon (a Double that is NaN, infinite or out
of Int range traps when converted to Int). Covers calibration_negatives.seconds (the reported crash),
calibration_start.target, calibration_doubles.count, calibration_taptype_start.target, volume / brightness steps
(logged even in dry-run) and the sonar slider (sim_sonar displacementMm)."""
from __future__ import annotations

import asyncio
import copy


async def alive(c, daemon) -> None:
    reply = await c.request({"type": "config_get"}, "config", timeout=5)
    assert reply["type"] == "config"
    assert daemon.is_alive(), "daemon must still be running"


async def test_negatives_seconds_1e300_does_not_crash(connected, daemon):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["right-grille"], "target": 5})
    await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "started", timeout=5)
    await c.send({"type": "calibration_negatives", "seconds": 1e300})
    m = await c.recv_matching(lambda m: m.get("type") in ("calibration", "error"), timeout=5)
    # Clamped to the 600 s maximum, not a crash.
    assert m.get("phase") == "negatives" and m["secondsLeft"] == 600, m
    await c.send({"type": "calibration_negatives", "seconds": -1e300})
    m = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "negatives", timeout=5)
    assert m["secondsLeft"] == 1
    await c.send({"type": "calibration_cancel"})
    await alive(c, daemon)


async def test_overflowing_number_literal_is_refused_not_fatal(connected, daemon):
    # 1e400 overflows a Double; whatever the JSON parser makes of it (inf or a parse error), the daemon survives.
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["right-grille"], "target": 5})
    await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "started", timeout=5)
    await c.send_raw('{"type": "calibration_negatives", "seconds": 1e400}')
    m = await c.recv_matching(lambda m: m.get("type") in ("error", "calibration"), timeout=5)
    assert m["type"] == "error" or m.get("secondsLeft") in (1, 600), m
    await c.send({"type": "calibration_cancel"})
    await alive(c, daemon)


async def test_calibration_counts_are_clamped(connected, daemon):
    c = connected.client
    await c.send({"type": "calibration_start", "zones": ["right-grille"], "target": 1e300})
    m = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "started", timeout=5)
    assert m["target"] == 500
    await c.send({"type": "calibration_doubles", "zone": "right-grille", "count": 1e300})
    m = await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "doubles", timeout=5)
    assert m["target"] == 50
    await c.send({"type": "calibration_cancel"})
    await c.send({"type": "calibration_taptype_start", "target": -1e300})   # refused (no sound session), not a crash
    await c.recv_matching(lambda m: m.get("type") in ("calibration", "error"), timeout=5)
    await alive(c, daemon)


async def test_huge_volume_and_brightness_steps(connected, daemon):
    c = connected.client
    for action in ({"kind": "volume", "step": 1e300}, {"kind": "brightness", "step": -1e300}):
        await c.send({"type": "test_action", "action": action})
        m = await c.recv_type("action", timeout=5)
        assert m["ok"] is True, m        # dry-run: validated and logged (the log line used to trap)
        await asyncio.sleep(0.6)
    await alive(c, daemon)


async def test_huge_sonar_slider_displacement(connected, daemon):
    c = connected.client
    cfg = copy.deepcopy(connected.config["config"])
    cfg["settings"]["sonar"]["enabled"] = True
    cfg["bindings"].append({"id": "h1", "enabled": True, "gesture": "hover_level", "zone": "air", "zones": None,
                            "modifiers": [], "app": "*", "action": {"kind": "volume", "step": 2}, "label": "Hover",
                            "slider": {"mode": "absolute", "stepMm": 20, "inverse": {"kind": "volume", "step": -2}}})
    await c.send({"type": "config_set", "config": cfg})
    await c.recv_type("config", timeout=5)
    await c.send({"type": "sonar_session_start", "seconds": 10})
    await c.recv_matching(lambda m: m.get("type") == "session" and m.get("kind") == "sonar" and m.get("active"), timeout=5)
    for phase, mm in (("began", 0), ("changed", 1e300), ("changed", -1e300), ("ended", 0)):
        await c.send({"type": "sim_sonar", "air": {"gesture": "hover_level", "phase": phase, "side": "left",
                                                   "displacementMm": mm, "value": 0}})
        await asyncio.sleep(0.2)
    await c.send({"type": "sonar_session_stop"})
    await alive(c, daemon)
