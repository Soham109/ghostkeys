"""Malformed input, unknown message types, a burst of rapid messages, and
reconnecting. The daemon must never crash or wedge a connection over any of
this (Server/WebSocketServer.swift `receive()`, App/Daemon.swift `handle()`)."""
from __future__ import annotations

import asyncio
import time

import websockets

import results
from ws_client import Client


async def test_malformed_json_gets_error_and_connection_survives(connected):
    c = connected.client
    await c.send_raw("{this is not json")
    err = await c.recv_type("error", timeout=3)
    assert err["message"] == "invalid JSON"

    # Connection must still be usable afterwards.
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["type"] == "config"


async def test_unknown_message_type_gets_error(connected):
    c = connected.client
    await c.send({"type": "definitely_not_a_real_type"})
    err = await c.recv_type("error", timeout=3)
    assert err["message"] == "unknown message type: definitely_not_a_real_type"


async def test_message_with_no_type_gets_error(connected):
    c = connected.client
    await c.send({"nope": "no type field here"})
    err = await c.recv_type("error", timeout=3)
    assert err["message"] == "message has no type"


async def test_repeated_malformed_frames_do_not_crash_the_daemon(connected, daemon):
    c = connected.client
    for bad in ["not json", "{", "[1,2,", '"just a string"', "12345", "null", ""]:
        if bad == "":
            continue  # an empty text frame is silently ignored by the server, nothing to assert
        await c.send_raw(bad)
    # Drain whatever error replies came back; count doesn't need to be exact, just present.
    msgs = await c.drain(duration=1.0)
    assert daemon.is_alive(), "daemon must survive a run of malformed frames"
    # And still be responsive afterwards.
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["type"] == "config"


async def test_200_rapid_messages_no_crash_and_latency_p95(connected, daemon):
    c = connected.client
    n = 200
    send_times = []
    for _ in range(n):
        send_times.append(time.monotonic())
        await c.send({"type": "config_get"})

    latencies = []
    for i in range(n):
        await c.recv_type("config", timeout=10)
        latencies.append(time.monotonic() - send_times[i])

    assert daemon.is_alive(), "daemon must survive 200 rapid messages"
    # The burst itself uses exactly the server's per-second cap (maxMessagesPerSecond
    # = 200, Server/WebSocketServer.swift): a responsiveness check sent immediately
    # after could land in the *same* 1s window as message #200 and become #201,
    # which the server disconnects for. Wait for the window to roll over first.
    await asyncio.sleep(1.1)
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["type"] == "config", "daemon must still be responsive after the burst"

    latencies.sort()
    p50 = latencies[int(0.50 * (n - 1))]
    p95 = latencies[int(0.95 * (n - 1))]
    results.record("rapid_200_latency_p50_ms", round(p50 * 1000, 2))
    results.record("rapid_200_latency_p95_ms", round(p95 * 1000, 2))
    results.record("rapid_200_latency_max_ms", round(latencies[-1] * 1000, 2))
    assert p95 < 0.050, f"p95 latency for 200 back-to-back config_get round trips was {p95 * 1000:.1f} ms"


async def test_message_rate_limit_over_200_per_second_disconnects_client(daemon):
    """Server/WebSocketServer.swift: more than maxMessagesPerSecond (200)
    messages/s from one client gets an error reply and a disconnect, not a
    crash (docs/PROTOCOL.md "Authentication" limits, discovered while writing
    this suite -- see FINDINGS.md #6 for the timeline)."""
    uri = f"ws://127.0.0.1:{daemon.port}/"
    c = Client(uri, token=daemon.token)
    await c.connect()
    await c.handshake()

    for _ in range(220):
        await c.send({"type": "config_get"})

    saw_rate_limit_error = False
    closed = False
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and not closed:
        try:
            msg = await c.recv(timeout=1)
        except websockets.exceptions.ConnectionClosed:
            closed = True
            break
        except Exception:
            continue
        if msg.get("type") == "error" and "rate limit" in msg.get("message", ""):
            saw_rate_limit_error = True

    assert saw_rate_limit_error, "expected a rate-limit error message before the disconnect"
    assert closed, "expected the server to close the connection after the rate-limit error"
    assert daemon.is_alive(), "the daemon process itself must survive disconnecting a spammy client"

    # And a fresh, well-behaved connection still works right after.
    c2 = Client(uri, token=daemon.token)
    await c2.connect()
    hello = await c2.recv_type("hello", timeout=3)
    assert hello["type"] == "hello"
    await c2.close()


async def test_reconnect_after_close_gets_a_fresh_handshake(daemon):
    uri = f"ws://127.0.0.1:{daemon.port}/"
    c1 = Client(uri, token=daemon.token)
    await c1.connect()
    hs1 = await c1.handshake()
    await c1.close()

    assert daemon.is_alive(), "daemon must survive a client disconnecting"

    c2 = Client(uri, token=daemon.token)
    await c2.connect()
    hs2 = await c2.handshake()
    await c2.close()

    assert hs1["hello"]["version"] == hs2["hello"]["version"]
    assert hs1["config"]["config"] == hs2["config"]["config"]


async def test_many_sequential_reconnects_are_stable(daemon):
    uri = f"ws://127.0.0.1:{daemon.port}/"
    for _ in range(10):
        c = Client(uri, token=daemon.token)
        await c.connect()
        hs = await c.handshake()
        assert hs["hello"]["type"] == "hello"
        await c.close()
    assert daemon.is_alive()
