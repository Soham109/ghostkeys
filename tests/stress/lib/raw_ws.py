"""Minimal raw-socket WebSocket handshake + frame builders, for protocol-level
fuzzing the high-level `websockets` client library would refuse to send
(unmasked frames, bad RSV bits, lying length headers, partial/slowloris
handshakes, raw half-open TCP). Deliberately dumb: no framing validation on
our side, so whatever we ask for goes on the wire byte for byte.
"""
from __future__ import annotations

import base64
import os
import socket
import struct
from typing import Optional


def handshake_request(host: str, port: int, path: str = "/", token: Optional[str] = None,
                       origin: Optional[str] = None, extra_headers: Optional[dict] = None,
                       key: Optional[bytes] = None) -> bytes:
    key = key or base64.b64encode(os.urandom(16))
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key.decode()}",
        "Sec-WebSocket-Version: 13",
    ]
    if token is not None:
        lines.append(f"X-Ghostkeys-Token: {token}")
    if origin is not None:
        lines.append(f"Origin: {origin}")
    for k, v in (extra_headers or {}).items():
        lines.append(f"{k}: {v}")
    lines.append("")
    lines.append("")
    return "\r\n".join(lines).encode()


def read_http_response(sock: socket.socket, timeout: float = 3.0) -> bytes:
    sock.settimeout(timeout)
    data = b""
    try:
        while b"\r\n\r\n" not in data and len(data) < 65536:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except socket.timeout:
        pass
    return data


def frame(opcode: int, payload: bytes = b"", mask: bool = True, rsv1: bool = False, rsv2: bool = False,
          rsv3: bool = False, fin: bool = True, lie_length: Optional[int] = None) -> bytes:
    """Builds one raw WebSocket frame. `lie_length` overrides the encoded
    payload length field (to claim a longer/shorter body than actually sent)."""
    b0 = (0x80 if fin else 0) | (0x40 if rsv1 else 0) | (0x20 if rsv2 else 0) | (0x10 if rsv3 else 0) | (opcode & 0x0F)
    n = len(payload) if lie_length is None else lie_length
    mask_bit = 0x80 if mask else 0x00
    if n < 126:
        header = struct.pack("!BB", b0, n | mask_bit)
    elif n < (1 << 16):
        header = struct.pack("!BBH", b0, 126 | mask_bit, n)
    else:
        header = struct.pack("!BBQ", b0, 127 | mask_bit, n)
    if mask:
        key = os.urandom(4)
        masked = bytes(c ^ key[i % 4] for i, c in enumerate(payload))
        return header + key + masked
    return header + payload


def text_frame(text: str, **kw) -> bytes:
    return frame(0x1, text.encode("utf-8", errors="surrogatepass"), **kw)


def close_frame(code: int = 1000, reason: str = "", **kw) -> bytes:
    payload = struct.pack("!H", code) + reason.encode("utf-8", errors="ignore")
    return frame(0x8, payload, **kw)


def ping_frame(payload: bytes = b"", **kw) -> bytes:
    return frame(0x9, payload, **kw)


def connect_raw(host: str, port: int, timeout: float = 5.0) -> socket.socket:
    s = socket.create_connection((host, port), timeout=timeout)
    return s
