"""Shared append-only findings + metrics sink for the stress suite. Each
script writes its own JSON file under the run directory; STRESS_FINDINGS.md is
assembled from all of them at the end (see tests/stress/build_report.py)."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any


class Sink:
    def __init__(self, path: Path, name: str):
        self.path = Path(path)
        self.name = name
        self.lock = threading.Lock()
        self.data: dict[str, Any] = {"name": name, "started": time.strftime("%Y-%m-%d %H:%M:%S %z"),
                                     "findings": [], "metrics": {}, "notes": [], "samples": []}
        self._flush()

    def finding(self, severity: str, title: str, repro: str, detail: str = ""):
        with self.lock:
            self.data["findings"].append({
                "severity": severity, "title": title, "repro": repro, "detail": detail,
                "t": time.strftime("%Y-%m-%d %H:%M:%S %z"),
            })
            self._flush()

    def metric(self, key: str, value: Any):
        with self.lock:
            self.data["metrics"][key] = value
            self._flush()

    def note(self, text: str):
        with self.lock:
            self.data["notes"].append(text)
            self._flush()

    def sample(self, row: dict):
        with self.lock:
            self.data["samples"].append(row)
            self._flush()

    def finish(self, status: str = "completed"):
        with self.lock:
            self.data["finished"] = time.strftime("%Y-%m-%d %H:%M:%S %z")
            self.data["status"] = status
            self._flush()

    def _flush(self):
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(self.data, indent=2, default=str))
        tmp.replace(self.path)
