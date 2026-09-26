"""test_action for every action kind (PROTOCOL.md "Action kinds" table) in
--dry-run, including the documented refusals, plus the approval workflow
(Security/ApprovalStore.swift) that a concurrent security pass added to
`shell`, `applescript`, `shortcut` and `open` partway through writing this
suite (see FINDINGS.md #2/#5/#6 for the timeline).

Important dry-run caveat (see FINDINGS.md #1): ActionRunner.perform() calls
validate(kind, action), then the approval check, and only then -- if not
dry-run -- execute(). Refusals that live in validate() (CommandFilter's
dangerous-pattern checks, nested macro, >50 macro steps, unknown kind/op, bad
fields) and the approval gate fire identically in dry-run and are fully
covered here. Refusals that only live inside execute() -- the Finder-quit and
self-quit guards in WindowActions.app(_:) -- are NOT reachable in dry-run and
are only smoke-tested for "doesn't crash / doesn't false-refuse", with the gap
called out explicitly, since actually exercising them would require a real
(non-dry-run) quit action, which the task's safety rules for this Mac forbid.
"""
from __future__ import annotations

import results


async def run_action(client, action):
    return await client.request({"type": "test_action", "action": action}, "action")


# -- straightforward valid cases, one per non-gated action kind --------------

async def test_action_keystroke_valid(connected):
    r = await run_action(connected.client, {"kind": "keystroke", "key": "v", "modifiers": ["command"]})
    assert r["ok"] is True, r


async def test_action_keystroke_unknown_key(connected):
    r = await run_action(connected.client, {"kind": "keystroke", "key": "not-a-real-key"})
    assert r["ok"] is False
    assert "unknown key" in r["error"]


async def test_action_volume_valid(connected):
    r = await run_action(connected.client, {"kind": "volume", "step": 6})
    assert r["ok"] is True, r


async def test_action_volume_missing_step(connected):
    r = await run_action(connected.client, {"kind": "volume"})
    assert r["ok"] is False
    assert "numeric step" in r["error"]


async def test_action_mute_valid(connected):
    r = await run_action(connected.client, {"kind": "mute"})
    assert r["ok"] is True, r
    assert r["label"] == "Test: mute", "default label should be 'Test: <kind>' when none is supplied"


async def test_action_media_valid(connected):
    r = await run_action(connected.client, {"kind": "media", "command": "playpause"})
    assert r["ok"] is True, r


async def test_action_media_unknown_command(connected):
    r = await run_action(connected.client, {"kind": "media", "command": "rewind"})
    assert r["ok"] is False
    assert "unknown media command" in r["error"]


async def test_action_brightness_valid(connected):
    r = await run_action(connected.client, {"kind": "brightness", "step": 10})
    assert r["ok"] is True, r


async def test_action_brightness_missing_step(connected):
    r = await run_action(connected.client, {"kind": "brightness"})
    assert r["ok"] is False


async def test_action_text_valid(connected):
    r = await run_action(connected.client, {"kind": "text", "text": "hello from the e2e suite"})
    assert r["ok"] is True, r


async def test_action_text_missing_text(connected):
    r = await run_action(connected.client, {"kind": "text"})
    assert r["ok"] is False
    assert "needs text" in r["error"]


async def test_action_text_too_long_is_refused(connected):
    r = await run_action(connected.client, {"kind": "text", "text": "x" * 5001})
    assert r["ok"] is False
    assert "too long" in r["error"]


async def test_action_clipboard_valid(connected):
    r = await run_action(connected.client, {"kind": "clipboard", "text": "hello"})
    assert r["ok"] is True, r


async def test_action_clipboard_too_long_is_refused(connected):
    r = await run_action(connected.client, {"kind": "clipboard", "text": "x" * 5001})
    assert r["ok"] is False


async def test_action_window_valid(connected):
    r = await run_action(connected.client, {"kind": "window", "op": "center"})
    assert r["ok"] is True, r


async def test_action_window_unknown_op(connected):
    r = await run_action(connected.client, {"kind": "window", "op": "teleport"})
    assert r["ok"] is False
    assert "unknown window op" in r["error"]


async def test_action_app_hide_valid(connected):
    r = await run_action(connected.client, {"kind": "app", "op": "hide"})
    assert r["ok"] is True, r


async def test_action_app_unknown_op(connected):
    r = await run_action(connected.client, {"kind": "app", "op": "explode"})
    assert r["ok"] is False
    assert "unknown app op" in r["error"]


async def test_action_app_quit_finder_not_refused_in_dry_run_KNOWN_GAP(connected):
    """See FINDINGS.md #1. validate("app", ...) only checks that "quit" is a
    member of WindowActions.appOps; the Finder/self-pid guards live in
    WindowActions.app(_:), only reached from execute(), which dry-run skips.
    So today a dry-run test_action to quit Finder always reports ok:true,
    regardless of which app is actually frontmost."""
    r = await run_action(connected.client, {"kind": "app", "op": "quit"})
    assert r["ok"] is True, (
        "if this is suddenly False, the Finder/self-quit guard has moved into validate() -- "
        "great, update this test and close FINDINGS.md #1"
    )
    results.note("test_action app/quit reported ok=true under --dry-run regardless of frontmost app "
                 "(FINDINGS.md #1); the real refusal logic is unreachable without a live, non-dry-run run")


async def test_action_system_lock_valid(connected):
    r = await run_action(connected.client, {"kind": "system", "op": "lock"})
    assert r["ok"] is True, r


async def test_action_system_unknown_op(connected):
    r = await run_action(connected.client, {"kind": "system", "op": "self-destruct"})
    assert r["ok"] is False
    assert "unknown system op" in r["error"]


async def test_action_integration_unknown_command_is_refused(connected):
    """GhostkeysIntegrations landed partway through writing this suite (see
    FINDINGS.md #3 for the timeline: it was an unimplemented placeholder module
    when this suite was started). ActionRunner.validate("integration", ...) now
    looks the app/command pair up in IntegrationCatalog and refuses anything not
    in it."""
    r = await run_action(connected.client, {"kind": "integration", "app": "excel", "command": "not-a-real-command"})
    assert r["ok"] is False
    assert "unknown integration: excel/not-a-real-command" in r["error"]


async def test_action_integration_valid_command(connected):
    r = await run_action(connected.client, {"kind": "integration", "app": "finder", "command": "reveal-desktop"})
    assert r["ok"] is True, r


# -- gated kinds: shell, applescript, shortcut, open (Security/ApprovalStore.swift) --

async def test_action_shell_without_approval_is_refused(connected):
    r = await run_action(connected.client, {"kind": "shell", "command": "echo hi"})
    assert r["ok"] is False
    assert "not approved: this action needs approval in the app first" in r["error"]


async def test_action_shell_valid_after_approval(connected):
    c = connected.client
    action = {"kind": "shell", "command": "echo hi"}
    h = await c.approve(action)
    assert len(h) == 64  # sha256 hex
    r = await run_action(c, {**action, "approvedHash": h})
    assert r["ok"] is True, r


async def test_action_shell_missing_command(connected):
    r = await run_action(connected.client, {"kind": "shell", "command": ""})
    assert r["ok"] is False
    assert "shell needs a command" in r["error"]


async def test_action_shell_refuses_sudo_even_without_needing_approval_check(connected):
    # CommandFilter runs in validate(), before the approval gate, so this is
    # refused for being dangerous, not merely for lacking approval.
    r = await run_action(connected.client, {"kind": "shell", "command": "sudo rm -rf /tmp/nope"})
    assert r["ok"] is False
    assert "refusing a command that uses sudo" in r["error"]


async def test_action_shell_refuses_sudo_mid_command(connected):
    r = await run_action(connected.client, {"kind": "shell", "command": "echo hi && sudo whoami"})
    assert r["ok"] is False
    assert "refusing a command that uses sudo" in r["error"]


async def test_action_shell_refuses_rm_rf(connected):
    r = await run_action(connected.client, {"kind": "shell", "command": "rm -rf /tmp/whatever"})
    assert r["ok"] is False
    assert "refusing a command that uses rm -rf" in r["error"]


async def test_action_applescript_without_approval_is_refused(connected):
    r = await run_action(connected.client, {"kind": "applescript", "source": 'say "hi"'})
    assert r["ok"] is False
    assert "not approved" in r["error"]


async def test_action_applescript_valid_after_approval(connected):
    c = connected.client
    action = {"kind": "applescript", "source": 'say "hi"'}
    h = await c.approve(action)
    r = await run_action(c, {**action, "approvedHash": h})
    assert r["ok"] is True, r


async def test_action_applescript_missing_source(connected):
    r = await run_action(connected.client, {"kind": "applescript", "source": ""})
    assert r["ok"] is False


async def test_action_applescript_refuses_sudo(connected):
    r = await run_action(connected.client, {"kind": "applescript", "source": "do shell script \"sudo ls\""})
    assert r["ok"] is False
    assert "refusing an AppleScript that uses sudo" in r["error"]


async def test_action_applescript_refuses_admin_privileges_phrase(connected):
    r = await run_action(connected.client, {"kind": "applescript",
                                             "source": "do shell script \"ls\" with administrator privileges"})
    assert r["ok"] is False
    assert "refusing an AppleScript that uses" in r["error"]
    assert "administrator privileges" in r["error"]


async def test_action_shortcut_without_approval_is_refused(connected):
    r = await run_action(connected.client, {"kind": "shortcut", "name": "My Shortcut"})
    assert r["ok"] is False
    assert "not approved" in r["error"]


async def test_action_shortcut_valid_after_approval(connected):
    c = connected.client
    action = {"kind": "shortcut", "name": "My Shortcut"}
    h = await c.approve(action)
    r = await run_action(c, {**action, "approvedHash": h})
    assert r["ok"] is True, r


async def test_action_shortcut_missing_name(connected):
    r = await run_action(connected.client, {"kind": "shortcut", "name": ""})
    assert r["ok"] is False


async def test_action_open_without_approval_is_refused(connected):
    r = await run_action(connected.client, {"kind": "open", "target": "Calculator"})
    assert r["ok"] is False
    assert "not approved" in r["error"]


async def test_action_open_valid_after_approval(connected):
    c = connected.client
    action = {"kind": "open", "target": "Calculator"}
    h = await c.approve(action)
    r = await run_action(c, {**action, "approvedHash": h})
    assert r["ok"] is True, r


async def test_action_open_missing_target(connected):
    r = await run_action(connected.client, {"kind": "open", "target": ""})
    assert r["ok"] is False
    assert "open needs a target" in r["error"]


async def test_action_open_refuses_dangerous_target(connected):
    r = await run_action(connected.client, {"kind": "open", "target": "x; sudo rm -rf /"})
    assert r["ok"] is False
    assert "refusing to open a target that uses sudo" in r["error"]


async def test_action_approve_wrong_hash_is_refused(connected):
    c = connected.client
    action = {"kind": "shell", "command": "echo hi"}
    h = await c.approve(action)
    tampered = {**action, "command": "echo something else entirely", "approvedHash": h}
    r = await run_action(c, tampered)
    assert r["ok"] is False
    assert "the action changed since it was approved" in r["error"]


async def test_revoke_action_removes_approval(connected):
    c = connected.client
    action = {"kind": "shell", "command": "echo hi"}
    h = await c.approve(action)

    r1 = await run_action(c, {**action, "approvedHash": h})
    assert r1["ok"] is True, r1

    revoked = await c.request({"type": "revoke_action", "hash": h}, "revoked")
    assert revoked["found"] is True

    r2 = await run_action(c, {**action, "approvedHash": h})
    assert r2["ok"] is False
    assert "not approved: approval was revoked or never given" in r2["error"]


async def test_revoke_action_unknown_hash_reports_not_found(connected):
    c = connected.client
    revoked = await c.request({"type": "revoke_action", "hash": "0" * 64}, "revoked")
    assert revoked["found"] is False


async def test_approve_action_rejects_non_gated_kind(connected):
    c = connected.client
    await c.send({"type": "approve_action", "action": {"kind": "volume", "step": 1}})
    err = await c.recv_type("error", timeout=3)
    assert "only shell, applescript, shortcut and open actions need approval" in err["message"]


async def test_approve_action_missing_action_field(connected):
    c = connected.client
    await c.send({"type": "approve_action"})
    err = await c.recv_type("error", timeout=3)
    assert "approve_action needs an action" in err["message"]


# -- macros -------------------------------------------------------------------

async def test_action_macro_valid(connected):
    r = await run_action(connected.client, {"kind": "macro", "steps": [
        {"kind": "mute"}, {"kind": "volume", "step": 1, "delayMs": 10},
    ]})
    assert r["ok"] is True, r


async def test_action_macro_empty_steps_refused(connected):
    r = await run_action(connected.client, {"kind": "macro", "steps": []})
    assert r["ok"] is False
    assert "macro has no steps" in r["error"]


async def test_action_macro_rejects_nested_macro(connected):
    r = await run_action(connected.client, {"kind": "macro", "steps": [
        {"kind": "macro", "steps": [{"kind": "mute"}]},
    ]})
    assert r["ok"] is False
    assert "a macro cannot contain another macro" in r["error"]


async def test_action_macro_rejects_more_than_50_steps(connected):
    steps = [{"kind": "mute"} for _ in range(51)]
    r = await run_action(connected.client, {"kind": "macro", "steps": steps})
    assert r["ok"] is False
    assert "macro has more than 50 steps" in r["error"]


async def test_action_macro_allows_exactly_50_steps(connected):
    steps = [{"kind": "mute"} for _ in range(50)]
    r = await run_action(connected.client, {"kind": "macro", "steps": steps})
    assert r["ok"] is True, r


async def test_action_macro_step_error_is_1_indexed_and_wrapped(connected):
    r = await run_action(connected.client, {"kind": "macro", "steps": [
        {"kind": "mute"}, {"kind": "mute"}, {"kind": "volume"},
    ]})
    assert r["ok"] is False
    assert "macro step 3: " in r["error"]
    assert "numeric step" in r["error"]


async def test_action_macro_step_needing_approval_is_refused_even_when_valid(connected):
    r = await run_action(connected.client, {"kind": "macro", "steps": [
        {"kind": "mute"}, {"kind": "shell", "command": "echo hi"},
    ]})
    assert r["ok"] is False
    assert "macro step 2: not approved" in r["error"]


# -- malformed test_action envelopes ------------------------------------------

async def test_test_action_missing_action_field(connected):
    c = connected.client
    await c.send({"type": "test_action"})
    err = await c.recv_type("error", timeout=3)
    assert "test_action needs an action" in err["message"]


async def test_test_action_action_missing_kind(connected):
    r = await run_action(connected.client, {})
    assert r["ok"] is False
    assert "action has no kind" in r["error"]


# -- per-client and paused gating --------------------------------------------

async def test_test_action_refused_while_paused_then_allowed_after_resume(connected):
    c = connected.client
    await c.send({"type": "pause"})
    await c.recv_type("status", timeout=3)

    r_paused = await run_action(c, {"kind": "mute"})
    assert r_paused["ok"] is False
    assert r_paused["error"] == "paused"

    await c.send({"type": "resume"})
    await c.recv_type("status", timeout=3)

    r_resumed = await run_action(c, {"kind": "mute"})
    assert r_resumed["ok"] is True


async def test_test_action_rate_limited_to_2_per_second(connected):
    """Server/WebSocketServer.swift + App/Daemon.swift: at most 2 test_action
    per second per client (docs/PROTOCOL.md "Authentication" limits)."""
    c = connected.client
    r1 = await run_action(c, {"kind": "mute"})
    r2 = await run_action(c, {"kind": "mute"})
    r3 = await run_action(c, {"kind": "mute"})
    assert r1["ok"] is True
    assert r2["ok"] is True
    assert r3["ok"] is False
    assert r3["error"] == "rate limit: at most 2 test actions per second"
