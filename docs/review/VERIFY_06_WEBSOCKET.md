# VERIFY_06: hand-written WebSocket server

Independent check of `daemon/Sources/ghostkeysd/Server/WebSocketServer.swift` after it moved from Network.framework's
WebSocket layer to a hand-written RFC 6455 (the WebSocket standard) server on a plain TCP listener.

## Verdict

- **Security core is sound.** Loopback-only binding, Origin rejection, per-launch token with a constant-time compare,
  handshake timeouts, the 1 MB and depth-64 limits, masking enforcement and 64-bit length handling all held under
  targeted probes, a 10-minute fuzz run, and three client libraries.
- **Seven bugs fixed** in `WebSocketServer.swift` (each marked `VERIFY_06` in the code). Two mattered in practice:
  unbounded memory from a ping flood, and client slots that were never freed.
- **One crash found outside this file, not fixed** (out of scope): `calibration_negatives` with a huge `seconds`
  value kills the daemon. Every one of the fuzzer's 5 crashes was this.

## Fixes (all in WebSocketServer.swift)

| # | Bug | Effect before | Fix |
| --- | --- | --- | --- |
| 1 | Pongs bypassed the bounded send queue | A client that sends pings and never reads grew daemon memory from 32 MB to 265 MB in 8 s, with no limit | Pongs go through `enqueueFrame` (skipped while the client is behind; dropped past 1 MB backlog). Measured after: 31 MB to 33 MB |
| 2 | A closing connection was freed only once its last bytes were handed to TCP | A client that stops reading keeps that send pending forever. 8 such authenticated clients made every new connection get `503 too many clients` | `forceDropLater`: every reject/close drops the connection after 1 s at most |
| 3 | The socket was cancelled while unread input was still queued | Kernel sends a TCP reset, which can destroy the close frame in flight. Node `ws` (the app's client) saw close code 1006 (abnormal) instead of 1009 for 3 to 4 of 20 oversize messages | While closing, input is read and discarded until the peer closes (or 1 s). On a peer-initiated close the server still closes TCP at once, as RFC 6455 7.1.1 asks. After: 60 of 60 saw 1009 |
| 4 | Close and pong frames were not checked as control frames | Close frames over 125 bytes, fragmented, with a 1-byte body, with codes that must never be sent (1005, 999, 5000) or with a non-UTF-8 reason were accepted and the bad code echoed back | All control frames: final and at most 125 bytes, checked from the header before the body is buffered. Close codes and reason validated (1002 / 1007) |
| 5 | "Message in progress" tracked by buffered bytes | An empty non-final first fragment let a new data frame start mid-message | Track by `messageOpcode` |
| 6 | Text frames were not checked for UTF-8 | Invalid, overlong or surrogate UTF-8 got an "invalid JSON" reply instead of closing 1007 | Strict UTF-8 check on complete text messages (`isValidUTF8`, works on macOS 14) |
| 7 | Bare CR/LF or folded header lines accepted | `X-A: b\nOrigin: evil` was read as one header, hiding the Origin. Browsers cannot send this, so no real exposure | Such requests get 400 |

The unused `sendFrame` helper (the unbounded send path) was removed.

## Findings not fixed

- **Crash in `Daemon.swift:740` (high, needs the token).** `Int(((m["seconds"] as? NSNumber)?.doubleValue ?? 45).rounded())`
  traps when `seconds` is beyond `Int` range. Repro: `calibration_start`, then
  `{"type":"calibration_negatives","seconds":1e300}`; the daemon exits with
  `Fatal error: Double value cannot be converted to Int`. Fix: clamp the Double to 1...600 before converting.
  The same pattern (not verified reachable) is at `ActionRunner.swift:134` and `:213` for a binding's `step`.
- **Local connection churn can still delay the app (low, no token needed).** With 4 threads opening new sockets as
  fast as possible (about 12,000 connects), only 13 to 18 of 30 legitimate handshakes succeeded; the rest were
  evicted as the "idlest" pending connection before their request was read. 500 half-open sockets held (not
  churning) had no effect (legit connect in 0.016 s). This is a limit of any accept-and-evict design against a local
  flood; the app's reconnect covers it. Not changed.
- **Network.framework keeps one cache entry per remote port** (about 5 KB each). After 40,000 churned connections
  RSS sat at 236 MB (footprint 96 MB). It is bounded by the 16,384 ephemeral ports and is not a leak in our code:
  no `WebSocketServer.Client` objects remain on the heap.
- **SDK scenario (`tests/e2e/sdk_scenario.mjs`) 25 of 29, same on the unmodified build.** The 4 failures
  (feedback x3, diagnostics) are the scenario never subscribing to the SDK's `feedback` and `diagnostics` events
  (its listener list at line 86). The daemon answers them correctly when asked directly.

## Reviewed and correct

- Binding: `127.0.0.1` only (`lsof` shows IPv4 loopback). `[::1]` and the LAN address are refused.
- Token: header name is case-insensitive; duplicate token headers are joined, so they fail; compare is constant-time
  (`SessionToken.constantTimeEqual`); prefix and suffix variants fail.
- Origin: any `Origin` (including empty, `null`, uppercase name) is refused before the token is looked at.
- `Sec-WebSocket-Key` must decode to 16 bytes; the Accept value matches the RFC 6455 example
  (`s3pPLMBiTxaQ9kYGzzhZRbK+xOo=`). Version must be 13; `Connection: keep-alive, Upgrade` is accepted.
- Lengths: 16-bit and non-minimal 64-bit encodings accepted; a 64-bit length with the top bit set, `2^64-1`, or
  1 MB + 1 closes 1009 before any buffering. Buffers per connection are bounded (8 KB header, one frame up to
  1 MB, one message up to 1 MB). Fragments summing past 1 MB close 1009.
- Masking required (1002), reserved bits (1002), unknown opcodes (1002), continuation without a start (1002),
  interleaved ping inside a fragmented message answered with the same payload.
- Pipelining: frames sent in the same packet as the handshake are processed; a second HTTP request after the upgrade
  is read as frames and closed 1002. No request body is ever read as headers of a later request.
- Timeouts: silent socket closed at 0.50 s; partial request gets 408 at 2.0 s; a one-byte-every-0.3 s trickle is cut
  at the 2 s deadline.
- permessage-deflate offered by Node `ws` and Python `websockets` is not negotiated (the server sends no extension
  header), so RSV1 is correctly always an error.

## Test results (final build, `.build-verify-ws`)

| Suite | Result |
| --- | --- |
| Raw RFC 6455 probe (67 checks, scratch `probe.py`) | 67 pass. Unmodified build: 52 pass, 15 fail |
| e2e suite (`GHOSTKEYS_E2E_PORT=47996`) | 112 passed, 4 skipped (Finder not frontmost, real sensors, light, lid) |
| Protocol fuzzer, 600 s | Daemon alive and responsive at the end; max RSS 62 MB, max CPU 34 %. 5 crashes, all the `calibration_negatives` trap above |
| `handshake_queue_test.py` | No findings. Legit connect 0.009 to 0.011 s with 16/32/64 half-open sockets held (baseline 0.089 s) |
| `chaos.py` | Completed, no findings. `restore_sensors_after_kill` skipped: it runs the daemon without `--simulate-sensors` |
| SDK scenario (live daemon) | 25 of 29, identical to the unmodified build (see above) |
| Node `ws` 8.22.0 (app's client) | 10 of 10: hello, ping/pong, 900 KB message, clean close 1000, invalid UTF-8 gets 1007, no token / Origin / wrong token get 400, 9th client gets 503 |
| Python `websockets` 16.0 | 8 of 8: fragmented send with multibyte UTF-8, over-1 MB gets 1009, close 4001 echoed, 400s |
| curl | No token 400, Origin 400, POST 400, HTTP/1.0 400, 9 KB header 431, valid upgrade 101 |

How the stress scripts were pointed at this build without editing them: a scratch wrapper imported each script,
set `daemon_proc.BINARY_PATH` to a private copy of the binary (so the suite's stray-daemon killer can only hit that
run's processes), and overrode the module's `PORT` to 47997 to 47999. Every daemon ran with `--simulate-sensors
--no-hardware-sessions --dry-run --config-dir <scratch dir>`; nothing touched `~/Library/Application Support/Ghostkeys`.
The e2e suite rewrites `tests/e2e/REPORT.md`; that file was restored to its previous contents afterwards.
