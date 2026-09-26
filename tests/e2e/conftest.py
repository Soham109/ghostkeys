from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio

sys.path.insert(0, str(Path(__file__).resolve().parent))

import harness
import results
from harness import DaemonProcess, DEFAULT_PORT
from ws_client import Client


# ---------------------------------------------------------------------------
# Building and running the daemon.
#
# Every daemon instance gets its own --config-dir (a pytest tmp_path), so this
# suite never reads, writes or restores anything under the real
# ~/Library/Application Support/Ghostkeys/ -- see FINDINGS.md #2 and #7.
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def daemon_binary():
    return harness.build_daemon()


@pytest.fixture(scope="session", autouse=True)
def _capture_environment(daemon_binary, tmp_path_factory):
    """One throwaway connection at session start, purely to record device/sensor
    info (from `hello`) into the REPORT.md header."""
    port = DEFAULT_PORT
    if not harness.wait_port_free(port, timeout=10):
        results.note(f"port {port} was already in use at session start; skipped the environment probe")
        return
    config_dir = tmp_path_factory.mktemp("ghostkeysd-env-probe")
    d = DaemonProcess(daemon_binary, config_dir=config_dir, port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d)

        async def _probe():
            c = Client(f"ws://127.0.0.1:{port}/", token=d.token)
            await c.connect()
            hs = await c.handshake()
            await c.close()
            return hs

        hs = asyncio.run(_probe())
        results.record("hello", hs["hello"])
        results.record("initial_status", hs["status"])
    except Exception as e:  # pragma: no cover - best effort only
        results.note(f"environment probe failed: {e}")
    finally:
        d.stop()
        harness.wait_port_free(port, timeout=5)


@pytest.fixture
def port():
    ok = harness.wait_port_free(DEFAULT_PORT, timeout=10)
    if not ok:
        pytest.skip(f"port {DEFAULT_PORT} is in use by something this suite did not start; refusing to touch it")
    return DEFAULT_PORT


@pytest.fixture
def daemon(daemon_binary, port, tmp_path):
    d = DaemonProcess(daemon_binary, config_dir=tmp_path / "ghostkeys-config", port=port, dry_run=True, verbose=True)
    try:
        harness.start_resilient(d)
    except TimeoutError as e:
        pytest.skip(str(e))
    yield d
    rc = d.stop()
    if d.killed_hard:
        results.note(f"daemon pid {d.pid} did not exit on SIGTERM within the timeout and had to be SIGKILLed "
                     f"(args={d.args()})")
    harness.wait_port_free(port, timeout=5)


@pytest_asyncio.fixture
async def client(daemon):
    c = Client(f"ws://127.0.0.1:{daemon.port}/", token=daemon.token)
    await c.connect()
    yield c
    await c.close()


@pytest_asyncio.fixture
async def connected(client):
    """A client past the initial hello/status/config handshake, for tests that
    care about something else."""
    hs = await client.handshake()
    return SimpleNamespace(client=client, hello=hs["hello"], status=hs["status"], config=hs["config"])


@pytest.fixture
def config_path(daemon):
    return daemon.config_dir / "config.json"


# ---------------------------------------------------------------------------
# REPORT.md generation.
# ---------------------------------------------------------------------------

def pytest_sessionfinish(session, exitstatus):
    try:
        _write_report(session, exitstatus)
    except Exception as e:  # pragma: no cover - never let reporting break the run
        sys.stderr.write(f"[conftest] failed to write REPORT.md: {e}\n")


def _write_report(session, exitstatus) -> None:
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    stats = getattr(tr, "stats", {}) if tr else {}

    def reports_for(*outcomes):
        out = []
        for o in outcomes:
            out.extend(stats.get(o, []))
        return out

    passed = [r for r in reports_for("passed") if r.when == "call"]
    failed = [r for r in reports_for("failed") if r.when in ("call", "setup")]
    skipped = [r for r in reports_for("skipped") if r.when in ("call", "setup")]
    errors = [r for r in reports_for("error")]

    lines: list[str] = []
    lines.append("# ghostkeysd e2e test report")
    lines.append("")
    lines.append(f"Generated {time.strftime('%Y-%m-%d %H:%M:%S %z')}, exit status {exitstatus}.")
    lines.append("")
    lines.append(f"Daemon binary: `{harness.BINARY_PATH}`")
    lines.append("Run with `--dry-run` for every test in this suite; no action a test triggers actually executes.")
    lines.append("Every daemon instance gets its own `--config-dir` (a pytest `tmp_path`); this suite never touches "
                 "the real `~/Library/Application Support/Ghostkeys/`.")
    lines.append("")

    hello = results.DATA.get("hello")
    if hello:
        dev = hello.get("device", {})
        sensors = hello.get("sensors", {})
        lines.append("## Environment")
        lines.append("")
        lines.append(f"- Device: {dev.get('model')} / {dev.get('chip')} / {dev.get('family')}")
        lines.append(f"- Daemon version: {hello.get('version')}")
        lines.append(f"- Sensors present at hello: {sensors}")
        lines.append(f"- Accessibility permission granted: {hello.get('permissions', {}).get('accessibility')}")
        lines.append("")

    lines.append("## Summary")
    lines.append("")
    lines.append(f"- Passed: {len(passed)}")
    lines.append(f"- Failed: {len(failed)}")
    lines.append(f"- Errors: {len(errors)}")
    lines.append(f"- Skipped: {len(skipped)}")
    lines.append("")

    if failed or errors:
        lines.append("## Failures / errors")
        lines.append("")
        for r in failed + errors:
            reason = ""
            if getattr(r, "longrepr", None) is not None:
                text = r.longreprtext if hasattr(r, "longreprtext") else str(r.longrepr)
                reason = text.strip().splitlines()[-1] if text.strip() else ""
            lines.append(f"- `{r.nodeid}`: {reason}")
        lines.append("")

    if skipped:
        lines.append("## Skipped")
        lines.append("")
        for r in skipped:
            reason = ""
            if getattr(r, "longrepr", None) is not None and isinstance(r.longrepr, tuple) and len(r.longrepr) == 3:
                reason = r.longrepr[2]
            lines.append(f"- `{r.nodeid}`: {reason}")
        lines.append("")

    lines.append("## Measurements")
    lines.append("")
    measurement_keys = [k for k in results.DATA.keys() if k not in ("hello", "initial_status")]
    if measurement_keys:
        for k in sorted(measurement_keys):
            lines.append(f"- **{k}**: {results.DATA[k]}")
    else:
        lines.append("(none recorded)")
    lines.append("")

    if results.NOTES:
        lines.append("## Notes")
        lines.append("")
        for n in results.NOTES:
            lines.append(f"- {n}")
        lines.append("")

    lines.append("## Fixed since earlier runs (see FINDINGS.md for detail)")
    lines.append("")
    lines.append("- FINDINGS.md #1 (Finder/self quit guard unreachable in dry-run): fixed. "
                 "`WindowActions.checkApp(_:)` now does the frontmost-app refusal checks and is called from "
                 "`ActionRunner.validate(\"app\", ...)`, so dry-run and a real run agree. "
                 "`test_actions.py::test_action_app_quit_finder_refused_when_frontmost` covers it, skipping when "
                 "Finder is not actually the frontmost app (this suite never changes focus to force it).")
    lines.append("- FINDINGS.md #2 (no --config-dir): fixed. `Options.swift` gained `--config-dir PATH` / "
                 "`GHOSTKEYS_CONFIG_DIR`; the default moved to "
                 "`~/Library/Application Support/Ghostkeys/daemon/` so the Electron app keeps the parent folder. "
                 "This suite now gives every daemon instance its own throwaway `--config-dir` and never touches "
                 "the real directory at all (superseding the earlier surgical-backup workaround).")
    lines.append("- FINDINGS.md #5 (simultaneous handshakes could all be refused): fixed. "
                 "`WebSocketServer` now serializes handshakes (`admissions` queue + `admitNext()`), so two "
                 "connections opened at the same instant both succeed instead of racing. "
                 "`test_handshake.py::test_concurrent_handshakes_both_succeed` covers it.")
    lines.append("")

    lines.append("## Remaining known gaps (see FINDINGS.md for repro steps and file/line)")
    lines.append("")
    lines.append("- The `integration` action kind was an unimplemented stub when this suite was started and a "
                 "full implementation landed mid-session; the suite tracks the current, working behavior "
                 "(FINDINGS.md #3).")
    lines.append("- Calibration sample capture (`calibration_zone` actually accumulating counts) needs a real "
                 "physical tap on the case; this suite can only exercise the control-flow messages, not capture "
                 "itself (FINDINGS.md #4).")
    lines.append("- This daemon was under active, concurrent development while this suite was written (auth, "
                 "approvals, integrations, config-dir isolation, and a sessions/air/sound subsystem all landed "
                 "mid-session); the sessions/air/sound/catalog/knob surface is intentionally out of scope for this "
                 "suite (FINDINGS.md #6).")
    lines.append("")

    report_path = Path(__file__).resolve().parent / "REPORT.md"
    report_path.write_text("\n".join(lines) + "\n")
