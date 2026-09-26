"""config_get / config_set round trip, broadcast to other clients, and invalid
config rejection (App/Daemon.swift `handle()` cases "config_get"/"config_set",
Config/Config.swift, Config/ConfigStore.swift)."""
from __future__ import annotations

import copy
import json

import pytest

import harness
from harness import DaemonProcess
from ws_client import Client


async def test_config_get_matches_handshake(connected):
    c = connected.client
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["config"] == connected.config["config"]


async def test_config_set_roundtrip_and_persists_to_disk(connected, config_path):
    c = connected.client
    new_cfg = copy.deepcopy(connected.config["config"])
    new_cfg["settings"]["sensitivity"] = 0.73
    new_cfg["bindings"][0]["label"] = "Volume way up"

    await c.send({"type": "config_set", "config": new_cfg})
    cfg_reply = await c.recv_type("config", timeout=3)
    status_reply = await c.recv_type("status", timeout=3)

    assert cfg_reply["config"]["settings"]["sensitivity"] == 0.73
    assert cfg_reply["config"]["bindings"][0]["label"] == "Volume way up"
    assert status_reply["type"] == "status"

    # And config_get afterwards reflects the same thing.
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["config"]["settings"]["sensitivity"] == 0.73

    on_disk = json.loads(config_path.read_text())
    assert on_disk["settings"]["sensitivity"] == 0.73
    assert on_disk["bindings"][0]["label"] == "Volume way up"


async def test_config_set_broadcasts_to_other_clients(daemon):
    async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as a:
        hs_a = await a.handshake()
        async with Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token) as b:
            await b.handshake()

            new_cfg = copy.deepcopy(hs_a["config"]["config"])
            new_cfg["settings"]["hud"] = False
            await a.send({"type": "config_set", "config": new_cfg})
            await a.recv_type("config", timeout=3)

            cfg_b = await b.recv_type("config", timeout=3)
    assert cfg_b["config"]["settings"]["hud"] is False


async def test_config_set_missing_config_field_is_rejected(connected):
    c = connected.client
    await c.send({"type": "config_set"})
    err = await c.recv_type("error", timeout=3)
    assert "config_set needs a config object" in err["message"]


async def test_config_set_non_object_config_is_rejected(connected):
    c = connected.client
    await c.send({"type": "config_set", "config": "not-an-object"})
    err = await c.recv_type("error", timeout=3)
    assert "config_set needs a config object" in err["message"]


async def test_config_set_invalid_zone_schema_is_rejected(connected):
    c = connected.client
    bad_cfg = copy.deepcopy(connected.config["config"])
    bad_cfg["zones"] = [{"id": "incomplete-zone"}]  # missing name/surface/rect/color
    await c.send({"type": "config_set", "config": bad_cfg})
    err = await c.recv_type("error", timeout=3)
    assert err["message"].startswith("invalid config:")

    # The rejected config must not have replaced the in-memory config.
    reply = await c.request({"type": "config_get"}, "config")
    assert reply["config"] == connected.config["config"]


async def test_config_set_invalid_binding_schema_is_rejected(connected):
    c = connected.client
    bad_cfg = copy.deepcopy(connected.config["config"])
    bad_cfg["bindings"] = [{"id": "bx", "enabled": True}]  # missing required "gesture"
    await c.send({"type": "config_set", "config": bad_cfg})
    err = await c.recv_type("error", timeout=3)
    assert err["message"].startswith("invalid config:")


async def test_config_persists_across_daemon_restart(daemon_binary, port, config_path):
    d1 = DaemonProcess(daemon_binary, port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d1)
    except TimeoutError as e:
        pytest.skip(str(e))
    try:
        async with Client(f"ws://127.0.0.1:{port}/", token=d1.token) as c:
            hs = await c.handshake()
            new_cfg = copy.deepcopy(hs["config"]["config"])
            new_cfg["settings"]["sensitivity"] = 0.91
            await c.send({"type": "config_set", "config": new_cfg})
            await c.recv_type("config", timeout=3)
    finally:
        d1.stop()
    assert harness.wait_port_free(port, timeout=5), "port did not free up after stopping the first daemon instance"

    d2 = DaemonProcess(daemon_binary, port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d2)
        async with Client(f"ws://127.0.0.1:{port}/", token=d2.token) as c:
            hs2 = await c.handshake()
        assert hs2["config"]["config"]["settings"]["sensitivity"] == 0.91
    finally:
        d2.stop()
