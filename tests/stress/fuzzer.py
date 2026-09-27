"""Protocol fuzzer for ghostkeysd (docs/PROTOCOL.md). Throws random, malformed,
oversized, deeply nested, wrong-type, unicode, rapid-reconnect, half-open,
slowloris and handshake-race traffic at one daemon instance for
STRESS_FUZZ_SECONDS (default 1800 = 30 min).

Owns tests/stress/** only. Never edits daemon/Sources/**. Daemon is always
--simulate-sensors --no-hardware-sessions --dry-run on a port in 47970-47979
with a throwaway --config-dir. Findings go to a JSON file this process writes;
docs/review/STRESS_FINDINGS.md is assembled separately from all such files.

Usage: python3 fuzzer.py <config_dir> <findings_json_path> [seconds]
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import socket
import string
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import daemon_proc, raw_ws
from lib.findings import Sink
from lib.ws_client import Client, ProtocolTimeout

PORT = 47970
HOST = "127.0.0.1"

RESOURCE_BUDGET_RSS_KB = 400 * 1024   # flag if daemon RSS exceeds this at any sample
RESOURCE_BUDGET_CPU_PCT = 250.0       # flag if a single ps sample shows sustained CPU this high


def rand_unicode_string(n=40):
    pools = [
        "".join(chr(random.randint(0x20, 0x7e)) for _ in range(n)),
        "".join(chr(random.randint(0x1F300, 0x1FAFF)) for _ in range(min(n, 20))),  # emoji
        "".join(chr(random.randint(0x0590, 0x05FF)) for _ in range(min(n, 20))),  # hebrew (RTL)
        "‮" + "".join(random.choice(string.ascii_letters) for _ in range(n)),  # RTL override
        "".join(random.choice(["́", "̀", "̂"]) for _ in range(n)) + "zalgo",
        "a\x00b\x00c",  # embedded nulls
        "\ud83d",  # lone surrogate (invalid on its own)
        "".join(chr(random.randint(0, 0x10FFFF)) for _ in range(1)) if random.random() < 0.3 else "plain",
    ]
    return random.choice(pools)


def rand_scalar():
    return random.choice([
        None, True, False, 0, -1, 2**63, -(2**63), 3.14159, float("nan") if False else 1e308,
        "", "x" * 100000, rand_unicode_string(), [], {}, [1, 2, 3], {"a": 1},
    ])


def deep_nest_text(kind: str, depth: int) -> str:
    if kind == "array":
        return "[" * depth + "]" * depth
    if kind == "object":
        return ('{"a":' * depth) + "1" + ("}" * depth)
    return "[" * depth + "1" + "]" * depth


KNOWN_TYPES = [
    "subscribe", "unsubscribe", "pause", "resume", "calibration_start", "calibration_zone",
    "calibration_negatives", "calibration_finish", "calibration_apply_recommendation",
    "calibration_apply_merge", "calibration_cancel", "config_get", "config_set", "test_action",
    "approve_action", "revoke_action", "calibration_taptype_start", "calibration_taptype_cancel",
    "sim_tap", "sim_undo", "sim_adapt", "sim_tap_type", "sim_air", "feedback_missed", "feedback_false",
    "diagnostics_export", "sim_spike", "catalog_get", "sound_session_start", "sound_session_stop",
    "sonar_session_start", "sonar_session_stop", "sim_sonar", "air_session_start", "air_session_stop",
    "request_permission",
]

FIELD_NAMES = ["streams", "zones", "target", "seconds", "zone", "config", "action", "hash", "types",
               "tapType", "phase", "dx", "dy", "gesture", "side", "distanceMm", "which", "name",
               "strengthScale", "confidence", "air", "camera", "approvedHash", "label", "delayMs", "kind"]


class Fuzzer:
    def __init__(self, sink: Sink, binary: Path, config_dir: Path, deadline: float):
        self.sink = sink
        self.binary = binary
        self.config_dir = config_dir
        self.deadline = deadline
        self.daemon: daemon_proc.DaemonProcess | None = None
        self.restarts = 0
        self.iterations = {"malformed": 0, "typed_garbage": 0, "oversized": 0, "deep_nest": 0,
                           "unicode": 0, "reconnect": 0, "rate_flood": 0, "handshake_race": 0,
                           "slowloris": 0, "half_open": 0, "raw_frames": 0}
        self.baseline_rss = None
        self.max_rss = 0
        self.max_cpu = 0.0
        self.crashes: list[dict] = []
        self._lock = asyncio.Lock()

    def start_daemon(self):
        n = len(self.crashes)
        cfg = self.config_dir / f"run{n}"
        self.daemon = daemon_proc.DaemonProcess(self.binary, cfg, PORT)
        self.daemon.start(wait_ready=10.0)
        self.baseline_rss = None

    async def ensure_alive(self, context: str):
        async with self._lock:
            if self.daemon and self.daemon.is_alive():
                return
            rc = self.daemon.returncode if self.daemon else None
            stderr_tail = "\n".join(list(self.daemon.stderr_lines)[-40:]) if self.daemon else ""
            stdout_tail = "\n".join(list(self.daemon.stdout_lines)[-40:]) if self.daemon else ""
            self.crashes.append({"context": context, "returncode": rc, "t": time.time()})
            self.sink.finding(
                "CRITICAL", f"daemon died during fuzzing ({context})",
                repro=f"Run fuzzer.py; during the '{context}' worker the daemon process exited on its own "
                      f"(exit code {rc}). Not killed by us.",
                detail=f"stderr tail:\n{stderr_tail}\n\nstdout tail:\n{stdout_tail}",
            )
            self.sink.note(f"restarting daemon after crash #{len(self.crashes)} (context={context})")
            try:
                self.start_daemon()
            except Exception as e:
                self.sink.finding("CRITICAL", "daemon could not be restarted after a crash", repro=context,
                                  detail=str(e))
                raise

    # -- workers -------------------------------------------------------

    async def worker_malformed_frames(self):
        garbage = [
            "{this is not json", "{", "[1,2,", '"just a string"', "12345", "null", "true", "false",
            "-1e400", "1e400", "NaN", "Infinity", "-Infinity", "{}extra", "[]garbage",
            '{"type": "config_get"} {"type": "config_get"}',  # two objects, one frame
            "\x00\x01\x02\x03", "\xff\xfe", '{"type":', '{"type":}', '{"type": "x", }',
            '{"type": "x" "y": 1}', "{'type': 'x'}",  # single quotes (invalid JSON)
            '{"type": "x", "streams": [1,2,}', b"\x80\x81\x82".decode("latin1"),
        ]
        while time.time() < self.deadline:
            try:
                async with Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token) as c:
                    await c.handshake(timeout=5)
                    for g in garbage:
                        await c.send_raw(g)
                        self.iterations["malformed"] += 1
                    await c.drain(duration=0.3)
                    # must still be responsive
                    reply = await c.request({"type": "config_get"}, "config", timeout=3)
                    if reply.get("type") != "config":
                        self.sink.finding("high", "daemon stopped responding after malformed-frame burst",
                                          repro="send the garbage list in worker_malformed_frames, then config_get")
            except (ProtocolTimeout, ConnectionRefusedError, OSError) as e:
                await self.ensure_alive(f"malformed_frames: {e}")
            except Exception as e:
                self.sink.note(f"malformed_frames worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.05)

    async def worker_typed_garbage(self):
        """Known message types with wrong-type / garbage field values."""
        while time.time() < self.deadline:
            try:
                async with Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token) as c:
                    await c.handshake(timeout=5)
                    for _ in range(30):
                        t = random.choice(KNOWN_TYPES)
                        msg = {"type": t}
                        for _ in range(random.randint(0, 4)):
                            f = random.choice(FIELD_NAMES)
                            msg[f] = rand_scalar()
                        # occasionally wrap "type" itself as wrong type, or omit it
                        if random.random() < 0.1:
                            msg["type"] = random.choice([123, None, [], {}, True])
                        await c.send(msg) if isinstance(msg.get("type"), str) or random.random() < 0.5 else \
                            await c.send_raw(json.dumps(msg))
                        self.iterations["typed_garbage"] += 1
                    await c.drain(duration=0.3)
                    reply = await c.request({"type": "config_get"}, "config", timeout=3)
                    if reply.get("type") != "config":
                        self.sink.finding("high", "daemon unresponsive after typed-garbage burst", repro="worker_typed_garbage")
            except (ProtocolTimeout, ConnectionRefusedError, OSError) as e:
                await self.ensure_alive(f"typed_garbage: {e}")
            except Exception as e:
                self.sink.note(f"typed_garbage worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.05)

    async def worker_oversized(self):
        sizes = [1000, 100_000, 1_048_000, 1_048_576, 1_048_577, 2_000_000, 5_000_000]
        while time.time() < self.deadline:
            try:
                size = random.choice(sizes)
                payload = "x" * size
                async with Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token) as c:
                    await c.handshake(timeout=5)
                    msg = json.dumps({"type": "config_set", "config": {"junk": payload}})
                    try:
                        await c.send_raw(msg)
                    except Exception as e:
                        self.sink.note(f"oversized({size}): client-side send failed: {e!r}")
                    self.iterations["oversized"] += 1
                    await c.drain(duration=1.0)
                await self.ensure_alive(f"oversized({size})")
            except (ProtocolTimeout, ConnectionRefusedError, OSError) as e:
                await self.ensure_alive(f"oversized: {e}")
            except Exception as e:
                self.sink.note(f"oversized worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.3)

    async def worker_deep_nest(self):
        depths = [100, 1000, 5000, 20000, 100000]
        kinds = ["array", "object", "mixed"]
        while time.time() < self.deadline:
            try:
                depth = random.choice(depths)
                kind = random.choice(kinds)
                body = deep_nest_text(kind, depth)
                frame_text = '{"type": "config_set", "config": ' + body + "}"
                async with Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token) as c:
                    await c.handshake(timeout=5)
                    t0 = time.monotonic()
                    await c.send_raw(frame_text)
                    self.iterations["deep_nest"] += 1
                    await c.drain(duration=1.5)
                    dt = time.monotonic() - t0
                    if dt > 1.0:
                        self.sink.note(f"deep_nest depth={depth} kind={kind} took {dt:.2f}s round trip")
                await self.ensure_alive(f"deep_nest(depth={depth},kind={kind})")
            except (ProtocolTimeout, ConnectionRefusedError, OSError) as e:
                await self.ensure_alive(f"deep_nest: {e}")
            except Exception as e:
                self.sink.note(f"deep_nest worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.3)

    async def worker_unicode(self):
        while time.time() < self.deadline:
            try:
                async with Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token) as c:
                    await c.handshake(timeout=5)
                    for _ in range(20):
                        field = random.choice(["zone", "name", "which", "hash", "tapType", "gesture", "side"])
                        t = random.choice(["calibration_zone", "config_set", "revoke_action", "request_permission",
                                          "sim_tap", "calibration_apply_merge"])
                        msg = {"type": t, field: rand_unicode_string(random.randint(1, 500))}
                        try:
                            await c.send_raw(json.dumps(msg, ensure_ascii=False))
                        except Exception as e:
                            self.sink.note(f"unicode worker json.dumps failed (lone surrogate etc): {e!r}")
                            continue
                        self.iterations["unicode"] += 1
                    await c.drain(duration=0.3)
                await self.ensure_alive("unicode")
            except (ProtocolTimeout, ConnectionRefusedError, OSError) as e:
                await self.ensure_alive(f"unicode: {e}")
            except Exception as e:
                self.sink.note(f"unicode worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.1)

    async def worker_reconnect_storm(self):
        while time.time() < self.deadline:
            try:
                for _ in range(random.randint(3, 15)):
                    token = self.daemon.token if random.random() < 0.7 else "wrong-token-" + str(random.random())
                    try:
                        c = Client(f"ws://{HOST}:{PORT}/", token=token)
                        await c.connect(timeout=2)
                        await c.close()
                    except Exception:
                        pass
                    self.iterations["reconnect"] += 1
                await self.ensure_alive("reconnect_storm")
            except Exception as e:
                self.sink.note(f"reconnect_storm worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.2)

    async def worker_rate_flood(self):
        while time.time() < self.deadline:
            try:
                c = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
                await c.connect(timeout=3)
                await c.handshake(timeout=3)
                for _ in range(260):
                    await c.send({"type": "config_get"})
                    self.iterations["rate_flood"] += 1
                await c.drain(duration=1.5)
                await c.close()
                await self.ensure_alive("rate_flood")
            except Exception as e:
                self.sink.note(f"rate_flood worker exception (non-fatal): {e!r}")
            await asyncio.sleep(1.0)

    async def worker_handshake_race(self):
        while time.time() < self.deadline:
            try:
                n = random.randint(5, 20)
                clients = []
                for i in range(n):
                    tok = self.daemon.token if i % 3 != 0 else "bad-token"
                    clients.append(Client(f"ws://{HOST}:{PORT}/", token=tok))

                async def one(cl):
                    try:
                        await cl.connect(timeout=3)
                        await cl.close()
                        return True
                    except Exception:
                        return False

                await asyncio.gather(*(one(c) for c in clients), return_exceptions=True)
                self.iterations["handshake_race"] += 1
                await self.ensure_alive("handshake_race")
            except Exception as e:
                self.sink.note(f"handshake_race worker exception (non-fatal): {e!r}")
            await asyncio.sleep(0.5)

    async def worker_half_open_and_slowloris(self):
        """Raw TCP sockets that connect and either send nothing (half-open) or
        trickle the HTTP upgrade request one byte at a time (slowloris),
        holding a handshake slot without completing it. Exercises
        WebSocketServer.maxPending (16) and handshakeTimeout (2s)."""
        while time.time() < self.deadline:
            socks = []
            try:
                # A batch of half-open sockets.
                for _ in range(random.randint(2, 10)):
                    try:
                        s = raw_ws.connect_raw(HOST, PORT, timeout=3)
                        s.setblocking(False)
                        socks.append(s)
                        self.iterations["half_open"] += 1
                    except Exception:
                        pass
                # A slowloris socket trickling the handshake.
                try:
                    req = raw_ws.handshake_request(HOST, PORT, token=self.daemon.token)
                    ls = raw_ws.connect_raw(HOST, PORT, timeout=3)
                    ls.setblocking(True)
                    for b in req:
                        ls.sendall(bytes([b]))
                        await asyncio.sleep(0.05)
                        if time.time() > self.deadline:
                            break
                    ls.settimeout(2.0)
                    try:
                        ls.recv(4096)
                    except Exception:
                        pass
                    ls.close()
                    self.iterations["slowloris"] += 1
                except Exception as e:
                    self.sink.note(f"slowloris attempt failed (non-fatal): {e!r}")
                await asyncio.sleep(2.5)
                await self.ensure_alive("half_open_and_slowloris")
            finally:
                for s in socks:
                    try:
                        s.close()
                    except Exception:
                        pass

    async def worker_raw_frames(self):
        """After a valid handshake, sends spec-violating low-level WS frames:
        unmasked client frames, RSV bits set, frames that lie about their
        payload length."""
        while time.time() < self.deadline:
            s = None
            try:
                s = raw_ws.connect_raw(HOST, PORT, timeout=3)
                req = raw_ws.handshake_request(HOST, PORT, token=self.daemon.token)
                s.sendall(req)
                resp = raw_ws.read_http_response(s, timeout=3)
                if b"101" not in resp.split(b"\r\n", 1)[0]:
                    s.close()
                    await asyncio.sleep(0.2)
                    continue
                variants = [
                    lambda: raw_ws.text_frame('{"type":"config_get"}', mask=False),  # RFC violation: client must mask
                    lambda: raw_ws.text_frame('{"type":"config_get"}', rsv1=True),   # RSV1 with no extension negotiated
                    lambda: raw_ws.frame(0x1, b'{"type":"config_get"}', lie_length=50000),  # claims more bytes than sent
                    lambda: raw_ws.frame(0x0, b"continuation with no start"),         # bare continuation frame
                    lambda: raw_ws.ping_frame(os.urandom(200)),                       # large ping payload
                    lambda: raw_ws.frame(0xB, b""),                                    # unsolicited pong
                    lambda: raw_ws.frame(0xF, b"reserved opcode"),                     # reserved/undefined opcode
                    lambda: raw_ws.text_frame('{"type": "config_get"}' + "\ud83d", mask=True),  # invalid utf-8 (lone surrogate)
                    lambda: raw_ws.close_frame(code=1, mask=True),                     # invalid close code
                    lambda: raw_ws.close_frame(code=9999, mask=True),                  # out-of-range close code
                ]
                v = random.choice(variants)
                s.settimeout(2.0)
                try:
                    s.sendall(v())
                except Exception:
                    pass
                try:
                    s.recv(4096)
                except Exception:
                    pass
                self.iterations["raw_frames"] += 1
            except Exception as e:
                self.sink.note(f"raw_frames worker socket error (non-fatal): {e!r}")
            finally:
                if s is not None:
                    try:
                        s.close()
                    except Exception:
                        pass
            await asyncio.sleep(0.3)
            await self.ensure_alive("raw_frames")

    async def monitor(self):
        while time.time() < self.deadline:
            try:
                if self.daemon and self.daemon.is_alive():
                    s = daemon_proc.ps_sample(self.daemon.pid)
                    if s:
                        cpu, rss = s
                        if self.baseline_rss is None:
                            self.baseline_rss = rss
                        self.max_rss = max(self.max_rss, rss)
                        self.max_cpu = max(self.max_cpu, cpu)
                        self.sink.sample({"t": round(time.time(), 1), "cpu": cpu, "rss_kb": rss,
                                          "restarts": len(self.crashes)})
                        if rss > RESOURCE_BUDGET_RSS_KB:
                            self.sink.finding("medium", f"daemon RSS exceeded budget during fuzzing: {rss:.0f} KB",
                                              repro="observed during sustained fuzzing; see samples in JSON")
                        if cpu > RESOURCE_BUDGET_CPU_PCT:
                            self.sink.finding("medium", f"daemon CPU exceeded budget during fuzzing: {cpu:.0f}%",
                                              repro="observed during sustained fuzzing; see samples in JSON")
            except Exception as e:
                self.sink.note(f"monitor exception (non-fatal): {e!r}")
            await asyncio.sleep(5.0)

    async def run(self):
        self.start_daemon()
        workers = [
            self.worker_malformed_frames(), self.worker_typed_garbage(), self.worker_oversized(),
            self.worker_deep_nest(), self.worker_unicode(), self.worker_reconnect_storm(),
            self.worker_rate_flood(), self.worker_handshake_race(), self.worker_half_open_and_slowloris(),
            self.worker_raw_frames(), self.monitor(),
        ]
        await asyncio.gather(*workers, return_exceptions=True)

        # Final liveness + responsiveness check. Our own workers (half-open
        # sockets, slowloris, handshake races) can leave the server's pending
        # handshake queue transiently full even after we stop, so this
        # retries with backoff (up to recover_budget) rather than treating
        # queue drain time as a hang. A long recovery time is itself recorded
        # as a metric/finding, but only "never recovers" is a hard failure.
        alive = self.daemon.is_alive()
        responsive = False
        recover_started = time.time()
        recover_budget = 60.0
        if alive:
            while time.time() - recover_started < recover_budget:
                try:
                    c = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
                    await c.connect(timeout=5)
                    reply = await c.request({"type": "config_get"}, "config", timeout=5)
                    responsive = reply.get("type") == "config"
                    await c.close()
                    if responsive:
                        break
                except Exception as e:
                    self.sink.note(f"final responsiveness check attempt failed: {e!r}")
                await asyncio.sleep(3.0)
        recovery_time = time.time() - recover_started
        self.sink.metric("final_alive", alive)
        self.sink.metric("final_responsive", responsive)
        self.sink.metric("final_recovery_time_s", round(recovery_time, 1))
        if responsive and recovery_time > 5.0:
            self.sink.finding(
                "medium",
                f"daemon took {recovery_time:.0f}s to accept a clean connection after fuzzing stopped",
                repro="run the full worker mix (esp. worker_half_open_and_slowloris + worker_handshake_race) "
                      "for the fuzz duration, then immediately try a normal client connect+config_get",
                detail="Likely the WebSocketServer.maxPending=16 handshake admission queue draining "
                      "handshakeTimeout=2s slots one at a time; see handshake_queue_test.py for an isolated, "
                      "quantified repro of the same mechanism.",
            )
        self.sink.metric("iterations", self.iterations)
        self.sink.metric("crash_count", len(self.crashes))
        self.sink.metric("baseline_rss_kb", self.baseline_rss)
        self.sink.metric("max_rss_kb", self.max_rss)
        self.sink.metric("max_cpu_pct", self.max_cpu)
        if not alive:
            self.sink.finding("CRITICAL", "daemon not alive at end of 30-minute fuzz run",
                              repro="run fuzzer.py to completion; final liveness check failed")
        elif not responsive:
            self.sink.finding("high", "daemon alive but unresponsive at end of fuzz run",
                              repro="run fuzzer.py to completion; final config_get round trip timed out")
        if self.daemon and self.daemon.is_alive():
            self.daemon.stop()


async def main():
    config_dir = Path(sys.argv[1])
    findings_path = Path(sys.argv[2])
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else float(os.environ.get("STRESS_FUZZ_SECONDS", 1800))
    sink = Sink(findings_path, "protocol_fuzzer")
    sink.metric("planned_seconds", seconds)

    def loop_exception_handler(loop, context):
        # Route asyncio/websockets internal exceptions (e.g. a background
        # writer task hitting UnicodeEncodeError on a lone-surrogate payload
        # we intentionally sent) into the findings sink instead of stderr, so
        # a 30-minute unattended run doesn't lose them and doesn't look like
        # a crash if one happens near the end.
        msg = context.get("message", "")
        exc = context.get("exception")
        sink.note(f"asyncio loop exception handler: {msg}: {exc!r}")

    asyncio.get_event_loop().set_exception_handler(loop_exception_handler)
    binary = daemon_proc.BINARY_PATH
    if not binary.exists():
        sink.finding("CRITICAL", "stress daemon binary missing", repro=f"expected {binary}; run swift build first")
        sink.finish("build_missing")
        return
    deadline = time.time() + seconds
    fz = Fuzzer(sink, binary, config_dir, deadline)
    try:
        await fz.run()
        sink.finish("completed")
    except Exception as e:
        sink.finding("CRITICAL", "fuzzer harness itself crashed", repro=str(e))
        sink.finish("harness_error")
        raise


if __name__ == "__main__":
    asyncio.run(main())
