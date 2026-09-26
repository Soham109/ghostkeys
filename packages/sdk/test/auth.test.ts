import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { GhostkeysClient } from '../src/client.js'
import { readGhostkeysToken } from '../src/token.js'
import type { WebSocketCtor } from '../src/ws.js'
import { FakeDaemon } from './fake-server.js'
import { testConfig } from './fixtures.js'

const webSocket = NodeWebSocket as unknown as WebSocketCtor
const TOKEN = 'a'.repeat(64)

let client: GhostkeysClient | undefined

afterEach(() => {
  client?.disconnect()
  client = undefined
  delete process.env.GHOSTKEYS_TOKEN
})

describe('X-Ghostkeys-Token handshake header', () => {
  it('sends the configured token as X-Ghostkeys-Token, and no Origin header', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    client = new GhostkeysClient({ url: daemon.url, webSocket, token: TOKEN })
    await client.connect()
    expect(daemon.handshakeHeaders).toHaveLength(1)
    expect(daemon.handshakeHeaders[0]!['x-ghostkeys-token']).toBe(TOKEN)
    // The daemon rejects any handshake carrying an Origin header (that's how it tells a browser
    // page apart from this SDK); this asserts the client never sends one in the first place.
    expect(daemon.handshakeHeaders[0]!.origin).toBeUndefined()
    await daemon.close()
  })

  it('is rejected when the daemon requires a token this client does not send', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    daemon.requiredToken = TOKEN
    // token: null means "send nothing", overriding the default env/file auto-detection.
    client = new GhostkeysClient({ url: daemon.url, webSocket, token: null, reconnect: false, helloTimeoutMs: 500 })
    await expect(client.connect()).rejects.toThrow()
    await daemon.close()
  })

  it('is rejected when the token is wrong', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    daemon.requiredToken = TOKEN
    client = new GhostkeysClient({ url: daemon.url, webSocket, token: 'wrong-token-value-00000000000000', reconnect: false, helloTimeoutMs: 500 })
    await expect(client.connect()).rejects.toThrow()
    await daemon.close()
  })

  it('connects once the correct token is presented', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    daemon.requiredToken = TOKEN
    client = new GhostkeysClient({ url: daemon.url, webSocket, token: TOKEN })
    const hello = await client.connect()
    expect(hello.type).toBe('hello')
    await daemon.close()
  })

  it('falls back to no token when GHOSTKEYS_TOKEN is unset and no token file exists (test env)', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    // No `token` option at all: exercises the default auto-detection path end to end. Whether that
    // resolves to a token or not depends on this machine (a real ghostkeysd may have left a token
    // file in ~/Library/Application Support/Ghostkeys/, e.g. from a manual smoke test), which this
    // test deliberately does not assume either way: it only asserts that auto-detection never
    // throws and never blocks connecting to a daemon that doesn't require a token, whatever it finds.
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await expect(client.connect()).resolves.toMatchObject({ type: 'hello' })
    await daemon.close()
  })
})

describe('readGhostkeysToken', () => {
  it('accepts GHOSTKEYS_TOKEN when it is at least 32 characters', async () => {
    process.env.GHOSTKEYS_TOKEN = 'b'.repeat(32)
    await expect(readGhostkeysToken()).resolves.toBe('b'.repeat(32))
  })

  it('ignores GHOSTKEYS_TOKEN shorter than 32 characters', async () => {
    process.env.GHOSTKEYS_TOKEN = 'too-short'
    // Falls through to the token file, which does not exist for this test user/run; either way it
    // must not return the too-short env value.
    const token = await readGhostkeysToken()
    expect(token).not.toBe('too-short')
  })

  it('trims surrounding whitespace from the environment token', async () => {
    process.env.GHOSTKEYS_TOKEN = `  ${'c'.repeat(32)}  `
    await expect(readGhostkeysToken()).resolves.toBe('c'.repeat(32))
  })
})
