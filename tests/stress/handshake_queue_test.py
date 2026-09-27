"""Isolated, quantified repro for a pending-handshake-queue exhaustion effect
noticed during the protocol fuzzer's combined-chaos run: WebSocketServer caps
concurrent in-flight handshakes at maxPending=16 and serializes them one at a
time (Server/WebSocketServer.swift `admissions` + `admitNext()`), each with a
2s handshakeTimeout. Opening >=16 sockets that connect but never send (or
never finish) a handshake occupies every slot; a legitimate client's
connection then has to wait behind however many of those slots are ahead of
it in the queue before it is even considered.

This script measures, on a freshly started daemon with no other traffic:
  1. baseline: how long a normal client takes to connect + get `hello`.
  2. attacker: opens N half-open raw sockets (connect, send nothing), then
     immediately times how long a normal client takes to connect + get
     `hello` while those sockets are still open.

Usage: python3 handshake_queue_test.py <config_dir> <findings_json_path>
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import daemon_proc, raw_ws
from lib.findings import Sink
from lib.ws_client import Client

PORT = 47974
HOST = "127.0.0.1"


async def timed_connect(token: str, timeout: float = 40.0) -> float:
    t0 = time.monotonic()
    c = Client(f"ws://{HOST}:{PORT}/", token=token)
    await c.connect(timeout=timeout)
    await c.recv_type("hello", timeout=timeout)
    dt = time.monotonic() - t0
    await c.close()
    return dt


async def main():
    config_dir = Path(sys.argv[1])
    findings_path = Path(sys.argv[2])
    sink = Sink(findings_path, "handshake_queue_exhaustion")

    binary = daemon_proc.BINARY_PATH
    if not binary.exists():
        sink.finding("CRITICAL", "stress daemon binary missing", repro=f"expected {binary}")
        sink.finish("build_missing")
        return

    d = daemon_proc.DaemonProcess(binary, config_dir / "hq", PORT)
    d.start(wait_ready=10.0)
    try:
        baseline = await timed_connect(d.token)
        sink.metric("baseline_connect_s", round(baseline, 3))
        sink.note(f"baseline clean connect+hello took {baseline:.3f}s")

        for n_attackers in (16, 32, 64):
            socks = []
            for _ in range(n_attackers):
                try:
                    s = raw_ws.connect_raw(HOST, PORT, timeout=3)
                    s.setblocking(False)
                    socks.append(s)
                except Exception as e:
                    sink.note(f"could not open attacker socket #{len(socks)}: {e!r}")
            # give the server a moment to register the connections as pending
            await asyncio.sleep(0.2)
            try:
                dt = await timed_connect(d.token, timeout=40.0)
                sink.metric(f"legit_connect_s_with_{n_attackers}_half_open", round(dt, 3))
                sink.note(f"with {n_attackers} half-open sockets held, legit connect+hello took {dt:.3f}s "
                          f"(baseline {baseline:.3f}s, delta {dt - baseline:+.3f}s)")
                if dt > max(3.0, baseline * 5):
                    sink.finding(
                        "high",
                        f"holding {n_attackers} half-open (connect, send nothing) sockets open delays a "
                        f"legitimate client's handshake by {dt - baseline:.1f}s (from {baseline:.2f}s to {dt:.2f}s)",
                        repro=(
                            f"1) start ghostkeysd --simulate-sensors --no-hardware-sessions --dry-run "
                            f"--port {PORT} --config-dir <tmp>\n"
                            f"2) open {n_attackers} raw TCP sockets to 127.0.0.1:{PORT} and send them nothing "
                            f"(no HTTP/WS handshake bytes at all)\n"
                            f"3) from a fresh client, connect with a valid X-Ghostkeys-Token and time how long "
                            f"until `hello` arrives\n"
                            f"Observed: {baseline:.2f}s with no interference vs {dt:.2f}s with the sockets held open."
                        ),
                        detail=(
                            "WebSocketServer.maxPending=16 and handshakeTimeout=2.0 (Server/WebSocketServer.swift): "
                            "admissions are serviced one at a time via admitNext(); connecting is enough to occupy "
                            "a slot even if the socket never sends the HTTP upgrade request. A trivial, unauthenticated "
                            "(no token needed to occupy a slot) burst of connections from anything reachable on "
                            "127.0.0.1 can therefore make the app itself (main window, HUD) wait up to roughly "
                            "n_attackers/maxPending * handshakeTimeout seconds before its own legitimate connection "
                            "is even considered, as a transient denial of service against the daemon's only "
                            "control channel."
                        ),
                    )
            except Exception as e:
                sink.finding(
                    "CRITICAL" if not d.is_alive() else "high",
                    f"legitimate client could not connect at all with {n_attackers} half-open sockets held",
                    repro=f"same as above with n_attackers={n_attackers}",
                    detail=repr(e),
                )
            finally:
                for s in socks:
                    try:
                        s.close()
                    except Exception:
                        pass
            await asyncio.sleep(3.0)  # let the queue fully drain between rounds
            if not d.is_alive():
                sink.finding("CRITICAL", "daemon died during handshake-queue-exhaustion test",
                            repro=f"n_attackers={n_attackers}", detail=d.stderr_text()[-4000:])
                break
    finally:
        if d.is_alive():
            d.stop()
    sink.finish("completed")


if __name__ == "__main__":
    asyncio.run(main())
