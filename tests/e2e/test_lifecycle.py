"""pause/resume, clean shutdown on SIGTERM/SIGINT (App/main.swift signal
handlers + Sensors/SPUDriverControl.swift restore()), and the single-instance
lock (App/Lifetime.swift InstanceLock)."""
from __future__ import annotations

import signal

import pytest

import harness
from harness import DaemonProcess
from ws_client import Client


async def test_pause_then_resume_broadcast_status(connected):
    c = connected.client
    assert connected.status["paused"] is False
    assert connected.status["pausedReason"] is None

    await c.send({"type": "pause"})
    paused = await c.recv_type("status", timeout=3)
    assert paused["paused"] is True
    assert paused["pausedReason"] == "user"

    await c.send({"type": "resume"})
    resumed = await c.recv_type("status", timeout=3)
    assert resumed["paused"] is False
    assert resumed["pausedReason"] is None


async def _assert_clean_shutdown(daemon_binary, port, tmp_path, sig: int, sig_num_expected: int):
    d = DaemonProcess(daemon_binary, config_dir=tmp_path / "ghostkeys-config", port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d)
    except TimeoutError as e:
        pytest.skip(str(e))
    try:
        async with Client(f"ws://127.0.0.1:{port}/", token=d.token) as c:
            hs = await c.handshake()
        # Simulated sensors report an imu in hello but never touch the driver, so there is nothing to restore.
        imu_present = bool(hs["hello"]["sensors"].get("imu")) and harness.REAL_SENSORS

        d.proc.send_signal(sig)
        code = d.wait(timeout=5.0)
        assert code is not None, f"daemon did not exit within 5s of signal {sig}\nstderr:\n{d.stderr_text()}"
        assert code == 0, f"expected a clean exit(0), got {code}\nstderr:\n{d.stderr_text()}"
        assert not d.killed_hard, "the signal handler should have exited the process on its own"

        stderr = d.stderr_text()
        # Lifetime.shutdown() logs "<reason>; shutting down" (semicolon), reason == "signal <N>".
        assert f"signal {sig_num_expected}; shutting down" in stderr, (
            f"expected the shutdown log line for signal {sig_num_expected}\nstderr:\n{stderr}"
        )
        if imu_present:
            assert "restored" in stderr and "sensor driver setting" in stderr, (
                "expected SPUDriverControl.restore() to log that it put sensor driver settings back\n" + stderr
            )
    finally:
        if d.is_alive():
            d.stop()
    assert harness.wait_port_free(port, timeout=5)


async def test_sigterm_clean_shutdown_restores_sensors(daemon_binary, port, tmp_path):
    await _assert_clean_shutdown(daemon_binary, port, tmp_path, signal.SIGTERM, 15)


async def test_sigint_clean_shutdown_restores_sensors(daemon_binary, port, tmp_path):
    await _assert_clean_shutdown(daemon_binary, port, tmp_path, signal.SIGINT, 2)


async def test_single_instance_second_daemon_refuses_to_start(daemon, daemon_binary):
    # Same --config-dir as the `daemon` fixture on purpose: the single-instance
    # lock (App/Lifetime.swift InstanceLock) is now scoped per config-dir, so two
    # daemons pointed at *different* dirs would happily coexist (each getting its
    # own daemon.lock) -- this test is specifically about two instances sharing
    # one config dir, which is what "single instance" means now.
    second = DaemonProcess(daemon_binary, config_dir=daemon.config_dir, port=daemon.port, dry_run=True, verbose=True)
    with pytest.raises(RuntimeError):
        second.start(wait_ready=3)
    assert second.proc is not None
    assert second.proc.returncode == 4, f"expected exit code 4, got {second.proc.returncode}"
    assert "already running" in second.stderr_text()
    # The first daemon (from the `daemon` fixture) must be unaffected.
    assert daemon.is_alive()


async def test_sigkill_then_restore_sensors_recovers(daemon_binary, port, tmp_path):
    """Sensors/SPUDriverControl.swift now survives a hard kill: originals are
    persisted to spu-originals.json *before* the first write, so a SIGKILL (no
    chance to run its normal restore()) leaves that file behind, and the next
    start (or `--restore-sensors`) puts the driver settings back from it. We
    SIGKILL our own daemon on purpose here -- that's exactly the scenario this
    mechanism exists for, and --restore-sensors is the safe, explicit way to
    prove it recovered rather than leaving the motion sensor altered."""
    if not harness.REAL_SENSORS:
        pytest.skip("needs the real motion sensor driver (GHOSTKEYS_E2E_REAL_SENSORS=1); "
                    "--simulate-sensors never writes driver settings, so there is nothing to restore")
    config_dir = tmp_path / "ghostkeys-config"
    originals_path = config_dir / "spu-originals.json"

    d = DaemonProcess(daemon_binary, config_dir=config_dir, port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d)
    except TimeoutError as e:
        pytest.skip(str(e))

    async with Client(f"ws://127.0.0.1:{port}/", token=d.token) as c:
        hs = await c.handshake()
    if not hs["hello"]["sensors"].get("imu"):
        d.stop()
        pytest.skip("no accelerometer reported by hello; nothing for SPUDriverControl to have touched")

    d.proc.kill()  # simulate a crash: no normal shutdown path runs, restore() never fires
    code = d.wait(timeout=5.0)
    assert code is not None, "daemon did not die from SIGKILL within 5s"
    assert harness.wait_port_free(port, timeout=5)

    assert originals_path.exists(), (
        "expected spu-originals.json to have been written before the first sensor write "
        "(SPUDriverControl.wakeMotion persists originals up front) and left behind by a SIGKILL"
    )

    result = harness.run_restore_sensors(daemon_binary, config_dir)
    assert result.returncode == 0, f"--restore-sensors exited {result.returncode}\nstderr:\n{result.stderr}"
    assert "restored sensor settings left by a previous run" in result.stdout, result.stdout
    assert not originals_path.exists(), "spu-originals.json should be removed after a clean recovery"
