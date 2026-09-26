"""Connect handshake (hello/status/config), multiple clients, and the
authentication PROTOCOL.md now documents (Server/WebSocketServer.swift
`authorize()`, Security/SessionToken.swift). This daemon build added a
handshake token requirement partway through writing this suite -- see
FINDINGS.md #2 for the timeline (now fixed: every daemon instance here gets
its own `--config-dir` and its token is read straight from that directory)."""
from __future__ import annotations

import asyncio

import pytest
import websockets

from ws_client import Client


async def test_handshake_order_and_shape(daemon):
    async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as c:
        hello = await c.recv(timeout=5)
        status = await c.recv(timeout=5)
        config = await c.recv(timeout=5)

    assert hello["type"] == "hello"
    assert status["type"] == "status"
    assert config["type"] == "config"

    assert hello["version"] == "0.1.0"
    device = hello["device"]
    for key in ("model", "chip", "family"):
        assert isinstance(device.get(key), str) and device[key]
    sensors = hello["sensors"]
    for key in ("imu", "gyro", "lid", "light"):
        assert isinstance(sensors.get(key), bool)
    assert isinstance(hello["permissions"]["accessibility"], bool)

    assert status["paused"] is False
    assert status["pausedReason"] is None
    assert isinstance(status["calibrated"], bool)
    assert isinstance(status["zones"], list)
    assert isinstance(status["imuHz"], int)
    detector = status["detector"]
    for key in ("noiseFloorMg", "thresholdMg", "level"):
        assert isinstance(detector[key], (int, float))

    cfg = config["config"]
    assert cfg["version"] == 1
    assert {z["id"] for z in cfg["zones"]} == {
        "left-palm", "right-palm", "left-grille", "right-grille", "top-strip", "left-edge", "right-edge", "lid",
    }
    assert {b["id"] for b in cfg["bindings"]} == {"b1", "b2"}
    assert cfg["settings"]["sensitivity"] == 0.5


async def test_multiple_clients_each_get_their_own_handshake(daemon):
    # Connected one at a time here just to keep this test's assertions simple;
    # test_concurrent_handshakes_both_succeed below covers the case where both
    # connect at the same instant.
    async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as a:
        hs_a = await a.handshake()
    async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as b:
        hs_b = await b.handshake()

    assert hs_a["hello"]["type"] == "hello"
    assert hs_b["hello"]["type"] == "hello"
    assert hs_a["config"]["config"] == hs_b["config"]["config"]


async def test_broadcast_reaches_all_connected_clients(daemon):
    async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as a:
        await a.handshake()
        async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as b:
            await b.handshake()

            await a.send({"type": "pause"})
            status_a = await a.recv_type("status", timeout=3)
            status_b = await b.recv_type("status", timeout=3)

    assert status_a["paused"] is True
    assert status_b["paused"] is True, "pause triggered by client A must broadcast to client B too"


# -- authentication (docs/PROTOCOL.md "Authentication") ----------------------

async def test_connect_without_token_is_rejected(daemon):
    c = Client(f"ws://127.0.0.1:{daemon.port}/")  # no token at all
    with pytest.raises(websockets.exceptions.InvalidStatus) as exc:
        await c.connect(timeout=3)
    assert exc.value.response.status_code == 400


async def test_connect_with_wrong_token_is_rejected(daemon):
    c = Client(f"ws://127.0.0.1:{daemon.port}/", token="0" * 64)
    with pytest.raises(websockets.exceptions.InvalidStatus) as exc:
        await c.connect(timeout=3)
    assert exc.value.response.status_code == 400


async def test_connect_with_origin_header_is_rejected_even_with_valid_token(daemon):
    """WebSocketServer.authorize() rejects any handshake carrying an Origin
    header outright, valid token or not -- it is the anti-browser-page check."""
    c = Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token,
               extra_headers={"Origin": "http://localhost:1234"})
    with pytest.raises(websockets.exceptions.InvalidStatus) as exc:
        await c.connect(timeout=3)
    assert exc.value.response.status_code == 400


async def test_reconnect_with_correct_token_after_a_rejection_still_works(daemon):
    bad = Client(f"ws://127.0.0.1:{daemon.port}/", token="wrong")
    with pytest.raises(websockets.exceptions.InvalidStatus):
        await bad.connect(timeout=3)

    good = Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token)
    await good.connect(timeout=3)
    hello = await good.recv_type("hello", timeout=3)
    assert hello["type"] == "hello"
    await good.close()


async def test_concurrent_handshakes_both_succeed(daemon):
    """See FINDINGS.md #5 (fixed). Network.framework's setClientRequestHandler
    callback does not say which pending connection it is authorizing, so two
    connections mid-handshake at once used to be indistinguishable and the
    server refused both, even with a valid token. `WebSocketServer` now
    serializes handshakes through an `admissions` queue and `admitNext()`
    (Server/WebSocketServer.swift): only one connection is ever mid-handshake,
    so this always resolves correctly no matter how many arrive at once. This
    test opens two connections at the same instant (both with the correct
    token) and asserts both succeed."""
    uri = f"ws://127.0.0.1:{daemon.port}/"
    a = Client(uri, token=daemon.token)
    b = Client(uri, token=daemon.token)

    results_ = await asyncio.gather(a.connect(timeout=3), b.connect(timeout=3), return_exceptions=True)
    failures = [r for r in results_ if isinstance(r, Exception)]
    assert not failures, f"expected both simultaneous connections to succeed, got: {failures}"

    hello_a = await a.recv_type("hello", timeout=3)
    hello_b = await b.recv_type("hello", timeout=3)
    assert hello_a["type"] == "hello"
    assert hello_b["type"] == "hello"

    await a.close()
    await b.close()
