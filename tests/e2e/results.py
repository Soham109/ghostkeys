"""Process-wide scratch space so individual tests can hand numeric findings
(measured rates, latencies, soak numbers) to the REPORT.md generator in
conftest.py without a database or file-based IPC. Import and mutate directly;
pytest runs this suite single-process/single-threaded (no xdist) so a plain
module-level dict is safe.
"""
from __future__ import annotations

DATA: dict[str, object] = {}
NOTES: list[str] = []


def record(key: str, value: object) -> None:
    DATA[key] = value


def note(text: str) -> None:
    NOTES.append(text)
