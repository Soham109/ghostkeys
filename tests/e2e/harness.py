"""Process and filesystem plumbing for the ghostkeysd e2e suite.

Ownership note: this whole tests/e2e/ tree is the only part of the ghostkeys repo we
own. We never touch daemon/Sources/**. This module only builds the daemon (an
isolated SwiftPM scratch dir) and launches/stops it as a subprocess.

Safety notes (see docs/PROTOCOL.md and the task brief):
- The daemon is only ever started with --dry-run so no action it runs actually
  executes (see FINDINGS.md #1 for a caveat about what --dry-run does *not* cover).
- We always pass --parent-pid <this pytest process> so a crashed test runner still
  makes the daemon exit and restore its sensor driver settings.
- There is no --config-dir flag (checked App/Options.swift; see FINDINGS.md #2), so
  we back up ~/Library/Application Support/Ghostkeys byte-for-byte before the
  session and restore it byte-for-byte after, regardless of how the session ends.
- We only ever signal/kill processes this module started.
"""
from __future__ import annotations

import collections
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[2]
DAEMON_DIR = REPO_ROOT / "daemon"
SCRATCH_PATH = DAEMON_DIR / ".build-e2e"
BINARY_PATH = SCRATCH_PATH / "debug" / "ghostkeysd"

DEFAULT_PORT = 47823
CONFIG_DIR = Path.home() / "Library" / "Application Support" / "Ghostkeys"


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
    """Starts `d`, retrying if the single-instance lock or the port is
    transiently held by *someone else's* ghostkeysd. There is no --config-dir
    flag (FINDINGS.md #2), so the lock file and config dir are shared with
    anything else on this machine that runs the daemon; a colliding instance
    started outside this suite is not ours to kill, so we just wait our turn
    for up to `total_budget` seconds before giving up.
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
    """One ghostkeysd subprocess. Always dry-run. Captures stdout/stderr so tests
    can assert on log lines (e.g. the sensor-restore message) without risking a
    pipe deadlock."""

    def __init__(self, binary: Path, port: int = DEFAULT_PORT, dry_run: bool = True,
                 verbose: bool = True, extra_args: Optional[list[str]] = None,
                 parent_pid: Optional[int] = None, token: Optional[str] = None):
        self.binary = str(binary)
        self.port = port
        self.dry_run = dry_run
        self.verbose = verbose
        self.extra_args = extra_args or []
        self.parent_pid = parent_pid or os.getpid()
        # Server/WebSocketServer.swift now requires a handshake header
        # X-Ghostkeys-Token matching either the per-launch token file it writes
        # to the (shared) config dir, or a GHOSTKEYS_TOKEN env var of at least 32
        # characters (Security/SessionToken.swift). We supply our own via the
        # environment so tests never need to read the token file (which lives in
        # the same shared, unisolated config dir as everything else -- see
        # FINDINGS.md #2) and so each daemon instance gets an independent secret.
        self.token = token or secrets.token_hex(32)
        self.proc: Optional[subprocess.Popen] = None
        self.stdout_lines: "collections.deque[str]" = collections.deque(maxlen=10000)
        self.stderr_lines: "collections.deque[str]" = collections.deque(maxlen=10000)
        self._threads: list[threading.Thread] = []
        self._killed_hard = False

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
        a = [self.binary, "--port", str(self.port), "--parent-pid", str(self.parent_pid)]
        if self.dry_run:
            a.append("--dry-run")
        if self.verbose:
            a.append("--verbose")
        a += self.extra_args
        return a

    def start(self, wait_ready: float = 8.0) -> None:
        env = dict(os.environ)
        env["GHOSTKEYS_TOKEN"] = self.token
        self.proc = subprocess.Popen(
            self.args(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env=env,
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


class ConfigSandbox:
    """Backs up and restores only the specific files/directories ghostkeysd
    itself owns inside ~/Library/Application Support/Ghostkeys/, byte-for-byte,
    however the session ends (normal, exception, or the atexit backstop in
    conftest.py).

    IMPORTANT: that directory is NOT exclusive to the daemon. Partway through
    this session it was found to also hold a full Electron userData profile
    (Cache, GPUCache, Session Storage, Local Storage, Preferences, Cookies,
    blob_storage, ...) -- almost certainly from the real Ghostkeys.app, whose
    default Electron userData path collides with the daemon's hardcoded config
    directory name (see FINDINGS.md #7). An earlier version of this class
    backed up and wiped the *entire* directory, which would delete that
    profile's live data (or worse, interfere with a concurrently running
    Ghostkeys.app) on every single test. This version only ever touches the
    exact paths ghostkeysd itself reads or writes:
      - config.json, config.json.bak, config.json.bad (Config/ConfigStore.swift)
      - daemon.lock (App/Lifetime.swift InstanceLock)
      - token (Security/SessionToken.swift)
      - approved.json (Security/ApprovalStore.swift)
      - spu-originals.json (Sensors/SPUDriverControl.swift)
      - model/ (Config/ConfigStore.swift modelDirectory: zone-model.json,
        calibration-report.json, samples.json, and their .bak files)
    Everything else in that directory, however large, is left completely alone.
    """

    OWNED_FILES = ("config.json", "config.json.bak", "config.json.bad", "daemon.lock",
                   "token", "approved.json", "spu-originals.json")
    OWNED_DIRS = ("model",)

    def __init__(self, real_dir: Path = CONFIG_DIR):
        self.real_dir = real_dir
        self.backup_root: Optional[Path] = None
        self._done = False

    def _owned_paths(self):
        for name in self.OWNED_FILES:
            yield self.real_dir / name, False
        for name in self.OWNED_DIRS:
            yield self.real_dir / name, True

    def _remove_owned(self) -> None:
        for path, is_dir in self._owned_paths():
            if not path.exists():
                continue
            if is_dir:
                shutil.rmtree(path)
            else:
                path.unlink()

    def snapshot_and_clear(self) -> None:
        self.backup_root = Path(tempfile.mkdtemp(prefix="ghostkeys-e2e-backup-"))
        for path, is_dir in self._owned_paths():
            if not path.exists():
                continue
            dest = self.backup_root / path.name
            if is_dir:
                shutil.copytree(path, dest, symlinks=True)
                shutil.rmtree(path)
            else:
                shutil.copy2(path, dest)
                path.unlink()
        self._done = True

    def restore(self) -> None:
        if not self._done:
            return
        self._remove_owned()
        if self.backup_root is not None:
            for path, is_dir in self._owned_paths():
                src = self.backup_root / path.name
                if not src.exists():
                    continue
                if is_dir:
                    shutil.copytree(src, path, symlinks=True)
                else:
                    self.real_dir.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, path)
            shutil.rmtree(self.backup_root, ignore_errors=True)
        self._done = False

    def reset_between_tests(self) -> None:
        """Removes only ghostkeysd's own files/dirs so the next test starts from
        Config.defaults again (it recreates config.json on load if missing),
        without touching anything else that happens to live alongside them."""
        self._remove_owned()


def run_restore_sensors(binary: Path, attempts: int = 5, delay: float = 1.0, timeout: float = 10.0):
    """Runs `ghostkeysd --restore-sensors` (App/Options.swift), retrying if the
    shared single-instance lock is transiently held by another instance (ours or
    someone else's -- see start_resilient). Returns the finished
    subprocess.CompletedProcess, or raises TimeoutError if the lock never frees
    up within the retry budget."""
    last: Optional[subprocess.CompletedProcess] = None
    for _ in range(attempts):
        last = subprocess.run([str(binary), "--restore-sensors"], capture_output=True, text=True, timeout=timeout)
        if last.returncode != 4 or "already running" not in last.stderr:
            return last
        time.sleep(delay)
    raise TimeoutError(f"could not run --restore-sensors; lock held the whole time: {last.stderr if last else '?'}")
