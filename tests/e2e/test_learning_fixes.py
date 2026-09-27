"""Regression tests for docs/review/VERIFY_01_LEARNING.md: partial recalibration, scoped undo, feedback rate-limit
side effects, the ship guard's neighbour check, the raw-window cap, the retrain generation guard, and the
"keep 1 in 3" throttle for very confident taps.

Everything runs against a --simulate-sensors --no-hardware-sessions --dry-run daemon with its own --config-dir,
driven by the test-only sim_* messages (see tests/e2e/README.md)."""
from __future__ import annotations

import asyncio
import copy
import json
import os
from collections import Counter

import pytest

import harness
from harness import DaemonProcess
from ws_client import Client

TAP = {"id": "t1", "enabled": True, "gesture": "tap", "zone": "right-grille", "zones": None, "modifiers": [],
       "app": "*", "action": {"kind": "volume", "step": 1}, "label": "Tap"}


async def calibrate(c: Client, zones: list[str], per: int = 10, negatives: bool = False) -> dict:
    """One calibration session over `zones`, `per` simulated taps each. Returns the `done` message."""
    await c.send({"type": "calibration_start", "zones": zones, "target": per})
    await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "started", timeout=5)
    for zone in zones:
        await c.send({"type": "calibration_zone", "zone": zone})
        for _ in range(per):
            await c.send({"type": "sim_spike", "live": True})
            await asyncio.sleep(0.45)
    await asyncio.sleep(0.5)
    if negatives:
        await c.send({"type": "calibration_negatives", "seconds": 1})
        await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("secondsLeft") == 0, timeout=5)
    await c.send({"type": "calibration_finish"})
    return await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "done", timeout=20)


async def enable_learning(c: Client, config: dict, bindings: list[dict]) -> dict:
    new = copy.deepcopy(config)
    new["settings"]["learnFromUse"] = True
    new["bindings"] = new["bindings"] + bindings
    await c.send({"type": "config_set", "config": new})
    reply = await c.recv_type("config", timeout=5)
    return reply["config"]


def confirmed(daemon) -> Counter:
    p = daemon.config_dir / "model" / "confirmed.json"
    if not p.exists():
        return Counter()
    return Counter(x["label"] for x in json.loads(p.read_text()))


def samples(daemon) -> Counter:
    return Counter(x["label"] for x in json.loads((daemon.config_dir / "model" / "samples.json").read_text()))


async def taps(c: Client, n: int, zone: str = "right-grille", gap: float = 0.4, **kw) -> None:
    for _ in range(n):
        await c.send({"type": "sim_tap", "zone": zone, **kw})
        await asyncio.sleep(gap)


# 1. Partial recalibration must merge (VERIFY_01 bug 2).
async def test_partial_recalibration_keeps_other_zones(connected, daemon):
    c = connected.client
    await asyncio.sleep(1.5)
    await calibrate(c, ["right-grille"])
    assert samples(daemon)["right-grille"] == 10
    done = await calibrate(c, ["left-grille"])
    after = samples(daemon)
    assert after["right-grille"] == 10, "recalibrating left-grille must not drop right-grille's samples"
    assert after["left-grille"] == 10
    assert done["recalibrated"] == ["left-grille"]
    assert {"right-grille", "left-grille"} <= set(done["labels"]), "the live model must still know both zones"
    # And recalibrating right-grille again replaces only its own samples.
    await calibrate(c, ["right-grille"], per=6)
    again = samples(daemon)
    assert again["right-grille"] == 6 and again["left-grille"] == 10


# 2. Cmd+Z / sim_undo cancels only the latest gesture's taps (VERIFY_01 bug 1).
async def test_undo_cancels_only_the_latest_gesture(connected, daemon):
    c = connected.client
    await asyncio.sleep(1.5)
    await calibrate(c, ["right-grille"], per=12)
    await enable_learning(c, connected.config["config"], [TAP])
    await taps(c, 3, gap=0.5)            # three separate gestures
    await c.send({"type": "sim_undo"})   # undoes only the third
    await asyncio.sleep(6.5)
    assert confirmed(daemon)["right-grille"] == 2


# 3. A feedback message refused by the rate limiter has no side effects (VERIFY_01 bug 5).
async def test_rate_limited_feedback_does_not_cancel_pending_taps(connected, daemon):
    c = connected.client
    await asyncio.sleep(1.5)
    await calibrate(c, ["right-grille"], per=12)
    await enable_learning(c, connected.config["config"], [TAP])
    await asyncio.sleep(2.1)             # let the rate limiter window from calibration pass
    await c.send({"type": "feedback_missed", "zone": "right-grille"})   # admitted; "missed" undoes nothing
    await c.recv_matching(lambda m: m.get("type") in ("feedback", "error"), timeout=10)
    await taps(c, 1)
    await c.send({"type": "feedback_false"})                            # refused: within 2 s of the last one
    err = await c.recv_matching(lambda m: m.get("type") in ("feedback", "error"), timeout=5)
    assert err["type"] == "error" and "at most one every 2 s" in err["message"]
    await asyncio.sleep(6.5)
    assert confirmed(daemon)["right-grille"] == 1, "the refused feedback must not have cancelled the pending tap"


# 4. The ship guard rejects confirmed taps that disagree with the calibration, deterministically (VERIFY_01 bug 3).
async def test_ship_guard_rejects_poisoned_confirmed_taps(daemon_binary, port, tmp_path):
    cfg_dir = tmp_path / "poison"
    d = DaemonProcess(daemon_binary, config_dir=cfg_dir, port=port, dry_run=True, verbose=True)
    harness.start_resilient(d)
    try:
        c = Client(f"ws://127.0.0.1:{port}/", token=d.token)
        await c.connect()
        hs = await c.handshake()
        await asyncio.sleep(1.5)
        await calibrate(c, ["right-grille", "left-grille"], per=12, negatives=True)
        await enable_learning(c, hs["config"]["config"], [TAP])
        await c.close()
    finally:
        d.stop()
        harness.wait_port_free(port, timeout=5)
    # Seed 40 calibration samples per zone (cap = 20 per zone, so nothing below gets evicted), with the two zones
    # clearly apart: simulated taps are identical everywhere, which would leave the neighbour check nothing to go on.
    real = json.loads((cfg_dir / "model" / "samples.json").read_text())
    base = next(x for x in real if x["label"] == "right-grille")["features"]
    import random
    rng = random.Random(7)
    seeded = []
    for label, shift in (("right-grille", 0.0), ("left-grille", 3.0)):
        for _ in range(40):
            seeded.append({"label": label, "features": {"t": 0, "values": [v + shift + rng.gauss(0, 0.02) for v in base["values"]]}})
    (cfg_dir / "model" / "samples.json").write_text(json.dumps(seeded))
    # Six mislabeled entries: right-grille's label on features nowhere near the right-grille cluster.
    poison = [{"label": "right-grille", "source": "confirmed", "ts": 1000.0 + i,
               "features": {"t": 0, "values": [v * -4 - 5 - i for v in base["values"]]}} for i in range(6)]
    (cfg_dir / "model" / "confirmed.json").write_text(json.dumps(poison))
    # A new DaemonProcess for the restart: reusing one keeps the first run's log, whose "listening" line would make
    # start() return before the new process listens.
    d = DaemonProcess(daemon_binary, config_dir=cfg_dir, port=port, dry_run=True, verbose=True)
    harness.start_resilient(d)
    try:
        c = Client(f"ws://127.0.0.1:{port}/", token=d.token)
        await c.connect()
        hs2 = await c.handshake()
        # Retrain the live model on the seeded samples (toggle a zone off and on: two rebuilds, the last one wins),
        # so the seeded-looking taps below count as familiar.
        cfg2 = hs2["config"]["config"]
        off = copy.deepcopy(cfg2)
        for z in off["zones"]:
            if z["id"] == "top-strip":
                z["enabled"] = False
        for conf in (off, cfg2):
            await c.send({"type": "config_set", "config": conf})
            await c.recv_type("config", timeout=5)
        await asyncio.sleep(3.0)
        await taps(c, 12, gap=0.4)          # genuine confirmations (cap is 20 per zone with 40 samples)
        await asyncio.sleep(6.5)
        await c.send({"type": "sim_adapt"})
        m = await c.recv_matching(lambda m: m.get("type") == "adaptation", timeout=20)
        assert m["rejected"] >= 6, m
        left = json.loads((cfg_dir / "model" / "confirmed.json").read_text())
        assert not any(x["ts"] < 1100 for x in left), "poisoned entries must be gone"
        await c.close()
    finally:
        d.stop()


# 5. The raw-window cap never deletes the newest file, even when it alone is over the budget (VERIFY_01 bug 6).
async def test_raw_cap_keeps_the_newest_file(daemon_binary, port, tmp_path):
    cfg_dir = tmp_path / "rawcap"
    raw = cfg_dir / "model" / "raw"
    raw.mkdir(parents=True)
    old = raw / "old.gkrec"
    old.write_bytes(b"x" * 1000)
    os.utime(old, (1_000_000_000, 1_000_000_000))
    d = DaemonProcess(daemon_binary, config_dir=cfg_dir, port=port, dry_run=True, verbose=True)
    os.environ["GHOSTKEYS_TEST_RAW_CAP_BYTES"] = "1"
    try:
        harness.start_resilient(d)
    finally:
        del os.environ["GHOSTKEYS_TEST_RAW_CAP_BYTES"]
    try:
        c = Client(f"ws://127.0.0.1:{port}/", token=d.token)
        await c.connect()
        await c.handshake()
        await asyncio.sleep(1.5)
        await calibrate(c, ["right-grille"], per=4)
        files = sorted(p.name for p in raw.iterdir())
        assert "old.gkrec" not in files, "the older file goes first"
        assert len(files) == 1, f"the just-written session file must survive a 1-byte cap: {files}"
        await c.close()
    finally:
        d.stop()


# 6. An older retrain can never overwrite a newer one (generation guard).
async def test_stale_retrain_is_discarded(connected, daemon):
    c = connected.client
    await asyncio.sleep(1.5)
    await calibrate(c, ["right-grille", "left-grille"], per=8)
    cfg = (await c.request({"type": "config_get"}, "config"))["config"]
    off = copy.deepcopy(cfg)
    for z in off["zones"]:
        if z["id"] == "left-grille":
            z["enabled"] = False
    await c.send({"type": "sim_slow_retrain", "seconds": 2.0})
    await c.send({"type": "config_set", "config": off})    # retrain A (slow): left-grille disabled
    await c.recv_type("config", timeout=5)
    await c.send({"type": "config_set", "config": cfg})    # retrain B (fast): both zones again
    await c.recv_type("config", timeout=5)
    await asyncio.sleep(3.0)
    st = await c.recv_type("status", timeout=10)
    assert set(st["zones"]) >= {"right-grille", "left-grille"}, "the slow, older retrain must not win"
    assert any("discarded a stale" in line for line in daemon.stderr_text().splitlines())


# 7. "Keep 1 in 3" of very confident taps keeps exactly every third (positions 1, 4, 7, 10, 13).
async def test_high_confidence_taps_keep_one_in_three(connected, daemon):
    c = connected.client
    await asyncio.sleep(1.5)
    await calibrate(c, ["right-grille"], per=12)   # cap = min(20, 12 / 2) = 6, above the 5 expected
    await enable_learning(c, connected.config["config"], [TAP])
    await taps(c, 15, gap=0.35, confidence=0.99)
    await asyncio.sleep(6.5)
    assert confirmed(daemon)["right-grille"] == 5
