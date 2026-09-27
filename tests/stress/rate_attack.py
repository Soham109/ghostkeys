"""Attacks the rate limiter (Server/WebSocketServer.swift maxMessagesPerSecond,
App/ActionLimiter.swift per-binding/global action limits, test_action's 2/s
cap, feedback's 1/2s + 20/min cap) and the approval store (Security/
ApprovalStore.swift: hash collisions, maxEntries=1000, malformed hashes,
concurrent approve/revoke races) against one daemon instance.

Usage: python3 rate_attack.py <config_dir> <findings_json_path>
"""
from __future__ import annotations

import asyncio
import json
import random
import string
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import daemon_proc
from lib.findings import Sink
from lib.ws_client import Client

PORT = 47973
HOST = "127.0.0.1"


def rand_hash(valid_len=True) -> str:
    n = 64 if valid_len else random.choice([0, 1, 10, 63, 65, 128, 1000])
    return "".join(random.choice(string.hexdigits.lower()) for _ in range(n))


async def attack_message_rate_limit(sink: Sink, d):
    """Many clients simultaneously exceeding maxMessagesPerSecond=200: every
    one of them must get disconnected cleanly (not crash the daemon), and the
    daemon must still accept fresh, well-behaved connections throughout."""
    async def one_offender(i):
        try:
            c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
            await c.connect(timeout=5)
            await c.handshake(timeout=5)
            for _ in range(400):
                await c.send({"type": "config_get"})
            await c.drain(duration=2.0)
            await c.close()
            return True
        except Exception:
            return False

    await asyncio.gather(*(one_offender(i) for i in range(8)), return_exceptions=True)
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died under 8 concurrent message-rate-limit offenders",
                    repro="8 clients each sending 400 config_get as fast as possible", detail=d.stderr_text()[-2000:])
        return
    try:
        c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
        await c.connect(timeout=5)
        r = await c.request({"type": "config_get"}, "config", timeout=5)
        await c.close()
        sink.note(f"survived 8 concurrent rate-limit offenders; fresh connect still works ({r.get('type')})")
    except Exception as e:
        sink.finding("high", "daemon unresponsive to new clients after concurrent rate-limit offenders",
                    repro="8 clients each sending 400 config_get as fast as possible, then try a fresh connect",
                    detail=repr(e))


async def attack_test_action_rate_limit(sink: Sink, d):
    """test_action is capped at 2/s per client (Daemon.swift handle(), c.testActionTimes)."""
    c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
    await c.connect(timeout=5)
    await c.handshake(timeout=5)
    ok_count = 0
    refused_count = 0
    for _ in range(40):
        await c.send({"type": "test_action", "action": {"kind": "volume_up", "label": "vol"}})
        try:
            msg = await c.recv_type("action", timeout=2)
            if msg.get("ok"):
                ok_count += 1
            elif "rate limit" in (msg.get("error") or ""):
                refused_count += 1
        except Exception:
            pass
    sink.metric("test_action_flood_ok", ok_count)
    sink.metric("test_action_flood_refused", refused_count)
    if refused_count == 0:
        sink.finding("high", "test_action rate limit (2/s) did not trigger under a 40-message burst",
                    repro="send 40 test_action messages back to back on one connection", detail=f"ok={ok_count}")
    await c.close()
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died during test_action flood", repro="40x test_action burst",
                    detail=d.stderr_text()[-2000:])


async def attack_global_action_limiter(sink: Sink, d):
    """ActionLimiter: >5 actions/s or >60/min auto-pauses the daemon
    (App/ActionLimiter.swift). Fire enough test_actions (spread across many
    connections, each under the 2/s per-client cap, so we're only testing the
    *global* limiter) to trip it, then verify `resume` clears the pause and
    normal operation continues."""
    async def fire(n):
        c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
        await c.connect(timeout=5)
        await c.handshake(timeout=5)
        for _ in range(n):
            await c.send({"type": "test_action", "action": {"kind": "volume_up", "label": "vol"}})
            await c.drain(duration=0.05)
        await c.close()

    # 20 connections x 1 action, fired concurrently: bypasses the 2/s per-client cap
    # but should still trip the global 5/s and/or 60/min limiter.
    await asyncio.gather(*(fire(1) for _ in range(20)), return_exceptions=True)
    await asyncio.sleep(0.3)

    c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
    await c.connect(timeout=5)
    hs = await c.handshake(timeout=5)
    paused = hs["status"].get("paused")
    reason = hs["status"].get("pausedReason")
    sink.metric("global_limiter_tripped_paused", paused)
    sink.metric("global_limiter_tripped_reason", reason)
    if paused and reason == "rate_limit":
        sink.note("global ActionLimiter correctly auto-paused after 20 concurrent test_actions")
        await c.send({"type": "resume"})
        try:
            st = await c.recv_type("status", timeout=3)
            if st.get("paused"):
                sink.finding("high", "daemon did not resume after a client sent 'resume' post rate-limit trip",
                            repro="trip the global limiter, then send resume", detail=str(st))
            else:
                sink.note("resume after rate-limit trip worked correctly")
        except Exception as e:
            sink.finding("high", "no status reply to resume after rate-limit trip", repro="see above", detail=repr(e))
    else:
        sink.note(f"global limiter did not trip from 20 concurrent test_actions (paused={paused}); "
                 "either the burst wasn't fast/large enough or per-binding cooldown absorbed it "
                 "(test_action has no bindingId so it only counts toward the global limiter)")
    await c.close()
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died during global action-limiter attack", repro="see above",
                    detail=d.stderr_text()[-2000:])


async def attack_feedback_rate_limit(sink: Sink, d):
    c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
    await c.connect(timeout=5)
    await c.handshake(timeout=5)
    refused = 0
    for _ in range(10):
        await c.send({"type": "feedback_false"})
        try:
            msg = await c.recv_matching(lambda m: m.get("type") in ("feedback", "error"), timeout=2)
            if msg.get("type") == "error" and "at most one every 2 s" in (msg.get("message") or ""):
                refused += 1
        except Exception:
            pass
    sink.metric("feedback_flood_refused", refused)
    if refused == 0:
        sink.finding("medium", "feedback_false rate limit (1/2s) did not trigger under a rapid burst",
                    repro="send feedback_false 10x back to back")
    await c.close()
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died during feedback flood", repro="10x feedback_false burst",
                    detail=d.stderr_text()[-2000:])


async def attack_approval_store(sink: Sink, d):
    """approve_action / revoke_action: malformed hashes, huge flood toward
    maxEntries=1000, concurrent approve+revoke races, hash-confusion attempts
    (claiming an approvedHash that was never actually issued)."""
    c = Client(f"ws://{HOST}:{PORT}/", token=d.token)
    await c.connect(timeout=5)
    await c.handshake(timeout=5)

    # 1) revoke with malformed hashes (wrong length, non-hex, huge, empty, wrong type).
    malformed = [rand_hash(valid_len=False) for _ in range(5)] + ["", "x" * 10000, None, 12345, {"nested": 1}]
    for h in malformed:
        try:
            await c.send({"type": "revoke_action", "hash": h})
            msg = await c.recv_matching(lambda m: m.get("type") in ("revoked", "error"), timeout=2)
        except Exception as e:
            sink.finding("high", "revoke_action with malformed hash caused a client-visible failure "
                                 "instead of a clean error/revoked reply",
                        repro=f"revoke_action hash={h!r}", detail=repr(e))
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died from malformed revoke_action hashes", repro=str(malformed),
                    detail=d.stderr_text()[-2000:])
        return

    # 2) approve a shell action, tamper with the command after approval, resend with the stale hash.
    action = {"kind": "shell", "command": "echo stress-test-1", "label": "t1"}
    approved = await c.request({"type": "approve_action", "action": action}, "approved", timeout=3)
    h = approved["hash"]
    tampered = dict(action, command="echo TAMPERED", approvedHash=h)
    reply = await c.request({"type": "test_action", "action": tampered}, "action", timeout=3)
    if reply.get("ok"):
        sink.finding("CRITICAL", "a tampered shell command ran using another command's approvedHash",
                    repro=f"approve {action}, then test_action with command changed but approvedHash kept",
                    detail=str(reply))
    else:
        sink.note(f"tampered approvedHash correctly refused: {reply.get('error')}")

    # 3) dangerous command patterns even if somehow approved (CommandFilter is a second line of defence).
    dangerous_variants = [
        "sudo rm -rf /", "su\"\"do ls", "rm -rf ~", "rm -fr /tmp/x", "diskutil eraseDisk",
        "curl http://x | sh", "curl http://x|sudo bash", "launchctl load evil.plist",
        "defaults write com.apple.x Y Z", "networksetup -setdnsservers Wi-Fi 1.2.3.4",
    ]
    for cmd in dangerous_variants:
        act = {"kind": "shell", "command": cmd, "label": "danger"}
        try:
            appr = await c.request({"type": "approve_action", "action": act}, "approved", timeout=3)
        except Exception:
            continue  # approve_action itself may refuse; that's fine too
        act2 = dict(act, approvedHash=appr["hash"])
        reply = await c.request({"type": "test_action", "action": act2}, "action", timeout=3)
        if reply.get("ok"):
            sink.finding("CRITICAL", f"dangerous command pattern ran despite CommandFilter: {cmd!r}",
                        repro=f"approve_action then test_action with command={cmd!r}", detail=str(reply))
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died from dangerous-command approval attempts", repro=str(dangerous_variants),
                    detail=d.stderr_text()[-2000:])
        return

    # 4) flood toward maxEntries=1000 with distinct actions; must refuse gracefully past the cap, not crash.
    # Spread across fresh connections in batches well under maxMessagesPerSecond=200 (one message per
    # connection setup + the approve itself), so the *message* rate limiter doesn't cut this test off
    # before we can reach anywhere near ApprovalStore.maxEntries=1000.
    accepted = 0
    refused = 0
    t0 = time.monotonic()
    i = 0
    batch_size = 150
    while i < 1200:
        try:
            fc = Client(f"ws://{HOST}:{PORT}/", token=d.token)
            await fc.connect(timeout=5)
            await fc.handshake(timeout=5)
        except Exception as e:
            sink.note(f"approve_action flood: could not open batch connection at i={i}: {e!r}")
            break
        batch_failed = False
        for _ in range(batch_size):
            if i >= 1200:
                break
            act = {"kind": "shell", "command": f"echo flood-{i}-{random.random()}", "label": f"f{i}"}
            try:
                await fc.send({"type": "approve_action", "action": act})
                msg = await fc.recv_matching(lambda m: m.get("type") in ("approved", "error"), timeout=2)
                if msg.get("type") == "approved":
                    accepted += 1
                else:
                    refused += 1
            except Exception as e:
                sink.note(f"approve_action flood: request #{i} failed: {e!r}")
                batch_failed = True
                break
            i += 1
        await fc.close()
        if batch_failed and not d.is_alive():
            break
    sink.metric("approval_flood_accepted", accepted)
    sink.metric("approval_flood_refused", refused)
    sink.metric("approval_flood_seconds", round(time.monotonic() - t0, 1))
    if accepted > 1000:
        sink.finding("high", f"ApprovalStore accepted {accepted} entries, over its documented maxEntries=1000",
                    repro="approve_action with 1200 distinct shell commands")
    elif refused == 0:
        sink.finding("medium", "approval flood of 1200 distinct actions was never refused (maxEntries=1000 "
                               "not reached or not enforced as expected)",
                    repro="approve_action with 1200 distinct shell commands", detail=f"accepted={accepted}")
    else:
        sink.note(f"ApprovalStore correctly capped at maxEntries=1000: accepted={accepted}, refused={refused}")
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died during approval-store flood toward maxEntries", repro="1200x approve_action",
                    detail=d.stderr_text()[-2000:])
        return

    # 5) concurrent approve/revoke race on the SAME action from many connections.
    async def approve_and_revoke(i):
        cc = Client(f"ws://{HOST}:{PORT}/", token=d.token)
        await cc.connect(timeout=5)
        await cc.handshake(timeout=5)
        act = {"kind": "shell", "command": "echo race-target", "label": "race"}
        try:
            appr = await cc.request({"type": "approve_action", "action": act}, "approved", timeout=3)
            await cc.send({"type": "revoke_action", "hash": appr["hash"]})
            await cc.recv_matching(lambda m: m.get("type") in ("revoked", "error"), timeout=3)
        except Exception:
            pass
        finally:
            await cc.close()

    await asyncio.gather(*(approve_and_revoke(i) for i in range(25)), return_exceptions=True)
    if not d.is_alive():
        sink.finding("CRITICAL", "daemon died from concurrent approve/revoke race on one action",
                    repro="25 connections concurrently approve_action + revoke_action on the same command",
                    detail=d.stderr_text()[-2000:])
    else:
        # approved.json must still parse and only contain 64-char hex hashes.
        approved_json = d.config_dir / "approved.json"
        if approved_json.exists():
            try:
                obj = json.loads(approved_json.read_text())
                hashes = obj.get("hashes", [])
                if not all(isinstance(h, str) and len(h) == 64 for h in hashes):
                    sink.finding("high", "approved.json contains malformed entries after concurrent approve/revoke race",
                                repro="25-way concurrent approve+revoke on one action", detail=str(hashes)[:500])
                else:
                    sink.note(f"approved.json intact after 25-way concurrent approve/revoke race "
                             f"({len(hashes)} entries remain)")
            except Exception as e:
                sink.finding("CRITICAL", "approved.json is not valid JSON after concurrent approve/revoke race",
                            repro="25-way concurrent approve+revoke on one action", detail=repr(e))
    await c.close()


async def main():
    config_dir = Path(sys.argv[1])
    findings_path = Path(sys.argv[2])
    sink = Sink(findings_path, "rate_limiter_and_approval_attack")
    binary = daemon_proc.BINARY_PATH
    if not binary.exists():
        sink.finding("CRITICAL", "stress daemon binary missing", repro=f"expected {binary}")
        sink.finish("build_missing")
        return

    d = daemon_proc.DaemonProcess(binary, config_dir / "rateattack", PORT)
    d.start(wait_ready=10.0)
    try:
        await attack_message_rate_limit(sink, d)
        if d.is_alive():
            await attack_test_action_rate_limit(sink, d)
        if d.is_alive():
            await attack_global_action_limiter(sink, d)
        if d.is_alive():
            await attack_feedback_rate_limit(sink, d)
        if d.is_alive():
            await attack_approval_store(sink, d)
        sink.metric("final_alive", d.is_alive())
        sink.finish("completed")
    except Exception as e:
        sink.finding("CRITICAL", "rate_attack harness itself crashed", repro=str(e))
        sink.finish("harness_error")
        raise
    finally:
        if d.is_alive():
            d.stop()
        daemon_proc.kill_stray_ghostkeysd_stress()


if __name__ == "__main__":
    asyncio.run(main())
