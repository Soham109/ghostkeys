"""Minimal async WebSocket client for ws://127.0.0.1:<port>/ speaking the
ghostkeysd protocol (docs/PROTOCOL.md). Deliberately small and permissive: the
fuzzer wants to send garbage, so this does not validate outgoing messages."""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Callable, Optional

import websockets


class ProtocolTimeout(TimeoutError):
    pass


class Client:
    def __init__(self, uri: str, token: Optional[str] = None, extra_headers: Optional[dict] = None,
                 max_size: Optional[int] = 2 ** 23):
        self.uri = uri
        self.token = token
        self.extra_headers = extra_headers or {}
        self.max_size = max_size
        self.ws: Optional["websockets.WebSocketClientProtocol"] = None

    async def connect(self, timeout: float = 5.0) -> None:
        headers = dict(self.extra_headers)
        if self.token is not None:
            headers["X-Ghostkeys-Token"] = self.token
        self.ws = await asyncio.wait_for(
            websockets.connect(self.uri, open_timeout=timeout, ping_interval=None,
                                additional_headers=headers or None, max_size=self.max_size),
            timeout=timeout,
        )

    async def close(self) -> None:
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None

    async def __aenter__(self) -> "Client":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.close()

    async def send(self, obj: dict) -> None:
        assert self.ws is not None
        await self.ws.send(json.dumps(obj))

    async def send_raw(self, text) -> None:
        assert self.ws is not None
        await self.ws.send(text)

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
            except Exception:
                break
        return msgs

    async def handshake(self, timeout: float = 5.0) -> dict:
        hello = await self.recv_type("hello", timeout=timeout)
        status = await self.recv_type("status", timeout=timeout)
        config = await self.recv_type("config", timeout=timeout)
        return {"hello": hello, "status": status, "config": config}

    async def request(self, message: dict, reply_type: str, timeout: float = 3.0,
                       collect_others: Optional[list] = None) -> dict:
        await self.send(message)
        return await self.recv_type(reply_type, timeout=timeout, collect_others=collect_others)
