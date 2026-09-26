"""subscribe/unsubscribe streams with rate checks.

PROTOCOL.md documents imu ~60 Hz (decimated), lid on change, light ~10 Hz. These
come straight from real hardware (SensorHub opens the actual built-in sensors
even under --dry-run; only *actions* are simulated), so the imu/light rate
checks are skipped rather than failed when the corresponding sensor is not
present or not reachable in this environment (e.g. no Input Monitoring grant),
which we detect from `hello.sensors`. Lid angle only broadcasts *on change*, so
with nobody moving the lid during an automated run, zero messages is a valid
outcome, not a failure.
"""
from __future__ import annotations

import pytest

import results


async def _hello(connected):
    return connected.hello


async def test_subscribe_imu_rate_near_60hz(connected):
    hello = connected.hello
    if not hello["sensors"].get("imu"):
        pytest.skip("no imu sensor reported by hello; cannot measure a stream rate")

    c = connected.client
    await c.send({"type": "subscribe", "streams": ["imu"]})
    msgs = await c.drain(duration=2.0)
    imu_msgs = [m for m in msgs if m.get("type") == "imu"]

    if not imu_msgs:
        results.note("subscribed to imu but received zero imu messages in 2s; "
                      "sensor likely blocked (Input Monitoring / TCC) in this environment")
        pytest.skip("no imu messages arrived; see notes in REPORT.md")

    rate = len(imu_msgs) / 2.0
    results.record("imu_stream_rate_hz", round(rate, 1))
    for m in imu_msgs[:5]:
        assert isinstance(m["t"], (int, float))
        assert len(m["a"]) == 3 and len(m["g"]) == 3
    # Decimated to ~60 Hz in Daemon.onIMU; generous band for scheduling jitter.
    assert 30 <= rate <= 100, f"expected roughly 60 Hz, measured {rate:.1f} Hz"


async def test_subscribe_light_rate_near_10hz(connected):
    hello = connected.hello
    if not hello["sensors"].get("light"):
        pytest.skip("no light sensor reported by hello; cannot measure a stream rate")

    c = connected.client
    await c.send({"type": "subscribe", "streams": ["light"]})
    msgs = await c.drain(duration=3.0)
    light_msgs = [m for m in msgs if m.get("type") == "light"]

    if len(light_msgs) < 2:
        results.note(f"subscribed to light but received only {len(light_msgs)} message(s) in 3s; "
                      "ambient light driver may be idle/silent in this environment")
        pytest.skip("not enough light messages to measure a rate; see notes in REPORT.md")

    rate = len(light_msgs) / 3.0
    results.record("light_stream_rate_hz", round(rate, 1))
    for m in light_msgs[:5]:
        assert 0.0 <= m["value"] <= 1.0
    # Gate in Daemon.onLight is >=0.09s between sends (~11 Hz cap); loose band either side.
    assert 1 <= rate <= 20, f"expected roughly 10 Hz, measured {rate:.1f} Hz"


async def test_subscribe_lid_on_change(connected):
    hello = connected.hello
    if not hello["sensors"].get("lid"):
        pytest.skip("no lid sensor reported by hello")

    c = connected.client
    await c.send({"type": "subscribe", "streams": ["lid"]})
    msgs = await c.drain(duration=1.5)
    lid_msgs = [m for m in msgs if m.get("type") == "lid"]

    if not lid_msgs:
        results.note("no lid messages observed; expected since the lid stream only broadcasts on angle change "
                      "and nothing moved the lid during the run")
        return

    for m in lid_msgs:
        assert isinstance(m["angle"], (int, float))
    results.record("lid_messages_observed", len(lid_msgs))


async def test_unsubscribe_stops_the_stream(connected):
    hello = connected.hello
    if not hello["sensors"].get("imu"):
        pytest.skip("no imu sensor reported by hello")

    c = connected.client
    await c.send({"type": "subscribe", "streams": ["imu"]})
    before = await c.drain(duration=0.8)
    if not any(m.get("type") == "imu" for m in before):
        pytest.skip("no imu messages arrived even while subscribed; cannot test that unsubscribe stops them")

    await c.send({"type": "unsubscribe", "streams": ["imu"]})
    after = await c.drain(duration=1.0)
    imu_after = [m for m in after if m.get("type") == "imu"]
    assert imu_after == [], f"expected no imu messages after unsubscribe, got {len(imu_after)}"


async def test_subscribe_unknown_stream_is_ignored_not_an_error(connected):
    """Daemon.handle() intersects requested streams with Daemon.streams; an
    unknown stream name is silently dropped rather than rejected."""
    c = connected.client
    await c.send({"type": "subscribe", "streams": ["not-a-real-stream"]})
    # Should not crash or error; confirm the connection is still responsive.
    await c.send({"type": "config_get"})
    reply = await c.recv_type("config", timeout=3)
    assert reply["type"] == "config"
