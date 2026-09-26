"""Connect handshake (hello/status/config), multiple clients, and the
authentication PROTOCOL.md now documents (Server/WebSocketServer.swift
`authorize()`, Security/SessionToken.swift). This daemon build added a
handshake token requirement partway through writing this suite -- see
FINDINGS.md #2/#5 for what that means for a test harness with no
--config-dir."""
from __future__ import annotations

import asyncio

import pytest
import websockets

import results
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
    # Connected one at a time on purpose: see
    # test_concurrent_handshakes_can_all_be_refused_KNOWN_GAP below for why.
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


async def test_concurrent_handshakes_can_all_be_refused_KNOWN_GAP(daemon):
    """See FINDINGS.md #5. Network.framework's setClientRequestHandler callback
    does not say which pending connection it is authorizing
    (Server/WebSocketServer.swift, `start()`'s comment: "Network.framework does
    not say which connection a handshake belongs to"). The server's workaround:
    if more than one connection is simultaneously mid-handshake when a verdict
    comes in, it cannot tell them apart, so it refuses *all* of them -- even
    ones presenting a perfectly valid token. This test opens two connections at
    the same instant (both with the correct token) and shows both can be
    rejected. A well-behaved client is expected to just retry (the code
    comment says so), which the next test proves works."""
    uri = f"ws://127.0.0.1:{daemon.port}/"
    a = Client(uri, token=daemon.token)
    b = Client(uri, token=daemon.token)

    results_ = await asyncio.gather(a.connect(timeout=3), b.connect(timeout=3), return_exceptions=True)
    rejected = sum(1 for r in results_ if isinstance(r, Exception))
    results.note(f"concurrent-handshake race: {rejected}/2 valid-token connections rejected due to the "
                 "'cannot tell simultaneous handshakes apart' ambiguity guard (FINDINGS.md #5)")
    for c, r in zip((a, b), results_):
        if not isinstance(r, Exception):
            await c.close()

    # Not asserting a specific count (0, 1 or 2 rejected is possible depending on
    # exact scheduling) -- the point is this is a real race, not a crash. Retrying
    # sequentially afterwards must always succeed:
    retry = Client(uri, token=daemon.token)
    await retry.connect(timeout=3)
    hello = await retry.recv_type("hello", timeout=3)
    assert hello["type"] == "hello"
    await retry.close()
