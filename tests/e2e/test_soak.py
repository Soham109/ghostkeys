"""60 s soak: subscribe to every stream, keep the connection busy, and sample
the daemon's own CPU/RSS with `ps` every couple of seconds. This is a
measurement, not a strict pass/fail benchmark: the numbers go into REPORT.md,
and we only assert broad sanity bounds so the suite doesn't get flaky on a
loaded CI box.
"""
from __future__ import annotations

import asyncio
import subprocess
import time

import pytest

import results


def _ps_sample(pid: int):
    out = subprocess.run(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    return float(parts[0]), float(parts[1])  # cpu percent, rss KB


@pytest.mark.soak
async def test_60s_soak_cpu_and_memory(daemon, connected):
    c = connected.client
    hello = connected.hello
    sub_streams = [s for s in ("imu", "lid", "light") if hello["sensors"].get(s)] + ["taps"]
    await c.send({"type": "subscribe", "streams": sub_streams})

    duration = 60.0
    interval = 2.0
    start = time.monotonic()
    end = start + duration
    samples: list[tuple[float, float, float]] = []
    stop_draining = asyncio.Event()

    async def drain_forever():
        while not stop_draining.is_set():
            try:
                await c.recv(timeout=0.5)
            except Exception:
                pass

    drainer = asyncio.create_task(drain_forever())
    try:
        while time.monotonic() < end:
            s = _ps_sample(daemon.pid)
            if s is not None:
                samples.append((time.monotonic() - start, s[0], s[1]))
            await asyncio.sleep(interval)
    finally:
        stop_draining.set()
        drainer.cancel()
        try:
            await drainer
        except asyncio.CancelledError:
            pass

    assert daemon.is_alive(), "daemon must survive the 60s soak"
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["type"] == "config", "daemon must still be responsive right after the soak"

    assert len(samples) >= 10, f"expected at least 10 ps samples over {duration:.0f}s, got {len(samples)}"
    cpu_values = [s[1] for s in samples]
    rss_values = [s[2] for s in samples]
    first_rss, last_rss = rss_values[0], rss_values[-1]
    growth_kb = last_rss - first_rss

    results.record("soak_duration_s", duration)
    results.record("soak_samples", len(samples))
    results.record("soak_streams_subscribed", sub_streams)
    results.record("soak_cpu_avg_pct", round(sum(cpu_values) / len(cpu_values), 2))
    results.record("soak_cpu_max_pct", round(max(cpu_values), 2))
    results.record("soak_rss_first_kb", int(first_rss))
    results.record("soak_rss_last_kb", int(last_rss))
    results.record("soak_rss_growth_kb", int(growth_kb))

    # Generous sanity bounds; not a performance SLA, just a crash/leak smoke test.
    assert max(cpu_values) < 300, f"daemon CPU spiked to {max(cpu_values)}% during the soak"
    assert growth_kb < 150 * 1024, f"daemon RSS grew by {growth_kb:.0f} KB over {duration:.0f}s"
