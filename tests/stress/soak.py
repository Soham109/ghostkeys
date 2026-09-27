"""Long soak: one daemon instance, kept busy for STRESS_SOAK_SECONDS (default
7200 = 2h) with simulated taps, gestures, config churn, calibration cycles,
feedback, approvals and session start/stop, while sampling RSS, CPU, open
file descriptors and thread count every 60s and flagging growth trends.

Usage: python3 soak.py <config_dir> <findings_json_path> [seconds]
"""
from __future__ import annotations

import asyncio
import os
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import daemon_proc
from lib.findings import Sink
from lib.ws_client import Client, ProtocolTimeout

PORT = 47971
HOST = "127.0.0.1"
SAMPLE_INTERVAL = 60.0

# Growth flags -- these are soak-scale (hours), so more generous than the
# 60s smoke bounds in tests/e2e/test_soak.py, but still meant to catch a real
# leak rather than one-time warm-up growth.
RSS_GROWTH_FLAG_KB = 200 * 1024      # 200 MB net growth over the whole soak
FD_GROWTH_FLAG = 200                 # file descriptors
THREAD_GROWTH_FLAG = 50


class Soak:
    def __init__(self, sink: Sink, binary: Path, config_dir: Path, deadline: float):
        self.sink = sink
        self.binary = binary
        self.config_dir = config_dir
        self.deadline = deadline
        self.daemon = daemon_proc.DaemonProcess(binary, config_dir, PORT)
        self.restarts = 0
        self.stop_event = asyncio.Event()

    async def ensure_alive(self, context: str):
        if self.daemon.is_alive():
            return
        rc = self.daemon.returncode
        self.sink.finding("CRITICAL", f"daemon died during the soak ({context})",
                          repro=f"run soak.py; died during '{context}', exit code {rc}",
                          detail="\n".join(list(self.daemon.stderr_lines)[-40:]))
        self.restarts += 1
        self.sink.note(f"restarting daemon after soak crash #{self.restarts} (context={context})")
        self.daemon = daemon_proc.DaemonProcess(self.binary, self.config_dir / f"restart{self.restarts}", PORT)
        self.daemon.start(wait_ready=10.0)

    async def worker_taps_and_gestures(self, c: Client, zones: list[str]):
        while not self.stop_event.is_set():
            try:
                zone = random.choice(zones)
                await c.send({"type": "sim_tap", "zone": zone})
                await asyncio.sleep(random.uniform(0.05, 0.4))
            except Exception as e:
                self.sink.note(f"taps_and_gestures worker error (non-fatal): {e!r}")
                await asyncio.sleep(1.0)

    async def worker_config_churn(self, c: Client, base_config: dict):
        n = 0
        while not self.stop_event.is_set():
            try:
                cc = dict(base_config)
                cc["settings"] = dict(cc.get("settings", {}))
                cc["settings"]["_soak_churn"] = n
                await c.send({"type": "config_set", "config": cc})
                n += 1
                await asyncio.sleep(random.uniform(1.0, 3.0))
            except Exception as e:
                self.sink.note(f"config_churn worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def worker_calibration_cycles(self, c: Client, zones: list[str]):
        while not self.stop_event.is_set():
            try:
                zone = random.choice(zones)
                await c.send({"type": "calibration_start", "zones": [zone], "target": 5})
                await c.recv_type("calibration", timeout=5)
                await c.send({"type": "calibration_zone", "zone": zone})
                await c.recv_type("calibration", timeout=5)
                got = 0
                deadline = time.monotonic() + 8
                while got < 5 and time.monotonic() < deadline:
                    await c.send({"type": "sim_spike", "live": True})
                    try:
                        msg = await c.recv_type("calibration", timeout=1.0)
                        got = msg.get("count", got)
                    except ProtocolTimeout:
                        pass
                await c.send({"type": "calibration_finish"})
                try:
                    await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "done",
                                          timeout=8)
                except ProtocolTimeout:
                    self.sink.note("a calibration cycle did not reach 'done' within 8s (non-fatal, continuing)")
                await asyncio.sleep(random.uniform(3.0, 8.0))
            except Exception as e:
                self.sink.note(f"calibration_cycles worker error (non-fatal): {e!r}")
                await asyncio.sleep(3.0)

    async def worker_feedback(self, c: Client, zones: list[str]):
        # Send-only: a dedicated drain task on this same connection reads replies,
        # since websockets forbids concurrent recv() calls on one connection.
        while not self.stop_event.is_set():
            try:
                if random.random() < 0.5:
                    await c.send({"type": "feedback_missed", "zone": random.choice(zones)})
                else:
                    await c.send({"type": "feedback_false"})
                await asyncio.sleep(random.uniform(2.5, 5.0))
            except Exception as e:
                self.sink.note(f"feedback worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def worker_approvals(self, c: Client, replies: "asyncio.Queue"):
        # This connection's replies are read by a dedicated drain task (see
        # drain_forever_write in run()), which posts "approved" messages onto
        # `replies` for us to consume instead of calling c.recv ourselves.
        i = 0
        held: list[str] = []
        while not self.stop_event.is_set():
            try:
                act = {"kind": "shell", "command": f"echo soak-{i}", "label": f"s{i}"}
                await c.send({"type": "approve_action", "action": act})
                deadline = time.monotonic() + 3.0
                try:
                    while time.monotonic() < deadline:
                        msg = await asyncio.wait_for(replies.get(), timeout=max(0.05, deadline - time.monotonic()))
                        if msg.get("type") == "approved":
                            held.append(msg["hash"])
                            break
                except asyncio.TimeoutError:
                    pass
                if len(held) > 20:
                    old = held.pop(0)
                    await c.send({"type": "revoke_action", "hash": old})
                i += 1
                await asyncio.sleep(random.uniform(1.0, 2.0))
            except Exception as e:
                self.sink.note(f"approvals worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def worker_sessions(self, c: Client):
        # Send-only; replies/broadcasts are read by the shared drain task.
        while not self.stop_event.is_set():
            try:
                await c.send({"type": "sound_session_start", "seconds": 5})
                await asyncio.sleep(1.0)
                await c.send({"type": "sound_session_stop"})
                await asyncio.sleep(1.0)
                await c.send({"type": "air_session_start", "seconds": 5})
                await asyncio.sleep(1.0)
                await c.send({"type": "air_session_stop"})
                await asyncio.sleep(random.uniform(3.0, 6.0))
            except Exception as e:
                self.sink.note(f"sessions worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def worker_pause_resume(self, c: Client):
        # Send-only; replies/broadcasts are read by the shared drain task.
        while not self.stop_event.is_set():
            try:
                await c.send({"type": "pause"})
                await asyncio.sleep(random.uniform(2.0, 5.0))
                await c.send({"type": "resume"})
                await asyncio.sleep(random.uniform(5.0, 10.0))
            except Exception as e:
                self.sink.note(f"pause_resume worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def worker_reconnect_churn(self, zones: list[str]):
        """A steady trickle of connect/subscribe/disconnect cycles, like the
        app's main window and HUD opening and closing over hours."""
        while not self.stop_event.is_set():
            try:
                cc = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
                await cc.connect(timeout=5)
                await cc.handshake(timeout=5)
                await cc.send({"type": "subscribe", "streams": ["imu", "lid", "light", "taps", "debug"]})
                await cc.drain(duration=random.uniform(0.5, 2.0))
                await cc.close()
                await asyncio.sleep(random.uniform(2.0, 6.0))
            except Exception as e:
                self.sink.note(f"reconnect_churn worker error (non-fatal): {e!r}")
                await asyncio.sleep(2.0)

    async def monitor(self):
        baseline = None
        fd_baseline = None
        thread_baseline = None
        last_note = time.time()
        started = time.time()
        while time.time() < self.deadline and not self.stop_event.is_set():
            try:
                if self.daemon.is_alive():
                    pid = self.daemon.pid
                    s = daemon_proc.ps_sample(pid)
                    fds = daemon_proc.fd_count(pid)
                    threads = daemon_proc.thread_count(pid)
                    if s:
                        cpu, rss = s
                        if baseline is None:
                            baseline = rss
                        if fd_baseline is None and fds is not None:
                            fd_baseline = fds
                        if thread_baseline is None and threads is not None:
                            thread_baseline = threads
                        row = {"t": round(time.time(), 1), "elapsed_s": round(time.time() - started, 1),
                              "cpu": cpu, "rss_kb": rss, "fds": fds, "threads": threads, "restarts": self.restarts}
                        self.sink.sample(row)
                        if time.time() - last_note > 600:  # log a note every 10 min so progress is visible mid-run
                            self.sink.note(f"soak progress: rss={rss:.0f}KB (baseline {baseline:.0f}KB), "
                                          f"cpu={cpu:.1f}%, fds={fds}, threads={threads}, restarts={self.restarts}")
                            last_note = time.time()
                        if baseline and rss - baseline > RSS_GROWTH_FLAG_KB:
                            self.sink.finding("high", f"daemon RSS grew {rss - baseline:.0f} KB over the soak "
                                                      f"(baseline {baseline:.0f} KB, now {rss:.0f} KB)",
                                              repro="run soak.py to completion; see samples in the JSON for the curve")
                            baseline = rss  # avoid re-flagging every sample once noted
                        if fds is not None and fd_baseline is not None and fds - fd_baseline > FD_GROWTH_FLAG:
                            self.sink.finding("high", f"daemon open file descriptors grew from {fd_baseline} to {fds} "
                                                      f"over the soak (possible fd leak)",
                                              repro="run soak.py to completion; see samples in the JSON")
                            fd_baseline = fds
                        if threads is not None and thread_baseline is not None and threads - thread_baseline > THREAD_GROWTH_FLAG:
                            self.sink.finding("high", f"daemon thread count grew from {thread_baseline} to {threads} "
                                                      f"over the soak (possible thread leak)",
                                              repro="run soak.py to completion; see samples in the JSON")
                            thread_baseline = threads
                else:
                    await self.ensure_alive("monitor detected daemon down")
            except Exception as e:
                self.sink.note(f"monitor exception (non-fatal): {e!r}")
            await asyncio.sleep(SAMPLE_INTERVAL)

    async def run(self):
        self.daemon.start(wait_ready=10.0)

        # Each connection is read by exactly one coroutine (websockets forbids
        # concurrent recv() on one connection): `listener` and `write_client`
        # each get their own dedicated drain loop; `cal_client` is read only by
        # its own worker via recv_type/recv_matching.
        listener = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
        await listener.connect(timeout=10)
        hs = await listener.handshake(timeout=10)
        base_config = hs["config"]["config"]
        zones = [z["id"] for z in base_config["zones"]]
        await listener.send({"type": "subscribe", "streams": ["imu", "lid", "light", "taps", "debug"]})

        write_client = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
        await write_client.connect(timeout=10)
        await write_client.handshake(timeout=10)

        cal_client = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
        await cal_client.connect(timeout=10)
        await cal_client.handshake(timeout=10)

        approval_replies: asyncio.Queue = asyncio.Queue()

        async def drain_forever(client: Client, sink_queue: "asyncio.Queue | None" = None):
            while not self.stop_event.is_set():
                try:
                    msg = await client.recv(timeout=1.0)
                    if sink_queue is not None:
                        sink_queue.put_nowait(msg)
                except Exception:
                    pass

        tasks = [
            asyncio.create_task(drain_forever(listener)),
            asyncio.create_task(drain_forever(write_client, approval_replies)),
            asyncio.create_task(self.worker_taps_and_gestures(write_client, zones)),
            asyncio.create_task(self.worker_config_churn(write_client, base_config)),
            asyncio.create_task(self.worker_calibration_cycles(cal_client, zones)),
            asyncio.create_task(self.worker_feedback(write_client, zones)),
            asyncio.create_task(self.worker_approvals(write_client, approval_replies)),
            asyncio.create_task(self.worker_sessions(write_client)),
            asyncio.create_task(self.worker_pause_resume(write_client)),
            asyncio.create_task(self.worker_reconnect_churn(zones)),
            asyncio.create_task(self.monitor()),
        ]

        remaining = self.deadline - time.time()
        if remaining > 0:
            await asyncio.sleep(remaining)
        self.stop_event.set()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await listener.close()
        await write_client.close()
        await cal_client.close()

        alive = self.daemon.is_alive()
        responsive = False
        if alive:
            try:
                cc = Client(f"ws://{HOST}:{PORT}/", token=self.daemon.token)
                await cc.connect(timeout=5)
                r = await cc.request({"type": "config_get"}, "config", timeout=5)
                responsive = r.get("type") == "config"
                await cc.close()
            except Exception as e:
                self.sink.note(f"final responsiveness check failed: {e!r}")
        self.sink.metric("final_alive", alive)
        self.sink.metric("final_responsive", responsive)
        self.sink.metric("restarts", self.restarts)
        if not alive:
            self.sink.finding("CRITICAL", "daemon not alive at end of soak", repro="run soak.py to completion")
        elif not responsive:
            self.sink.finding("high", "daemon alive but unresponsive at end of soak", repro="run soak.py to completion")
        if self.daemon.is_alive():
            self.daemon.stop()


async def main():
    config_dir = Path(sys.argv[1])
    findings_path = Path(sys.argv[2])
    seconds = float(sys.argv[3]) if len(sys.argv) > 3 else float(os.environ.get("STRESS_SOAK_SECONDS", 7200))
    sink = Sink(findings_path, "soak")
    sink.metric("planned_seconds", seconds)
    binary = daemon_proc.BINARY_PATH
    if not binary.exists():
        sink.finding("CRITICAL", "stress daemon binary missing", repro=f"expected {binary}")
        sink.finish("build_missing")
        return
    deadline = time.time() + seconds
    soak = Soak(sink, binary, config_dir, deadline)
    try:
        await soak.run()
        sink.finish("completed")
    except Exception as e:
        sink.finding("CRITICAL", "soak harness itself crashed", repro=str(e))
        sink.finish("harness_error")
        raise
    finally:
        daemon_proc.kill_stray_ghostkeysd_stress()


if __name__ == "__main__":
    asyncio.run(main())
