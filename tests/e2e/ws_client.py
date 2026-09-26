"""Thin async client for ws://127.0.0.1:<port>/ speaking the ghostkeysd protocol
(docs/PROTOCOL.md): text frames, one JSON object per frame, every message has
"type"."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Optional

import websockets


class ProtocolTimeout(TimeoutError):
    pass


class Client:
    """`token`, when given, is sent as the `X-Ghostkeys-Token` handshake header
    Server/WebSocketServer.swift now requires (see FINDINGS.md #2/#5 and
    docs/PROTOCOL.md "Authentication"). `extra_headers` lets auth tests add e.g.
    an `Origin` header, which the server rejects unconditionally."""

    def __init__(self, uri: str, token: Optional[str] = None, extra_headers: Optional[dict] = None):
        self.uri = uri
        self.token = token
        self.extra_headers = extra_headers or {}
        self.ws: Optional["websockets.WebSocketClientProtocol"] = None

    async def connect(self, timeout: float = 5.0) -> None:
        headers = dict(self.extra_headers)
        if self.token is not None:
            headers["X-Ghostkeys-Token"] = self.token
        self.ws = await asyncio.wait_for(
            websockets.connect(self.uri, open_timeout=timeout, ping_interval=None,
                                additional_headers=headers or None),
            timeout=timeout,
        )

    async def close(self) -> None:
        if self.ws is not None:
            await self.ws.close()
            self.ws = None

    async def __aenter__(self) -> "Client":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    # -- sending -----------------------------------------------------------

    async def send(self, obj: dict) -> None:
        assert self.ws is not None
        await self.ws.send(json.dumps(obj))

    async def send_raw(self, text: str) -> None:
        assert self.ws is not None
        await self.ws.send(text)

    # -- receiving -----------------------------------------------------------

    async def recv_raw(self, timeout: float = 2.0) -> str:
        assert self.ws is not None
        try:
            return await asyncio.wait_for(self.ws.recv(), timeout=timeout)
        except asyncio.TimeoutError as e:
            raise ProtocolTimeout(f"no message within {timeout}s") from e

    async def recv(self, timeout: float = 2.0) -> dict:
        raw = await self.recv_raw(timeout=timeout)
        return json.loads(raw)

    async def recv_matching(self, predicate: Callable[[dict], bool], timeout: float = 3.0,
                             collect_others: Optional[list] = None) -> dict:
        """Reads messages until one satisfies `predicate`, ignoring (or, if
        `collect_others` is given, stashing) everything else. Useful because the
        daemon also broadcasts unrelated periodic `status` messages every 5s."""
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProtocolTimeout(f"no message matching predicate within {timeout}s")
            msg = await self.recv(timeout=remaining)
            if predicate(msg):
                return msg
            if collect_others is not None:
                collect_others.append(msg)

    async def recv_type(self, type_: str, timeout: float = 3.0, collect_others: Optional[list] = None) -> dict:
        return await self.recv_matching(lambda m: m.get("type") == type_, timeout=timeout, collect_others=collect_others)

    async def drain(self, duration: float = 0.5) -> list[dict]:
        """Collects every message that arrives within `duration` seconds."""
        msgs = []
        deadline = time.monotonic() + duration
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                msgs.append(await self.recv(timeout=remaining))
            except ProtocolTimeout:
                break
        return msgs

    async def handshake(self, timeout: float = 5.0) -> dict[str, dict]:
        """Reads the three greet() messages every new connection gets, in the
        order Daemon.greet() sends them: hello, status, config."""
        hello = await self.recv_type("hello", timeout=timeout)
        status = await self.recv_type("status", timeout=timeout)
        config = await self.recv_type("config", timeout=timeout)
        return {"hello": hello, "status": status, "config": config}

    async def request(self, message: dict, reply_type: str, timeout: float = 3.0,
                       collect_others: Optional[list] = None) -> dict:
        await self.send(message)
        return await self.recv_type(reply_type, timeout=timeout, collect_others=collect_others)

    async def approve(self, action: dict, timeout: float = 3.0) -> str:
        """Sends approve_action for `action` and returns the hash
        (Security/ApprovalStore.swift). shell/applescript/shortcut/open actions
        (including as macro steps) will not run via test_action without this."""
        reply = await self.request({"type": "approve_action", "action": action}, "approved", timeout=timeout)
        return reply["hash"]
