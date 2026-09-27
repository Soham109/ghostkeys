"""Process plumbing for the stress suite. Self-contained: this suite owns only
tests/stress/**, builds its own daemon into daemon/.build-stress (never touches
.build, .build-e2e, or any other agent's scratch dir), and every instance gets
its own --config-dir under the caller-supplied directory (normally somewhere
under the scratchpad, never ~/Library/Application Support/Ghostkeys).

Every daemon is launched with --simulate-sensors --no-hardware-sessions
--dry-run --config-dir <tmp>, on a port in 47970-47979, per the overnight
safety rules. This module never starts a daemon without --simulate-sensors.
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

REPO_ROOT = Path(__file__).resolve().parents[3]
DAEMON_DIR = REPO_ROOT / "daemon"
SCRATCH_PATH = DAEMON_DIR / ".build-stress"
BINARY_PATH = SCRATCH_PATH / "debug" / "ghostkeysd"

STRESS_PORTS = range(47970, 47980)

MANDATORY_ARGS = ["--simulate-sensors", "--no-hardware-sessions", "--dry-run"]


class BuildError(RuntimeError):
    pass


def build_daemon(timeout: float = 600.0) -> Path:
    cmd = ["nice", "-n", "10", "swift", "build", "--scratch-path", str(SCRATCH_PATH), "--product", "ghostkeysd"]
    proc = subprocess.run(cmd, cwd=str(DAEMON_DIR), capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise BuildError(f"swift build failed (exit {proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
    if not BINARY_PATH.exists():
        raise BuildError(f"build reported success but {BINARY_PATH} is missing")
    return BINARY_PATH


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        try:
            s.connect((host, port))
            return False
        except OSError:
            return True


def assert_stress_port(port: int) -> None:
    if port not in STRESS_PORTS:
        raise ValueError(f"port {port} is outside the overnight-safety range 47970-47979")


class DaemonProcess:
    """One ghostkeysd subprocess, always simulate-sensors + no-hardware-sessions
    + dry-run, always on a port in 47970-47979, always given its own throwaway
    --config-dir."""

    def __init__(self, binary: Path, config_dir: Path, port: int, extra_args: Optional[list[str]] = None,
                 verbose: bool = True, parent_pid: Optional[int] = None):
        assert_stress_port(port)
        self.binary = str(binary)
        self.config_dir = Path(config_dir)
        self.config_dir.mkdir(parents=True, exist_ok=True)
        self.port = port
        self.verbose = verbose
        self.extra_args = extra_args or []
        self.parent_pid = parent_pid or os.getpid()
        self.proc: Optional[subprocess.Popen] = None
        self.stdout_lines: "collections.deque[str]" = collections.deque(maxlen=20000)
        self.stderr_lines: "collections.deque[str]" = collections.deque(maxlen=20000)
        self._threads: list[threading.Thread] = []
        self._killed_hard = False
        self._token: Optional[str] = None
        self.start_count = 0
        self.crash_count = 0

    @property
    def token(self) -> str:
        if self._token is None:
            token_path = self.config_dir / "token"
            deadline = time.time() + 5.0
            last_err = None
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
        a += MANDATORY_ARGS
        if self.verbose:
            a.append("--verbose")
        a += self.extra_args
        return a

    def start(self, wait_ready: float = 8.0) -> None:
        self._token = None
        self.start_count += 1
        self.proc = subprocess.Popen(
            self.args(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._killed_hard = False
        for stream, sink in ((self.proc.stdout, self.stdout_lines), (self.proc.stderr, self.stderr_lines)):
            t = threading.Thread(target=self._pump, args=(stream, sink), daemon=True)
            t.start()
            self._threads.append(t)
        self._wait_for_port(wait_ready)

    def _wait_for_port(self, timeout: float) -> None:
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
                    f"daemon exited early with code {rc} before opening its port.\nargs: {self.args()}\n"
                    f"stderr:\n" + "\n".join(self.stderr_lines)
                )
            time.sleep(0.02)
        raise TimeoutError(f"daemon did not log '{needle}' within {timeout}s\nstderr:\n" + "\n".join(self.stderr_lines))

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

    def sigkill_now(self) -> None:
        """Hard kill with no grace period, for chaos testing."""
        if self.proc is None or self.proc.poll() is not None:
            return
        try:
            self.proc.kill()  # SIGKILL
        except ProcessLookupError:
            pass
        self.wait(3.0)

    @property
    def killed_hard(self) -> bool:
        return self._killed_hard

    def stdout_text(self) -> str:
        return "\n".join(self.stdout_lines)

    def stderr_text(self) -> str:
        return "\n".join(self.stderr_lines)


def ps_sample(pid: int):
    """Returns (cpu_pct, rss_kb) or None if the process is gone."""
    out = subprocess.run(["ps", "-o", "%cpu=,rss=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    if not out:
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    return float(parts[0]), float(parts[1])


def fd_count(pid: int) -> Optional[int]:
    try:
        out = subprocess.run(["lsof", "-a", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=5).stdout
        if not out:
            return None
        return sum(1 for line in out.splitlines() if line.startswith("f"))
    except Exception:
        return None


def thread_count(pid: int) -> Optional[int]:
    try:
        out = subprocess.run(["ps", "-M", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        lines = [l for l in out.splitlines() if l.strip()]
        return max(0, len(lines) - 1)
    except Exception:
        return None


def kill_stray_ghostkeysd_stress(exclude_pids: Optional[set] = None) -> list[str]:
    """Kills (SIGKILL) any process whose command line contains our exact
    stress-build binary path and is not in exclude_pids. Only ever matches our
    own .build-stress binary, never another agent's build."""
    exclude_pids = exclude_pids or set()
    killed = []
    try:
        out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return killed
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pid_str, command = line.split(None, 1)
            pid = int(pid_str)
        except ValueError:
            continue
        if str(BINARY_PATH) in command and pid not in exclude_pids:
            try:
                os.kill(pid, signal.SIGKILL)
                killed.append(f"pid {pid}: {command}")
            except ProcessLookupError:
                pass
    return killed
