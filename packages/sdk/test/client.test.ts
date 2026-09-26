import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { GhostkeysClient } from '../src/client.js'
import { ConfigConflictError, GhostkeysTimeoutError } from '../src/errors.js'
import type { WebSocketCtor } from '../src/ws.js'
import { FakeDaemon } from './fake-server.js'
import { testConfig } from './fixtures.js'

const webSocket = NodeWebSocket as unknown as WebSocketCtor

let daemon: FakeDaemon
let client: GhostkeysClient

beforeEach(async () => {
  daemon = await FakeDaemon.start(testConfig())
})

afterEach(async () => {
  client?.disconnect()
  await daemon.close()
})

describe('connect', () => {
  it('resolves with hello and populates lastHello/lastStatus/lastConfig', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    const hello = await client.connect()
    expect(hello.type).toBe('hello')
    expect(hello.device.family).toBe('macbook-pro-14')
    expect(client.connected).toBe(true)
    expect(client.lastHello).toEqual(hello)
    // status and config arrive right after hello on the same connection; give the event loop a tick.
    await new Promise((r) => setTimeout(r, 20))
    expect(client.lastStatus?.type).toBe('status')
    expect(client.lastConfig?.version).toBe(1)
    expect(client.lastConfigRevision).toBeTruthy()
  })

  it('rejects if no hello arrives before helloTimeoutMs', async () => {
    daemon.autoGreet = false
    client = new GhostkeysClient({ url: daemon.url, webSocket, helloTimeoutMs: 100, reconnect: false })
    await expect(client.connect()).rejects.toBeInstanceOf(GhostkeysTimeoutError)
  })

  it('dedupes concurrent connect() calls into one in-flight attempt', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    const [a, b] = await Promise.all([client.connect(), client.connect()])
    expect(a).toEqual(b)
  })
})

describe('events', () => {
  it('emits typed daemon messages as they arrive, and ignores frames while unsubscribed', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()

    const taps: unknown[] = []
    client.on('tap', (t) => taps.push(t))

    daemon.broadcast({ type: 'tap', t: 1, zone: 'right-grille', confidence: 0.9, x: 0.9, y: 0.2, strength: 0.5 })
    await new Promise((r) => setTimeout(r, 20))
    // The real daemon would not send this without a "taps" subscription, but the SDK's job here is
    // only to decode and emit whatever arrives — stream gating is the daemon's responsibility.
    expect(taps).toHaveLength(1)
  })

  it('emits gesture and action messages unconditionally (not stream-gated)', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const gestures: unknown[] = []
    client.on('gesture', (g) => gestures.push(g))
    daemon.broadcast({ type: 'gesture', t: 1, gesture: 'double', zone: 'right-grille', zones: null, modifiers: [], confidence: 0.9, app: null })
    await new Promise((r) => setTimeout(r, 20))
    expect(gestures).toHaveLength(1)
  })

  it('emits protocolError and does not throw on a malformed frame', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const errors: unknown[] = []
    client.on('protocolError', (e) => errors.push(e))
    for (const c of daemon.clients) c.send('not json')
    for (const c of daemon.clients) c.send(JSON.stringify({ type: 'tap', zone: 'right-grille' })) // missing required fields
    for (const c of daemon.clients) c.send(JSON.stringify({ type: 'not-a-real-type' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(errors).toHaveLength(3)
  })
})

describe('subscribe/unsubscribe', () => {
  it('sends the requested streams, queuing until the socket is open', async () => {
    const received: unknown[] = []
    // Set onMessage before connecting so we capture the queued subscribe too.
    const pre = await FakeDaemon.start(testConfig())
    pre.onMessage = (_c, m) => received.push(m)
    const c = new GhostkeysClient({ url: pre.url, webSocket })
    c.subscribe(['taps', 'lid']) // queued: not connected yet
    await c.connect()
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toContainEqual({ type: 'subscribe', streams: ['taps', 'lid'] })
    c.unsubscribe(['lid'])
    await new Promise((r) => setTimeout(r, 20))
    expect(received).toContainEqual({ type: 'unsubscribe', streams: ['lid'] })
    c.disconnect()
    await pre.close()
  })
})

describe('pause/resume', () => {
  it('resolves once the daemon confirms via status', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const paused = await client.pause()
    expect(paused.paused).toBe(true)
    const resumed = await client.resume()
    expect(resumed.paused).toBe(false)
  })
})

describe('config', () => {
  it('getConfig returns the config and a stable revision', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const first = await client.getConfig()
    const second = await client.getConfig()
    expect(first.config).toEqual(testConfig())
    expect(first.revision).toBe(second.revision)
  })

  // Regression test: getConfig() must resolve with the reply to ITS OWN config_get, not with the
  // "config" message the daemon sends unprompted as part of every connection's greeting (hello,
  // then status, then config). Calling it in the same tick connect() resolves, with no delay in
  // between, is exactly the timing that used to let the greeting's config satisfy this call.
  it('getConfig() called immediately after connect() does not resolve with the greeting config', async () => {
    daemon.config = { ...testConfig(), settings: { ...testConfig().settings, sensitivity: 0.11 } }
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    // No await/delay here on purpose: connect() and getConfig() run back to back.
    daemon.config = { ...testConfig(), settings: { ...testConfig().settings, sensitivity: 0.99 } }
    daemon.onMessage = (_c, m) => {
      // The moment the daemon actually receives config_get, update the config again, so the reply
      // it sends back is only possible to observe via the real reply path, never via the greeting.
      if (m.type === 'config_get') daemon.broadcast({ type: 'config', config: daemon.config })
    }
    const { config } = await client.getConfig()
    expect(config.settings.sensitivity).toBe(0.99)
  })

  it('setConfig succeeds when ifRevision matches and updates the revision', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const { config, revision } = await client.getConfig()
    const next = { ...config, settings: { ...config.settings, sensitivity: 0.75 } }
    const result = await client.setConfig(next, { ifRevision: revision })
    expect(result.config.settings.sensitivity).toBe(0.75)
    expect(result.revision).not.toBe(revision)
    expect(client.lastConfigRevision).toBe(result.revision)
  })

  it('setConfig throws ConfigConflictError locally, without sending anything, on a stale revision', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const { config } = await client.getConfig()
    let sawConfigSet = false
    daemon.onMessage = (_c, m) => {
      if (m.type === 'config_set') sawConfigSet = true
    }
    await expect(client.setConfig(config, { ifRevision: 'stale-revision' })).rejects.toBeInstanceOf(ConfigConflictError)
    await new Promise((r) => setTimeout(r, 20))
    expect(sawConfigSet).toBe(false)
  })

  it('setConfig without ifRevision always sends (last-write-wins, matching the daemon)', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const { config } = await client.getConfig()
    const result = await client.setConfig({ ...config, settings: { ...config.settings, hud: false } })
    expect(result.config.settings.hud).toBe(false)
  })
})

describe('testAction', () => {
  it('resolves with the action result for a bindingId-less action', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const result = await client.testAction({ kind: 'volume', step: 6, label: 'Test volume' })
    expect(result.bindingId).toBeNull()
    expect(result.ok).toBe(true)
    expect(result.label).toBe('Test volume')
  })
})

describe('requestAccessibility', () => {
  it('resolves with the next hello', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const hello = await client.requestAccessibility()
    expect(hello.type).toBe('hello')
  })
})

describe('approve/revoke/catalog/sessions', () => {
  it('approveAction resolves with a hash, and revokeAction by that hash reports found: true', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const approved = await client.approveAction({ kind: 'shell', command: 'echo hi' })
    expect(approved.hash).toHaveLength(64)
    expect(approved.kind).toBe('shell')
    const revoked = await client.revokeAction(approved.hash)
    expect(revoked).toEqual({ hash: approved.hash, found: true })
  })

  it('revokeAction accepts the action itself instead of a hash', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const action = { kind: 'applescript' as const, source: 'beep' }
    const approved = await client.approveAction(action)
    const revoked = await client.revokeAction(action)
    expect(revoked).toEqual({ hash: approved.hash, found: true })
  })

  it('getCatalog resolves with the integration catalog', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const catalog = await client.getCatalog()
    expect(Array.isArray(catalog.apps)).toBe(true)
  })

  it('startSoundSession/stopSoundSession resolve with the session state', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const started = await client.startSoundSession(10)
    expect(started).toMatchObject({ kind: 'sound', active: true })
    const stopped = await client.stopSoundSession()
    expect(stopped).toMatchObject({ kind: 'sound', active: false })
  })

  it('startAirSession/stopAirSession resolve with the session state', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()
    const started = await client.startAirSession(10)
    expect(started).toMatchObject({ kind: 'air', active: true })
    const stopped = await client.stopAirSession()
    expect(stopped).toMatchObject({ kind: 'air', active: false })
  })
})

describe('reconnect', () => {
  it('reconnects after the connection drops and resubscribes to previously requested streams', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket, reconnect: { minDelayMs: 20, maxDelayMs: 50 } })
    await client.connect()
    client.subscribe(['taps'])
    await new Promise((r) => setTimeout(r, 20))

    let reconnecting = false
    const reconnected = new Promise<void>((resolve) => client.once('reconnected', () => resolve()))
    client.once('reconnecting', () => {
      reconnecting = true
    })

    const subscribesAfterDrop: unknown[] = []
    daemon.onMessage = (_c, m) => {
      if (m.type === 'subscribe') subscribesAfterDrop.push(m)
    }

    // simulate the daemon dropping the connection (e.g. it restarted)
    for (const c of daemon.clients) c.close()

    await reconnected
    expect(reconnecting).toBe(true)
    expect(client.connected).toBe(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(subscribesAfterDrop).toContainEqual({ type: 'subscribe', streams: ['taps'] })
  })

  it('does not reconnect after an explicit disconnect()', async () => {
    client = new GhostkeysClient({ url: daemon.url, webSocket, reconnect: { minDelayMs: 20, maxDelayMs: 50 } })
    await client.connect()
    let reconnecting = false
    client.on('reconnecting', () => {
      reconnecting = true
    })
    client.disconnect()
    await new Promise((r) => setTimeout(r, 100))
    expect(reconnecting).toBe(false)
    expect(client.connected).toBe(false)
  })
})

describe('connection failure cleanup', () => {
  // Regression test: a connection refused (or otherwise failing) before "open" used to leave the
  // hello-wait timer running. connect() had already rejected via the socket-open failure path, so
  // nothing was left awaiting that timer; when it eventually fired its own rejection, that became
  // an unhandled promise rejection, up to helloTimeoutMs after the fact.
  it('rejects promptly on connection refused, and never produces an unhandled rejection from the orphaned hello-wait', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      // Start and immediately close a fake daemon: guarantees nothing is listening on this port.
      const dead = await FakeDaemon.start(testConfig())
      const url = dead.url
      await dead.close()

      const badClient = new GhostkeysClient({ url, webSocket, reconnect: false, helloTimeoutMs: 300 })
      const start = Date.now()
      await expect(badClient.connect()).rejects.toThrow()
      const elapsed = Date.now() - start
      // A connection-refused failure should surface immediately, well before the 300ms hello timeout -
      // proving it took the "socket never opened" path, not "opened, then hello never arrived".
      expect(elapsed).toBeLessThan(250)

      // If the hello-wait timer had leaked, it would fire (as an unhandled rejection) around now.
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    expect(unhandled).toEqual([])
  })
})
