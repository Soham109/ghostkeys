"""Chaos tests: SIGKILL the daemon mid config-write, mid-calibration and mid
model-save; simulate disk-full via a read-only config directory; check
--restore-sensors after a hard kill. All against --simulate-sensors
--no-hardware-sessions --dry-run instances on our stress ports.

Usage: python3 chaos.py <config_dir> <findings_json_path>
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import stat
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import daemon_proc
from lib.findings import Sink
from lib.ws_client import Client

PORT = 47972
HOST = "127.0.0.1"


def valid_json_file(path: Path) -> tuple[bool, str]:
    if not path.exists():
        return True, "absent (ok: nothing was written yet)"
    try:
        json.loads(path.read_text())
        return True, "parses ok"
    except Exception as e:
        return False, f"CORRUPT: {e}"


async def fresh_daemon(binary, cfg_dir, port):
    d = daemon_proc.DaemonProcess(binary, cfg_dir, port)
    d.start(wait_ready=10.0)
    return d


async def sigkill_mid_config_write(sink: Sink, binary, base_dir: Path, trials: int = 15):
    """Floods config_set while a background task SIGKILLs the daemon at a
    random moment, then restarts against the same --config-dir and checks
    config.json / config.json.bak are each either absent or valid JSON."""
    corrupt = 0
    for i in range(trials):
        cfg = base_dir / f"cfgwrite-{i}"
        d = await fresh_daemon(binary, cfg, PORT)
        try:
            c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
            await c.connect(timeout=5)
            hs = await c.handshake(timeout=5)
            base_config = hs["config"]["config"]

            async def flood():
                n = 0
                while True:
                    cc = dict(base_config)
                    cc["settings"] = dict(cc.get("settings", {}))
                    cc["settings"]["_stress_marker"] = n
                    try:
                        await c.send({"type": "config_set", "config": cc})
                    except Exception:
                        return
                    n += 1
                    await asyncio.sleep(0.002)

            task = asyncio.create_task(flood())
            await asyncio.sleep(random.uniform(0.02, 0.3))
            task.cancel()
            d.sigkill_now()
        finally:
            pass

        ok_cfg, msg_cfg = valid_json_file(cfg / "config.json")
        ok_bak, msg_bak = valid_json_file(cfg / "config.json.bak")
        if not ok_cfg or not ok_bak:
            corrupt += 1
            sink.finding("CRITICAL", f"config file corrupted after SIGKILL mid config_set (trial {i})",
                        repro=f"flood config_set on a fresh daemon, SIGKILL after {0.02}-{0.3}s, inspect "
                              f"{cfg}/config.json and config.json.bak",
                        detail=f"config.json: {msg_cfg}; config.json.bak: {msg_bak}")
            continue

        # Restart against the same config dir: must come up cleanly.
        try:
            d2 = await fresh_daemon(binary, cfg, PORT)
            alive = d2.is_alive()
            d2.stop()
            if not alive:
                sink.finding("high", f"daemon would not restart after SIGKILL mid config_set (trial {i})",
                            repro=f"restart with --config-dir {cfg} after the kill", detail=d2.stderr_text()[-2000:])
        except Exception as e:
            sink.finding("high", f"daemon failed to restart after SIGKILL mid config_set (trial {i})",
                        repro=f"restart with --config-dir {cfg} after the kill", detail=repr(e))
    sink.metric("config_write_kill_trials", trials)
    sink.metric("config_write_kill_corrupt_count", corrupt)
    if corrupt == 0:
        sink.note(f"SIGKILL-mid-config_set: {trials}/{trials} trials left config.json (+.bak) valid JSON "
                  f"(ConfigStore.write()'s atomic Data.write held up)")


async def sigkill_mid_calibration_started(sink: Sink, binary, base_dir: Path, trials: int = 8):
    """Starts calibration (and a few real synthetic taps via sim_spike live)
    but never finishes it, then SIGKILLs. Nothing should be corrupted: the raw
    .gkrec session is only flushed on finish/cancel, so an in-progress one
    should simply be dropped, not half-written."""
    corrupt = 0
    for i in range(trials):
        cfg = base_dir / f"calkill-{i}"
        d = await fresh_daemon(binary, cfg, PORT)
        try:
            c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
            await c.connect(timeout=5)
            hs = await c.handshake(timeout=5)
            zone = hs["config"]["config"]["zones"][0]["id"]
            await c.send({"type": "calibration_start", "zones": [zone], "target": 20})
            await c.recv_type("calibration", timeout=3)
            await c.send({"type": "calibration_zone", "zone": zone})
            await c.recv_type("calibration", timeout=3)
            for _ in range(random.randint(0, 4)):
                await c.send({"type": "sim_spike", "live": True})
                await asyncio.sleep(0.15)
            d.sigkill_now()
        finally:
            pass
        ok_cfg, msg_cfg = valid_json_file(cfg / "config.json")
        raw_dir = cfg / "model" / "raw"
        raw_ok = True
        raw_detail = "no raw/ directory (ok: calibration never finished)"
        if raw_dir.exists():
            for f in raw_dir.glob("*.gkrec"):
                try:
                    # gkrec is a binary/record format elsewhere in this repo; we only check it's non-empty and
                    # was fully closed (size is stable across two reads a moment apart), not full schema validity.
                    s1 = f.stat().st_size
                    await asyncio.sleep(0.05)
                    s2 = f.stat().st_size
                    if s1 != s2:
                        raw_ok = False
                        raw_detail = f"{f} size still changing after process death ({s1} -> {s2} bytes)"
                except FileNotFoundError:
                    pass
        if not ok_cfg or not raw_ok:
            corrupt += 1
            sink.finding("high", f"state corrupted after SIGKILL mid-calibration-in-progress (trial {i})",
                        repro=f"calibration_start + calibration_zone + a few sim_spike live=true, "
                              f"SIGKILL before calibration_finish",
                        detail=f"config.json: {msg_cfg}; raw dir: {raw_detail}")
        try:
            d2 = await fresh_daemon(binary, cfg, PORT)
            d2.stop()
        except Exception as e:
            sink.finding("high", f"daemon would not restart after SIGKILL mid-calibration (trial {i})",
                        repro=f"restart with --config-dir {cfg}", detail=repr(e))
    sink.metric("calibration_in_progress_kill_trials", trials)
    sink.metric("calibration_in_progress_kill_corrupt_count", corrupt)


async def sigkill_mid_model_save(sink: Sink, binary, base_dir: Path, trials: int = 10):
    """Drives a real calibration to calibration_finish (via sim_spike live=true,
    which injects a synthetic tap into the *live* detector even under
    --simulate-sensors, see Daemon.swift `sim_spike` handling) and SIGKILLs
    immediately after sending calibration_finish, racing the background
    DispatchQueue.global training+save in ConfigStore.saveModel /
    saveSamples. Checks model/zone-model.json, model/calibration-report.json
    and model/samples.json are each absent or valid JSON afterward."""
    corrupt = 0
    for i in range(trials):
        cfg = base_dir / f"modelkill-{i}"
        d = await fresh_daemon(binary, cfg, PORT)
        try:
            c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
            await c.connect(timeout=5)
            hs = await c.handshake(timeout=5)
            zone = hs["config"]["config"]["zones"][0]["id"]
            await c.send({"type": "calibration_start", "zones": [zone], "target": 5})
            await c.recv_type("calibration", timeout=3)
            await c.send({"type": "calibration_zone", "zone": zone})
            await c.recv_type("calibration", timeout=3)
            got = 0
            deadline = time.monotonic() + 8
            while got < 5 and time.monotonic() < deadline:
                await c.send({"type": "sim_spike", "live": True})
                try:
                    msg = await c.recv_type("calibration", timeout=1.0)
                    got = msg.get("count", got)
                except Exception:
                    pass
            await c.send({"type": "calibration_finish"})
            # Race the async trainer: a short, randomized delay before killing.
            await asyncio.sleep(random.uniform(0.0, 0.05))
            d.sigkill_now()
        finally:
            pass

        checks = {
            "config.json": cfg / "config.json",
            "model/zone-model.json": cfg / "model" / "zone-model.json",
            "model/zone-model.json.bak": cfg / "model" / "zone-model.json.bak",
            "model/calibration-report.json": cfg / "model" / "calibration-report.json",
            "model/samples.json": cfg / "model" / "samples.json",
        }
        bad = []
        for name, path in checks.items():
            ok, msg = valid_json_file(path)
            if not ok:
                bad.append(f"{name}: {msg}")
        if bad:
            corrupt += 1
            sink.finding("CRITICAL", f"model/report/samples file corrupted after SIGKILL mid model-save (trial {i})",
                        repro="calibration_start/zone/several sim_spike live=true to reach target, "
                              "calibration_finish, SIGKILL within 0-50ms",
                        detail="; ".join(bad))
        try:
            d2 = await fresh_daemon(binary, cfg, PORT)
            alive = d2.is_alive()
            responsive = False
            try:
                c2 = Client(f"ws://{HOST}:{PORT}/", token=d2.token)
                await c2.connect(timeout=5)
                r = await c2.request({"type": "config_get"}, "config", timeout=5)
                responsive = r.get("type") == "config"
                await c2.close()
            except Exception:
                pass
            d2.stop()
            if not alive or not responsive:
                sink.finding("high", f"daemon did not come back cleanly after SIGKILL mid model-save (trial {i})",
                            repro=f"restart with --config-dir {cfg}", detail=d2.stderr_text()[-2000:])
        except Exception as e:
            sink.finding("high", f"daemon failed to restart after SIGKILL mid model-save (trial {i})",
                        repro=f"restart with --config-dir {cfg}", detail=repr(e))
    sink.metric("model_save_kill_trials", trials)
    sink.metric("model_save_kill_corrupt_count", corrupt)
    if corrupt == 0:
        sink.note(f"SIGKILL-mid-model-save: {trials}/{trials} trials left model/report/samples files valid JSON")


async def restore_sensors_after_kill(sink: Sink, binary, base_dir: Path):
    cfg = base_dir / "restore-sensors"
    d = await fresh_daemon(binary, cfg, PORT)
    d.sigkill_now()
    proc = subprocess.run([str(binary), "--config-dir", str(cfg), "--restore-sensors"],
                          capture_output=True, text=True, timeout=10)
    sink.metric("restore_sensors_exit_code", proc.returncode)
    sink.metric("restore_sensors_stdout", proc.stdout.strip())
    if proc.returncode != 0:
        sink.finding("high", "--restore-sensors did not exit 0 after a SIGKILLed --simulate-sensors daemon",
                    repro=f"start with --config-dir {cfg} --simulate-sensors, SIGKILL, then run --restore-sensors",
                    detail=f"exit {proc.returncode}, stdout={proc.stdout!r}, stderr={proc.stderr!r}")
    else:
        sink.note(f"--restore-sensors after SIGKILL: exit 0, printed {proc.stdout.strip()!r}")
    # And a fresh daemon must still be able to start (lock released by the kernel on SIGKILL).
    try:
        d2 = await fresh_daemon(binary, cfg, PORT)
        d2.stop()
        sink.note("fresh daemon started cleanly against the same --config-dir right after --restore-sensors")
    except Exception as e:
        sink.finding("CRITICAL", "daemon could not start after SIGKILL + --restore-sensors (stale lock?)",
                    repro=f"--config-dir {cfg}", detail=repr(e))


async def disk_full_simulation(sink: Sink, binary, base_dir: Path):
    """Simulates a full/unwritable disk by chmod'ing the config dir (or its
    model/ subdirectory) read-only after the daemon has started, per the
    overnight safety note: no disk image, just a read-only directory."""
    cfg = base_dir / "diskfull"
    d = await fresh_daemon(binary, cfg, PORT)
    try:
        c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
        await c.connect(timeout=5)
        hs = await c.handshake(timeout=5)
        base_config = hs["config"]["config"]

        # 1) whole config dir read-only, then try config_set.
        os.chmod(cfg, 0o500)
        try:
            cc = dict(base_config)
            cc["settings"] = dict(cc.get("settings", {}))
            cc["settings"]["_stress_marker"] = "diskfull"
            await c.send({"type": "config_set", "config": cc})
            reply = None
            try:
                reply = await c.recv_matching(lambda m: m.get("type") in ("config", "error"), timeout=3)
            except Exception as e:
                sink.note(f"disk-full config_set: no reply within 3s ({e!r}); checking daemon liveness")
            if reply is not None and reply.get("type") == "error":
                sink.note(f"disk-full config_set correctly reported an error: {reply.get('message')}")
            elif reply is not None and reply.get("type") == "config":
                sink.finding("medium", "config_set reported success while the config directory was read-only",
                            repro=f"chmod 0500 {cfg}, then send config_set", detail=str(reply))
            if not d.is_alive():
                sink.finding("CRITICAL", "daemon crashed when the config directory became read-only during config_set",
                            repro=f"chmod 0500 {cfg}, then send config_set", detail=d.stderr_text()[-2000:])
        finally:
            os.chmod(cfg, 0o700)

        # Must recover: a config_set after permissions are restored should succeed.
        if d.is_alive():
            try:
                cc2 = dict(base_config)
                r = await c.request({"type": "config_set", "config": cc2}, "config", timeout=5)
                sink.note(f"recovered after restoring permissions: config_set succeeded ({r.get('type')})")
            except Exception as e:
                sink.finding("high", "daemon did not recover after read-only config dir was restored to writable",
                            repro=f"chmod 0500 then 0700 on {cfg}, config_set after each", detail=repr(e))

        # 2) model/ subdirectory read-only, then drive a calibration to finish.
        model_dir = cfg / "model"
        model_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(model_dir, 0o500)
        try:
            zone = base_config["zones"][0]["id"]
            await c.send({"type": "calibration_start", "zones": [zone], "target": 3})
            await c.recv_type("calibration", timeout=3)
            await c.send({"type": "calibration_zone", "zone": zone})
            await c.recv_type("calibration", timeout=3)
            got = 0
            deadline = time.monotonic() + 6
            while got < 3 and time.monotonic() < deadline:
                await c.send({"type": "sim_spike", "live": True})
                try:
                    msg = await c.recv_type("calibration", timeout=1.0)
                    got = msg.get("count", got)
                except Exception:
                    pass
            await c.send({"type": "calibration_finish"})
            try:
                await c.recv_matching(lambda m: m.get("type") == "calibration" and m.get("phase") == "done",
                                      timeout=6)
                sink.finding("medium", "calibration_finish reported 'done' while model/ was read-only "
                                       "(save likely silently failed)",
                            repro=f"chmod 0500 {model_dir}, then complete a calibration",
                            detail="Daemon.finishCalibration logs a Log.error on saveModel failure but always "
                                  "broadcasts phase:done regardless of whether the save succeeded.")
            except Exception:
                sink.note("calibration did not report 'done' while model/ was read-only (or timed out) -- "
                         "checking daemon survived the failed save")
            if not d.is_alive():
                sink.finding("CRITICAL", "daemon crashed when model/ was read-only during calibration_finish",
                            repro=f"chmod 0500 {model_dir}, complete a calibration", detail=d.stderr_text()[-2000:])
        finally:
            os.chmod(model_dir, 0o700)
    finally:
        if d.is_alive():
            d.stop()


async def main():
    base_dir = Path(sys.argv[1])
    findings_path = Path(sys.argv[2])
    sink = Sink(findings_path, "chaos")
    binary = daemon_proc.BINARY_PATH
    if not binary.exists():
        sink.finding("CRITICAL", "stress daemon binary missing", repro=f"expected {binary}")
        sink.finish("build_missing")
        return
    try:
        await sigkill_mid_config_write(sink, binary, base_dir)
        await sigkill_mid_calibration_started(sink, binary, base_dir)
        await sigkill_mid_model_save(sink, binary, base_dir)
        await restore_sensors_after_kill(sink, binary, base_dir)
        await disk_full_simulation(sink, binary, base_dir)
        sink.note("clock-jump chaos test skipped: changing the system clock needs sudo (prohibited by the "
                 "overnight safety rules), and the daemon's CLI has no --simulate-clock-jump hook to fault-inject "
                 "this in-process; out of reach for a black-box, no-sudo stress test.")
        sink.finish("completed")
    except Exception as e:
        sink.finding("CRITICAL", "chaos harness itself crashed", repro=str(e))
        sink.finish("harness_error")
        raise
    finally:
        daemon_proc.kill_stray_ghostkeysd_stress()


if __name__ == "__main__":
    asyncio.run(main())
