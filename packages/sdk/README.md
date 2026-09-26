# @ghostkeys/sdk

A TypeScript client for `ghostkeysd`, the local WebSocket daemon that turns taps on your MacBook's
case into gestures and actions. Talks the protocol in [`docs/PROTOCOL.md`](../../docs/PROTOCOL.md):
complete discriminated-union types, zod validation of everything the daemon sends, auto-reconnect,
a typed event emitter, and promise-based helpers for the request/reply flows (pause/resume, config,
test actions, calibration).

The daemon only ever listens on `ws://127.0.0.1:47823` (loopback), so this SDK is for anything
running on the same Mac: a Node script, an Electron app, a CLI (see `@ghostkeys/cli`), or a local
web UI.

## Install

```sh
pnpm add @ghostkeys/sdk
# Node needs a WebSocket implementation. Node 22+ has one built in (globalThis.WebSocket).
# On older Node, or to pick a specific implementation, also install `ws`:
pnpm add ws
```

## Quick start

```ts
import { GhostkeysClient } from '@ghostkeys/sdk'

const client = new GhostkeysClient()

client.on('gesture', (g) => {
  console.log(`${g.gesture} in ${g.zone ?? g.zones?.join(' -> ')}`)
})

await client.connect() // resolves once the daemon's "hello" arrives
client.subscribe(['taps']) // also get every accepted tap and rejected candidate
```

`GhostkeysClient` reconnects automatically (exponential backoff, re-subscribing to whatever streams
you asked for) unless you pass `{ reconnect: false }`. Call `client.disconnect()` to stop for good.

## Events

Every daemon -> app message from PROTOCOL.md is an event, named after its `type`:

```ts
client.on('hello', (h) => ...)        // sent on connect, and again if Accessibility permission changes
client.on('status', (s) => ...)       // paused/calibrated/zones/imuHz; sent every 5s and after changes
client.on('imu', (m) => ...)          // only while subscribed to "imu"
client.on('lid', (m) => ...)          // only while subscribed to "lid"
client.on('light', (m) => ...)        // only while subscribed to "light"
client.on('tap', (t) => ...)          // only while subscribed to "taps"
client.on('rejected', (r) => ...)     // only while subscribed to "taps"
client.on('gesture', (g) => ...)      // always, regardless of subscriptions
client.on('action', (a) => ...)       // always: the result of a binding or test_action firing
client.on('calibration', (c) => ...)  // started | capturing | negatives | training | done | cancelled
client.on('config', (c) => ...)       // the full config, after config_get/config_set
client.on('error', (e) => ...)        // the daemon rejected something this client (or another) sent
```

Plus connection lifecycle events that aren't part of the wire protocol:

```ts
client.on('open', () => ...)               // transport connected, before hello
client.on('connect', (hello) => ...)       // the first successful connect
client.on('reconnecting', ({ attempt, delayMs }) => ...)
client.on('reconnected', (hello) => ...)
client.on('disconnect', ({ code, reason, willReconnect }) => ...)
client.on('protocolError', ({ raw, issue }) => ...) // a frame that failed zod validation
```

Every `on`/`once` returns an unsubscribe function.

## Request helpers

The wire protocol has no request ids: replies are matched by message type, which is safe for
normal single-client-at-a-time usage (documented per-method where it matters, e.g. `testAction`).

```ts
await client.pause()
await client.resume()

const { config, revision } = await client.getConfig()
await client.setConfig({ ...config, settings: { ...config.settings, sensitivity: 0.7 } }, { ifRevision: revision })
// ^ throws ConfigConflictError locally (no network round trip) if the config changed since you read it

await client.testAction({ kind: 'volume', step: 6 })
await client.requestAccessibility()
```

### Calibration

`startCalibration` drives the daemon's calibration state machine and returns a `CalibrationFlow`:

```ts
const flow = await client.startCalibration(['left-palm', 'right-palm'], 20)
flow.onProgress((p) => console.log(p.phase, 'zone' in p ? p.zone : '', 'count' in p ? p.count : ''))

await flow.captureZone('left-palm')   // prompts the user to tap; resolves at 20 samples
await flow.captureZone('right-palm')
await flow.negatives(45)              // user types/uses the trackpad normally for 45s
const report = await flow.finish()    // trains, saves, resolves with accuracy/confusion/labels
```

Call `flow.cancel()` at any point to send `calibration_cancel` and stop.

## Optimistic concurrency for config

`ghostkeysd` itself is last-write-wins on `config_set`. `GhostkeysClient` adds a client-side guard:
`getConfig()`/`setConfig()` return a `revision` (a fingerprint of the config), and passing that
revision back as `setConfig(next, { ifRevision })` throws `ConfigConflictError` *before sending
anything* if the client's config has moved on since you read it — so you can `getConfig()` again
and reapply your change instead of clobbering someone else's.

## Runtime validation

Every incoming frame is parsed with zod (`src/protocol/schemas.ts`) before it becomes a typed
event. A frame that doesn't match `docs/PROTOCOL.md` (unknown `type`, or a shape mismatch) never
throws — it's emitted as `protocolError` with the raw text and the zod issue, so a daemon on a
newer or older protocol version degrades gracefully instead of crashing your app.

## Pluggable WebSocket

```ts
import { WebSocket } from 'ws'
const client = new GhostkeysClient({ webSocket: WebSocket }) // force the `ws` package
```

By default the client uses the global `WebSocket` (every browser, and Node 22+), falling back to a
dynamic `import('ws')` only if neither is available. Pass your own for tests (see this package's
own `test/fake-server.ts` for an in-process fake daemon built on `ws`).

## Examples

### Log every gesture and action to a file (Node)

No third-party service needed.

```ts
import { appendFile } from 'node:fs/promises'
import { GhostkeysClient } from '@ghostkeys/sdk'

const client = new GhostkeysClient()
client.on('gesture', (g) => appendFile('ghostkeys.log', `${new Date().toISOString()} gesture ${g.gesture} ${g.zone ?? ''}\n`))
client.on('action', (a) => appendFile('ghostkeys.log', `${new Date().toISOString()} action ${a.label} ok=${a.ok}\n`))
await client.connect()
```

### Switch an OBS scene on a gesture (optional: needs OBS + `obs-websocket-js`)

```ts
// pnpm add obs-websocket-js
import OBSWebSocket from 'obs-websocket-js'
import { GhostkeysClient } from '@ghostkeys/sdk'

const obs = new OBSWebSocket()
await obs.connect('ws://127.0.0.1:4455', process.env.OBS_PASSWORD)

const client = new GhostkeysClient()
client.on('gesture', async (g) => {
  if (g.gesture === 'triple' && g.zone === 'top-strip') {
    await obs.call('SetCurrentProgramScene', { sceneName: 'Webcam' })
  }
})
await client.connect()
client.subscribe(['taps'])
```

### Trigger a Home Assistant scene on a cover gesture (optional: needs Home Assistant + a long-lived token)

```ts
// pnpm add node-fetch, or use Node's built-in fetch (Node 18+)
import { GhostkeysClient } from '@ghostkeys/sdk'

const client = new GhostkeysClient()
client.on('gesture', async (g) => {
  if (g.gesture !== 'cover_hold') return
  await fetch('http://homeassistant.local:8123/api/services/scene/turn_on', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.HASS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ entity_id: 'scene.movie_night' })
  })
})
await client.connect()
```

## Development

```sh
pnpm install
pnpm build       # tsc -> dist/
pnpm test        # vitest, against an in-process fake daemon (test/fake-server.ts)
pnpm typecheck
```
