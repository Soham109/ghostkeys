"""Process and filesystem plumbing for the ghostkeysd e2e suite.

Ownership note: this whole tests/e2e/ tree is the only part of the ghostkeys repo we
own. We never touch daemon/Sources/**. This module only builds the daemon (an
isolated SwiftPM scratch dir) and launches/stops it as a subprocess.

Safety notes (see docs/PROTOCOL.md and the task brief):
- The daemon is only ever started with --dry-run so no action it runs actually
  executes (see FINDINGS.md #1 -- resolved: validate() now runs the frontmost-app
  refusal checks too, so this only matters for the true side effects).
- We always pass --parent-pid <this pytest process> so a crashed test runner still
  makes the daemon exit and restore its sensor driver settings.
- `--config-dir` (added to Options.swift in response to FINDINGS.md #2) points every
  daemon instance at its own private, throwaway directory (normally a pytest
  `tmp_path`). This suite never reads, writes, backs up or restores anything under
  the real `~/Library/Application Support/Ghostkeys/` (or its `daemon/` subdirectory)
  -- that path, and the Electron profile that also lives there (FINDINGS.md #7), are
  never touched at all.
- We only ever signal/kill processes this module started.
"""
from __future__ import annotations

import collections
import os
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
DAEMON_DIR = REPO_ROOT / "daemon"
# GHOSTKEYS_E2E_SCRATCH: SwiftPM scratch dir to build into (relative to daemon/ or absolute).
SCRATCH_PATH = DAEMON_DIR / os.environ.get("GHOSTKEYS_E2E_SCRATCH", ".build-e2e")
BINARY_PATH = SCRATCH_PATH / "debug" / "ghostkeysd"

# The app's own daemon listens on 47823. The suite must never share that port: probing it
# would connect to the user's live daemon, and every test would skip while it runs.
APP_DAEMON_PORT = 47823
DEFAULT_PORT = int(os.environ.get("GHOSTKEYS_E2E_PORT", "47891"))
if DEFAULT_PORT == APP_DAEMON_PORT:
    raise RuntimeError(f"GHOSTKEYS_E2E_PORT={APP_DAEMON_PORT} is the app's daemon port; pick a spare one")

# By default every daemon runs with --simulate-sensors --no-hardware-sessions (see README.md): no
# sensor, mic or camera is opened and the machine-wide sensor lock is not taken, so the suite can
# run while the real app is running. GHOSTKEYS_E2E_REAL_SENSORS=1 uses the real motion sensor
# instead (needs the app's daemon to be stopped).
REAL_SENSORS = os.environ.get("GHOSTKEYS_E2E_REAL_SENSORS") == "1"
SIMULATED_ARGS: list[str] = [] if REAL_SENSORS else ["--simulate-sensors", "--no-hardware-sessions"]


class BuildError(RuntimeError):
    pass


def build_daemon(timeout: float = 300.0) -> Path:
    """Builds only the ghostkeysd product into our own scratch dir (never touches
    the shared .build directory other tools/agents in this repo may be using)."""
    cmd = ["swift", "build", "--scratch-path", str(SCRATCH_PATH), "--product", "ghostkeysd"]
    proc = subprocess.run(cmd, cwd=str(DAEMON_DIR), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise BuildError(
            f"swift build failed (exit {proc.returncode}):\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
        )
    if not BINARY_PATH.exists():
        raise BuildError(f"build reported success but {BINARY_PATH} is missing")
    return BINARY_PATH


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.connect((host, port))
            return False  # something accepted the connection
        except OSError:
            return True


def wait_port_free(port: int, timeout: float = 5.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_is_free(port):
            return True
        time.sleep(0.1)
    return False


def start_resilient(d: "DaemonProcess", wait_ready: float = 8.0, total_budget: float = 45.0) -> None:
    """Starts `d`, retrying if the port is transiently held by *someone else's*
    ghostkeysd (or ghostkeys-lab, or anything else on this machine bound to
    47823). Each of our own daemon instances gets its own --config-dir, so we
    never race ourselves on the single-instance lock; this only matters for a
    colliding process outside this suite, which is not ours to kill, so we just
    wait our turn for up to `total_budget` seconds before giving up.
    """
    deadline = time.time() + total_budget
    last_err: Optional[Exception] = None
    while True:
        try:
            d.start(wait_ready=wait_ready)
            return
        except RuntimeError as e:
            msg = str(e)
            if "already running" not in msg and "before opening its port" not in msg:
                raise
            last_err = e
            if time.time() >= deadline:
                break
            time.sleep(1.0)
    raise TimeoutError(
        f"could not start our own daemon within {total_budget}s; another ghostkeysd instance "
        f"(not started by this suite) appears to be holding the lock/port the whole time: {last_err}"
    )


class DaemonProcess:
    """One ghostkeysd subprocess. Always dry-run, always given its own
    `--config-dir` (a caller-supplied throwaway directory, normally a pytest
    `tmp_path`), so it never touches the real, shared
    ~/Library/Application Support/Ghostkeys/. Captures stdout/stderr so tests
    can assert on log lines (e.g. the sensor-restore message) without risking a
    pipe deadlock."""

    def __init__(self, binary: Path, config_dir: Path, port: int = DEFAULT_PORT, dry_run: bool = True,
                 verbose: bool = True, extra_args: Optional[list[str]] = None,
                 parent_pid: Optional[int] = None):
        self.binary = str(binary)
        self.config_dir = Path(config_dir)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.port = port
        self.dry_run = dry_run
        self.verbose = verbose
        self.extra_args = extra_args or []
        self.parent_pid = parent_pid or os.getpid()
        self.proc: Optional[subprocess.Popen] = None
        self.stdout_lines: "collections.deque[str]" = collections.deque(maxlen=10000)
        self.stderr_lines: "collections.deque[str]" = collections.deque(maxlen=10000)
        self._threads: list[threading.Thread] = []
        self._killed_hard = False
        self._token: Optional[str] = None

    @property
    def token(self) -> str:
        """The per-launch handshake token (Security/SessionToken.swift), read
        directly from `<config_dir>/token`. Valid once the daemon has started
        (the token is written before the WebSocket listener opens)."""
        if self._token is None:
            token_path = self.config_dir / "token"
            deadline = time.time() + 5.0
            last_err: Optional[Exception] = None
            while time.time() < deadline:
                try:
                    self._token = token_path.read_text().strip()
                    break
                except OSError as e:
                    last_err = e
                    time.sleep(0.05)
            if self._token is None:
                raise RuntimeError(f"could not read token file at {token_path}: {last_err}")
        return self._token

    def _pump(self, stream, sink):
        try:
            for line in iter(stream.readline, ""):
                if not line:
                    break
                sink.append(line.rstrip("\n"))
        except (ValueError, OSError):
            pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def args(self) -> list[str]:
        a = [self.binary, "--port", str(self.port), "--parent-pid", str(self.parent_pid),
             "--config-dir", str(self.config_dir)]
        if self.dry_run:
            a.append("--dry-run")
        if self.verbose:
            a.append("--verbose")
        a += SIMULATED_ARGS
        a += self.extra_args
        return a

    def start(self, wait_ready: float = 8.0) -> None:
        self._token = None
        self.proc = subprocess.Popen(
            self.args(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        for stream, sink in ((self.proc.stdout, self.stdout_lines), (self.proc.stderr, self.stderr_lines)):
            t = threading.Thread(target=self._pump, args=(stream, sink), daemon=True)
            t.start()
            self._threads.append(t)
        self._wait_for_port(wait_ready)

    def _wait_for_port(self, timeout: float) -> None:
        """Waits for *this* process's own "listening on ws://..." log line
        (WebSocketServer.start(), logged unconditionally via Log.info on the
        .ready state) rather than probing the TCP port. Probing the port is
        racy: if a previous test's daemon is still mid-shutdown (SIGTERM
        handling restores sensor driver settings before exiting, which takes a
        moment), it can still be answering connections on this same port for a
        few milliseconds after our process has already lost the InstanceLock
        race and exited(4) -- a bare `connect()` succeeding would then be
        mistaken for *our* process being ready."""
        needle = f"listening on ws://127.0.0.1:{self.port}/"
        deadline = time.time() + timeout
        seen = 0
        while time.time() < deadline:
            rc = self.proc.poll()
            while seen < len(self.stderr_lines):
                line = self.stderr_lines[seen]
                seen += 1
                if needle in line:
                    return
            if rc is not None:
                raise RuntimeError(
                    f"daemon exited early with code {rc} before opening its port.\n"
                    f"args: {self.args()}\nstderr:\n" + "\n".join(self.stderr_lines)
                )
            time.sleep(0.02)
        raise TimeoutError(
            f"daemon did not log '{needle}' within {timeout}s\nstderr so far:\n" + "\n".join(self.stderr_lines)
        )

    @property
    def pid(self) -> Optional[int]:
        return self.proc.pid if self.proc else None

    @property
    def returncode(self) -> Optional[int]:
        return self.proc.poll() if self.proc else None

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def wait(self, timeout: float = 5.0) -> Optional[int]:
        assert self.proc is not None
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            return None

    def stop(self, sig: int = signal.SIGTERM, timeout: float = 5.0) -> Optional[int]:
        """Graceful stop of a process *we* started. Escalates to SIGKILL only as a
        last resort, and records that escalation was needed (a process that
        installs SIGTERM/SIGINT handlers and still needs SIGKILL is itself a
        finding)."""
        if self.proc is None or self.proc.poll() is not None:
            return self.proc.returncode if self.proc else None
        try:
            self.proc.send_signal(sig)
        except ProcessLookupError:
            return self.proc.poll()
        code = self.wait(timeout)
        if code is None:
            self._killed_hard = True
            self.proc.kill()
            code = self.wait(2.0)
        return code

    @property
    def killed_hard(self) -> bool:
        return self._killed_hard

    def stdout_text(self) -> str:
        return "\n".join(self.stdout_lines)

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_lines)


def no_stray_ghostkeysd(match: str = str(BINARY_PATH), exclude_pids: "set[int] | None" = None) -> list[str]:
    """Returns a list of description strings for any running process whose
    command line contains `match` and is not in exclude_pids (best-effort, via
    `ps`). Defaults to matching our own built binary's exact path, so this never
    flags another agent's/tool's unrelated ghostkeysd build in this same repo
    (e.g. a sibling .build-lead or .build directory)."""
    exclude_pids = exclude_pids or set()
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=5).stdout
    except Exception as e:  # pragma: no cover - best effort only
        return [f"could not run ps to verify: {e}"]
    strays = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pid_str, command = line.split(None, 1)
            pid = int(pid_str)
        except ValueError:
            continue
        if match in command and pid not in exclude_pids:
            strays.append(f"pid {pid}: {command}")
    return strays


def motion_sensor_report_intervals() -> str:
    """Best-effort snapshot of AppleSPUHIDDriver ReportInterval values, the same
    check the task brief asks us to use to confirm the motion sensor is idle
    after the suite finishes."""
    try:
        out = subprocess.run(
            ["ioreg", "-r", "-c", "AppleSPUHIDDriver", "-l"], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception as e:  # pragma: no cover
        return f"(could not run ioreg: {e})"
    lines = [l.strip() for l in out.splitlines() if "ReportInterval" in l]
    return "\n".join(lines) if lines else "(no AppleSPUHIDDriver ReportInterval lines found)"


def frontmost_app_name() -> Optional[str]:
    """The current frontmost app's display name, via `lsappinfo` (no
    Accessibility/Automation permission needed, unlike an AppleScript
    `System Events` query). Used to gate the Finder-quit dry-run guard test,
    which only means something when Finder actually is frontmost -- this suite
    never changes focus to force that."""
    try:
        asn = subprocess.run(["lsappinfo", "front"], capture_output=True, text=True, timeout=3).stdout.strip()
        if not asn:
            return None
        out = subprocess.run(["lsappinfo", "info", "-only", "name", asn], capture_output=True, text=True,
                              timeout=3).stdout
        if "=" in out:
            return out.split("=", 1)[1].strip().strip('"')
    except Exception:
        return None
    return None


def run_restore_sensors(binary: Path, config_dir: Path, attempts: int = 5, delay: float = 1.0,
                         timeout: float = 10.0):
    """Runs `ghostkeysd --config-dir <config_dir> --restore-sensors`
    (App/Options.swift), retrying if that config dir's single-instance lock is
    transiently still held (e.g. the daemon we just SIGKILLed hasn't been fully
    reaped yet). Returns the finished subprocess.CompletedProcess, or raises
    TimeoutError if the lock never frees up within the retry budget."""
    last: Optional[subprocess.CompletedProcess] = None
    for _ in range(attempts):
        last = subprocess.run([str(binary), "--config-dir", str(config_dir), "--restore-sensors"],
                               capture_output=True, text=True, timeout=timeout)
        if last.returncode != 4 or "already running" not in last.stderr:
            return last
        time.sleep(delay)
    raise TimeoutError(f"could not run --restore-sensors; lock held the whole time: {last.stderr if last else '?'}")
