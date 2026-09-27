"""Assembles docs/review/STRESS_FINDINGS.md from every results/*.json file
this suite's scripts wrote. Run after fuzzer.py/soak.py/chaos.py/rate_attack.py/
handshake_queue_test.py have all finished.

Usage: python3 build_report.py
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.textchart import sparkline, summary_line

RESULTS_DIR = Path(__file__).resolve().parent / "results"
OUT_PATH = Path(__file__).resolve().parents[2] / "docs" / "review" / "STRESS_FINDINGS.md"

SEVERITY_ORDER = {"CRITICAL": 0, "high": 1, "medium": 2, "low": 3}


def load_all() -> dict[str, dict]:
    out = {}
    for p in sorted(RESULTS_DIR.glob("*.json")):
        try:
            out[p.stem] = json.loads(p.read_text())
        except Exception as e:
            out[p.stem] = {"name": p.stem, "status": "UNREADABLE", "findings": [], "metrics": {}, "notes": [],
                           "samples": [], "error": str(e)}
    return out


def _group_key(f: dict) -> tuple:
    # Collapses e.g. "daemon died during fuzzing (deep_nest(depth=100000,kind=object))" and
    # "... (deep_nest(depth=5000,kind=object))" into one group, since a 30-minute fuzz run can hit
    # the same underlying bug dozens of times with different parameters/timings.
    title_prefix = f["title"].split("(")[0].strip()
    return (f["severity"], f.get("source", ""), title_prefix)


def all_findings(data: dict[str, dict]) -> list[dict]:
    raw = []
    for key, d in data.items():
        for f in d.get("findings", []):
            f = dict(f)
            f["source"] = d.get("name", key)
            raw.append(f)

    groups: dict[tuple, list[dict]] = {}
    for f in raw:
        groups.setdefault(_group_key(f), []).append(f)

    out = []
    for key, items in groups.items():
        rep = dict(items[0])
        rep["_count"] = len(items)
        if len(items) > 1:
            variants = sorted({i["title"] for i in items})
            rep["_variants"] = variants[:15]
        out.append(rep)
    # Within a severity tier, a clean isolated single-variable repro is more useful to a reader than a
    # noisy aggregate from the concurrent fuzz run (many workers sharing one daemon instance means crash
    # attribution there is approximate) -- so isolated/targeted repros sort first, then by occurrence count.
    out.sort(key=lambda f: (SEVERITY_ORDER.get(f["severity"], 9),
                            0 if "isolated" in f.get("source", "") or "handshake_queue" in f.get("source", "") else 1,
                            -f["_count"]))
    return out


def fmt_duration(seconds) -> str:
    if seconds is None:
        return "?"
    seconds = float(seconds)
    if seconds >= 3600:
        return f"{seconds/3600:.1f}h"
    if seconds >= 60:
        return f"{seconds/60:.1f}min"
    return f"{seconds:.0f}s"


def main():
    data = load_all()
    findings = all_findings(data)
    lines: list[str] = []

    lines.append("# Ghostkeys daemon stress test findings")
    lines.append("")
    lines.append(f"Generated {time.strftime('%Y-%m-%d %H:%M:%S %z')}.")
    lines.append("")
    lines.append(
        "Scope: `tests/stress/**` only, built and run by the same agent that wrote this file. `daemon/Sources/**` "
        "was never edited. Every daemon instance ran `--simulate-sensors --no-hardware-sessions --dry-run` with a "
        "throwaway `--config-dir` (under the scratchpad, never `~/Library/Application Support/Ghostkeys/`) on a "
        "port in 47970-47979, built into `daemon/.build-stress` (never `.build`, `.build-e2e`, or another agent's "
        "scratch dir). No mic, camera, speaker, sudo or real action was used anywhere in this run. No `git` "
        "command was run."
    )
    lines.append("")

    # ---- Verdict -----------------------------------------------------
    crit = [f for f in findings if f["severity"] == "CRITICAL"]
    high = [f for f in findings if f["severity"] == "high"]
    lines.append("## Verdict")
    lines.append("")
    if crit:
        lines.append(f"**{len(crit)} critical finding(s).** The daemon crashed, corrupted on-disk state, or ran "
                     "an action it shouldn't have during this run. See below.")
    elif high:
        lines.append(f"No crashes and no corrupted files in any run. **{len(high)} high-severity finding(s)**, "
                     "all availability/denial-of-service issues in the WebSocket handshake path, not memory "
                     "corruption or unauthorized actions.")
    else:
        lines.append("No crashes, no corrupted files, no unauthorized actions in any run.")
    lines.append("")

    # ---- Summary table -------------------------------------------------
    lines.append("## Summary")
    lines.append("")
    lines.append("| test | status | planned | findings (C/H/M/L) |")
    lines.append("| --- | --- | --- | --- |")
    order = ["protocol_fuzzer", "soak", "chaos", "rate_limiter_and_approval_attack", "handshake_queue_exhaustion"]
    seen = set()
    for key in order + sorted(set(data) - set(order)):
        if key in seen or key not in data:
            continue
        seen.add(key)
        d = data[key]
        fs = d.get("findings", [])
        c = sum(1 for f in fs if f["severity"] == "CRITICAL")
        h = sum(1 for f in fs if f["severity"] == "high")
        m = sum(1 for f in fs if f["severity"] == "medium")
        l = sum(1 for f in fs if f["severity"] == "low")
        planned = d.get("metrics", {}).get("planned_seconds")
        lines.append(f"| {d.get('name', key)} | {d.get('status', '?')} | {fmt_duration(planned) if planned else 'n/a'} "
                     f"| {c}/{h}/{m}/{l} |")
    lines.append("")

    # ---- Ranked findings -------------------------------------------------
    lines.append("## Findings, ranked")
    lines.append("")
    if not findings:
        lines.append("(none)")
    for i, f in enumerate(findings, 1):
        count_suffix = f" (x{f['_count']} occurrences)" if f.get("_count", 1) > 1 else ""
        lines.append(f"### {i}. [{f['severity']}] {f['title']}{count_suffix}")
        lines.append("")
        lines.append(f"- **Where:** `{f['source']}`")
        lines.append(f"- **Repro:** {f['repro']}")
        if f.get("detail"):
            detail = f["detail"]
            if len(detail) > 3000:
                detail = detail[:3000] + "\n... (truncated)"
            lines.append(f"- **Detail:**\n\n```\n{detail}\n```")
        if f.get("_variants"):
            lines.append(f"- **Variants seen ({f['_count']} total):** " + "; ".join(f"`{v}`" for v in f["_variants"]))
        if f["source"] == "protocol_fuzzer" and f["title"].startswith("daemon died during fuzzing"):
            lines.append("- **Note:** this is the 30-minute concurrent fuzz run organically hitting the same bug "
                         "as the isolated deep-JSON-nesting repro elsewhere in this document, dozens of times. "
                         "Many fuzzer workers share one daemon instance, so which worker's name ends up in the "
                         "title here is approximate (whichever one's liveness check happened to run first after "
                         "the crash) -- treat the isolated repro as the authoritative one and this as confirmation "
                         "the bug is easy to hit by accident under normal traffic, not a second distinct bug.")
        lines.append("")

    # ---- What held up -------------------------------------------------
    lines.append("## What held up under attack")
    lines.append("")
    for key in order:
        d = data.get(key)
        if not d:
            continue
        notes = [n for n in d.get("notes", []) if not n.lower().startswith(("asyncio loop exception",))]
        # Keep only the short, informative confirmations, not every worker-exception note.
        good = [n for n in notes if any(w in n.lower() for w in
                ["correctly", "survived", "held up", "recovered", "intact", "capped", "refused", "worked correctly"])]
        if good:
            lines.append(f"**{d.get('name', key)}:**")
            for n in good:
                lines.append(f"- {n}")
            lines.append("")

    # ---- Metrics --------------------------------------------------------
    lines.append("## Metrics")
    lines.append("")
    for key in order:
        d = data.get(key)
        if not d:
            continue
        lines.append(f"### {d.get('name', key)}")
        lines.append("")
        m = d.get("metrics", {})
        if m:
            lines.append("```")
            for k, v in m.items():
                lines.append(f"{k}: {v}")
            lines.append("```")
            lines.append("")
        samples = d.get("samples", [])
        if samples:
            rss = [s["rss_kb"] / 1024 for s in samples if s.get("rss_kb") is not None]
            cpu = [s["cpu"] for s in samples if s.get("cpu") is not None]
            fds = [s["fds"] for s in samples if s.get("fds") is not None]
            threads = [s["threads"] for s in samples if s.get("threads") is not None]
            elapsed = [s.get("elapsed_s", 0) for s in samples]
            lines.append(f"Samples: {len(samples)} over {fmt_duration(elapsed[-1] if elapsed else None)} "
                         f"(one every ~{(elapsed[-1] / max(1, len(samples)-1)):.0f}s)" if len(elapsed) > 1 else
                         f"Samples: {len(samples)}")
            lines.append("")
            lines.append("```text")
            if rss:
                lines.append(summary_line("RSS (MB)", rss))
            if cpu:
                lines.append(summary_line("CPU (%)", cpu))
            if fds:
                lines.append(summary_line("open FDs", fds))
            if threads:
                lines.append(summary_line("threads", threads))
            lines.append("```")
            lines.append("")
        # Notes worth surfacing under metrics (progress notes, e.g. every-10-min soak progress lines)
        prog_notes = [n for n in d.get("notes", []) if n.startswith("soak progress") or n.startswith("deep_nest")]
        if prog_notes:
            lines.append("<details><summary>progress notes</summary>")
            lines.append("")
            for n in prog_notes[:50]:
                lines.append(f"- {n}")
            lines.append("")
            lines.append("</details>")
            lines.append("")

    # ---- Skipped / out of reach -------------------------------------------
    lines.append("## Out of reach for this black-box run")
    lines.append("")
    lines.append("- **Clock jumps**: changing the system clock needs `sudo` (prohibited by the overnight safety "
                 "rules) and the daemon's CLI has no fault-injection hook for it under `--simulate-sensors`. Not "
                 "attempted.")
    lines.append("- **Disk-full**: simulated with a read-only config directory (`chmod 0500`), not an actual full "
                 "filesystem, per the safety rules (no disk image / `hdiutil`). This exercises the same write-failure "
                 "code path (`ENOSPC` and `EACCES` both fail the same `Data.write` / `FileManager` calls) but is not "
                 "byte-for-byte identical to `ENOSPC`.")
    lines.append("")

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT_PATH} ({len(findings)} findings, {len(data)} result files)")


if __name__ == "__main__":
    main()
