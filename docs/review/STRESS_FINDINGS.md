# Ghostkeys daemon stress test findings

Generated 2026-09-27 01:22:35 -0500.

Scope: `tests/stress/**` only, built and run by the same agent that wrote this file. `daemon/Sources/**` was never edited. Every daemon instance ran `--simulate-sensors --no-hardware-sessions --dry-run` with a throwaway `--config-dir` (under the scratchpad, never `~/Library/Application Support/Ghostkeys/`) on a port in 47970-47979, built into `daemon/.build-stress` (never `.build`, `.build-e2e`, or another agent's scratch dir). No mic, camera, speaker, sudo or real action was used anywhere in this run. No `git` command was run.

## Verdict

**2 critical finding(s).** The daemon crashed, corrupted on-disk state, or ran an action it shouldn't have during this run. See below.

## Summary

| test | status | planned | findings (C/H/M/L) |
| --- | --- | --- | --- |
| chaos | completed | n/a | 0/0/1/0 |
| deep_json_nesting_isolated_repro | completed | n/a | 1/0/0/0 |
| protocol_fuzzer | completed | 30.0min | 70/0/1/0 |
| handshake_queue_exhaustion | completed | n/a | 0/3/0/0 |
| rate_limiter_and_approval_attack | completed | n/a | 0/0/0/0 |
| soak | ? | 2.0h | 0/0/0/0 |

## Findings, ranked

### 1. [CRITICAL] any WebSocket message with ~470+ levels of nested JSON objects crashes the daemon (SIGBUS / stack overflow)

- **Where:** `deep_json_nesting_isolated_repro`
- **Repro:** 1) start ghostkeysd --simulate-sensors --no-hardware-sessions --dry-run --port <p> --config-dir <tmp>
2) connect with a valid X-Ghostkeys-Token
3) send one text frame: '{"type": "config_get", "junk": ' + ('{"a":' * 470) + '1' + ('}' * 470) + '}'
4) the daemon process exits immediately with signal 10 (SIGBUS), before even logging the message type
- **Detail:**

```
Isolated, controlled bisection (single connection, no other traffic, fresh daemon per trial, run 2026-09-27):
  depth=250..460 (object nesting): survives
  depth=470,480,490,500 (object nesting): crashes every time, exit code -10 (SIGBUS), 3/3 repeats at 500
  depth=50,200,500,1000,2000,10000,50000 (array nesting, same field): never crashes

Blanket, not config_set-specific: reproduced identically by putting the same nested object 470-2000 levels deep in:
  - config_get's ignored 'junk' field (a field the handler never reads)
  - test_action's 'action' field
  - approve_action's 'action' field
  - the raw frame with no 'type' key reachable at all
All four crash identically at the same depths, which places the crash in WebSocketServer.receive()'s initial `JSONSerialization.jsonObject(with: data)` call (Server/WebSocketServer.swift), before the message is dispatched to Daemon.handle() at all -- not in Config's Codable decode path specifically. Foundation's JSON object parser is recursive without a depth limit; nested *dictionaries* blow the stack at a much shallower depth than nested *arrays* on this build/OS (arm64, macOS 26), consistent with known JSONSerialization/JSONDecoder stack-overflow behavior on deeply nested keyed containers.

Impact: any client holding a valid session token (read from <config dir>/token, mode 0600 but readable by any process running as the same user) can crash the entire daemon -- losing all gesture detection, bindings and actions until the app or the user restarts it -- with a single ~15 KB text frame, far under the 1 MB maxMessageBytes limit. Also reproduced organically dozens of times during the 30-minute concurrent protocol fuzzer run (see protocol_fuzzer results), which restarted the daemon each time to keep fuzzing; some of those crashes are mis-attributed there to whichever concurrent worker's liveness check happened to notice first (e.g. 'rate_flood', 'reconnect_storm'), since many workers shared one daemon instance -- this isolated, single-connection repro is the reliable one to act on.
```

### 2. [CRITICAL] daemon died during fuzzing (deep_nest(depth=100000,kind=object)) (x70 occurrences)

- **Where:** `protocol_fuzzer`
- **Repro:** Run fuzzer.py; during the 'deep_nest(depth=100000,kind=object)' worker the daemon process exited on its own (exit code -10). Not killed by us.
- **Detail:**

```
stderr tail:
[ghostkeysd:debug] client 389 disconnected
[ghostkeysd:debug] connection 392 state: preparing
[ghostkeysd:debug] <- catalog_get
[ghostkeysd:debug] connection 392 state: ready
[ghostkeysd:debug] client 392 connected
[ghostkeysd:debug] <- sim_adapt
[ghostkeysd:debug] <- config_set
[ghostkeysd:debug] zones needing multi-tap: []
[ghostkeysd:debug] connection 393 state: preparing
[ghostkeysd:debug] <- sound_session_start
[ghostkeysd] sound session not started: paused
[ghostkeysd:debug] connection 393 state: ready
[ghostkeysd:debug] client 393 connected
[ghostkeysd:debug] <- sim_adapt
[ghostkeysd:debug] connection 394 state: preparing
[ghostkeysd] rejected a WebSocket handshake without a valid X-Ghostkeys-Token
[ghostkeysd:debug] <- resume
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] connection 394 state: ready
[ghostkeysd:debug] closing connection 394: not authorized
[ghostkeysd:debug] client 394 disconnected
[ghostkeysd:debug] <- approve_action
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] <- feedback_missed
[ghostkeysd:debug] connection 395 state: preparing
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] <- pause
[ghostkeysd:debug] connection 395 state: ready
[ghostkeysd:debug] client 395 connected
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] <- sonar_session_stop
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] connection 396 state: preparing
[ghostkeysd] rejected a WebSocket handshake without a valid X-Ghostkeys-Token
[ghostkeysd:debug] <- calibration_cancel
[ghostkeysd:debug] <- config_get
[ghostkeysd:debug] connection 396 state: ready
[ghostkeysd:debug] closing connection 396: not authorized
[ghostkeysd:debug] client 396 disconnected
[ghostkeysd:debug] <- sim_undo

stdout tail:

```
- **Variants seen (70 total):** `daemon died during fuzzing (deep_nest(depth=1000,kind=mixed))`; `daemon died during fuzzing (deep_nest(depth=1000,kind=object))`; `daemon died during fuzzing (deep_nest(depth=100000,kind=object))`; `daemon died during fuzzing (deep_nest(depth=20000,kind=object))`; `daemon died during fuzzing (deep_nest(depth=5000,kind=object))`; `daemon died during fuzzing (handshake_race)`; `daemon died during fuzzing (malformed_frames: [Errno 61] Connect call failed ('127.0.0.1', 47970))`; `daemon died during fuzzing (oversized(1000))`; `daemon died during fuzzing (oversized(100000))`; `daemon died during fuzzing (oversized(1048000))`; `daemon died during fuzzing (oversized(1048576))`; `daemon died during fuzzing (rate_flood)`; `daemon died during fuzzing (raw_frames)`; `daemon died during fuzzing (reconnect_storm)`; `daemon died during fuzzing (unicode)`
- **Note:** this is the 30-minute concurrent fuzz run organically hitting the same bug as the isolated deep-JSON-nesting repro elsewhere in this document, dozens of times. Many fuzzer workers share one daemon instance, so which worker's name ends up in the title here is approximate (whichever one's liveness check happened to run first after the crash) -- treat the isolated repro as the authoritative one and this as confirmation the bug is easy to hit by accident under normal traffic, not a second distinct bug.

### 3. [high] legitimate client could not connect at all with 16 half-open sockets held

- **Where:** `handshake_queue_exhaustion`
- **Repro:** same as above with n_attackers=16
- **Detail:**

```
InvalidMessage('did not receive a valid HTTP response')
```

### 4. [high] legitimate client could not connect at all with 32 half-open sockets held

- **Where:** `handshake_queue_exhaustion`
- **Repro:** same as above with n_attackers=32
- **Detail:**

```
InvalidMessage('did not receive a valid HTTP response')
```

### 5. [high] legitimate client could not connect at all with 64 half-open sockets held

- **Where:** `handshake_queue_exhaustion`
- **Repro:** same as above with n_attackers=64
- **Detail:**

```
InvalidMessage('did not receive a valid HTTP response')
```

### 6. [medium] calibration_finish reported 'done' while model/ was read-only (save likely silently failed)

- **Where:** `chaos`
- **Repro:** chmod 0500 /private/tmp/claude-501/-Users-sohamaggarwal/5865e2c2-7871-49a1-8e02-7f828d1f782d/scratchpad/run/chaos/diskfull/model, then complete a calibration
- **Detail:**

```
Daemon.finishCalibration logs a Log.error on saveModel failure but always broadcasts phase:done regardless of whether the save succeeded.
```

### 7. [medium] daemon took 8s to accept a clean connection after fuzzing stopped

- **Where:** `protocol_fuzzer`
- **Repro:** run the full worker mix (esp. worker_half_open_and_slowloris + worker_handshake_race) for the fuzz duration, then immediately try a normal client connect+config_get
- **Detail:**

```
Likely the WebSocketServer.maxPending=16 handshake admission queue draining handshakeTimeout=2s slots one at a time; see handshake_queue_test.py for an isolated, quantified repro of the same mechanism.
```

## What held up under attack

## Metrics

## Out of reach for this black-box run

- **Clock jumps**: changing the system clock needs `sudo` (prohibited by the overnight safety rules) and the daemon's CLI has no fault-injection hook for it under `--simulate-sensors`. Not attempted.
- **Disk-full**: simulated with a read-only config directory (`chmod 0500`), not an actual full filesystem, per the safety rules (no disk image / `hdiutil`). This exercises the same write-failure code path (`ENOSPC` and `EACCES` both fail the same `Data.write` / `FileManager` calls) but is not byte-for-byte identical to `ENOSPC`.

