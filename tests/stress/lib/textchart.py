"""Tiny ASCII sparkline/bar helpers for putting metrics charts as text into
docs/review/STRESS_FINDINGS.md (no plotting library, no image files)."""
from __future__ import annotations

BLOCKS = " ▁▂▃▄▅▆▇█"


def sparkline(values: list[float], width: int | None = None) -> str:
    if not values:
        return "(no samples)"
    vs = values if width is None or len(values) <= width else _resample(values, width)
    lo, hi = min(vs), max(vs)
    if hi - lo < 1e-9:
        return BLOCKS[4] * len(vs)
    out = []
    for v in vs:
        idx = int((v - lo) / (hi - lo) * (len(BLOCKS) - 1))
        out.append(BLOCKS[idx])
    return "".join(out)


def _resample(values: list[float], width: int) -> list[float]:
    n = len(values)
    out = []
    for i in range(width):
        lo = i * n // width
        hi = max(lo + 1, (i + 1) * n // width)
        chunk = values[lo:hi]
        out.append(sum(chunk) / len(chunk))
    return out


def summary_line(label: str, values: list[float], unit: str = "") -> str:
    if not values:
        return f"{label}: (no samples)"
    return (f"{label}: min {min(values):.1f}{unit}  max {max(values):.1f}{unit}  "
           f"first {values[0]:.1f}{unit}  last {values[-1]:.1f}{unit}  "
           f"[{sparkline(values, width=60)}]")
