import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { GhostkeysClient } from '../src/client.js'
import { readGhostkeysToken, tokenFilePaths } from '../src/token.js'
import type { WebSocketCtor } from '../src/ws.js'
import { FakeDaemon } from './fake-server.js'
import { testConfig } from './fixtures.js'

const webSocket = NodeWebSocket as unknown as WebSocketCtor
const TOKEN = 'a'.repeat(64)

let client: GhostkeysClient | undefined
let tempDir: string | undefined

afterEach(async () => {
  client?.disconnect()
  client = undefined
  delete process.env.GHOSTKEYS_TOKEN
  delete process.env.GHOSTKEYS_CONFIG_DIR
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
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

  it('auto-detects the token from $GHOSTKEYS_CONFIG_DIR/token with no explicit token option', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ghostkeys-token-test-'))
    await writeFile(path.join(tempDir, 'token'), TOKEN, 'utf8')
    process.env.GHOSTKEYS_CONFIG_DIR = tempDir

    const daemon = await FakeDaemon.start(testConfig())
    daemon.requiredToken = TOKEN
    client = new GhostkeysClient({ url: daemon.url, webSocket })
    await expect(client.connect()).resolves.toMatchObject({ type: 'hello' })
    expect(daemon.handshakeHeaders[0]!['x-ghostkeys-token']).toBe(TOKEN)
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
    // Falls through to the token files, none of which exist at this made-up path; either way it
    // must not return the too-short env value.
    process.env.GHOSTKEYS_CONFIG_DIR = '/nonexistent/ghostkeys-config-dir-for-tests'
    const token = await readGhostkeysToken()
    expect(token).not.toBe('too-short')
  })

  it('trims surrounding whitespace from the environment token', async () => {
    process.env.GHOSTKEYS_TOKEN = `  ${'c'.repeat(32)}  `
    await expect(readGhostkeysToken()).resolves.toBe('c'.repeat(32))
  })

  it('reads the token from $GHOSTKEYS_CONFIG_DIR/token when the env var token is absent', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ghostkeys-token-test-'))
    await writeFile(path.join(tempDir, 'token'), `${'d'.repeat(40)}\n`, 'utf8')
    process.env.GHOSTKEYS_CONFIG_DIR = tempDir
    await expect(readGhostkeysToken()).resolves.toBe('d'.repeat(40))
  })

  it('prefers GHOSTKEYS_TOKEN over a $GHOSTKEYS_CONFIG_DIR/token file', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ghostkeys-token-test-'))
    await writeFile(path.join(tempDir, 'token'), 'e'.repeat(40), 'utf8')
    process.env.GHOSTKEYS_CONFIG_DIR = tempDir
    process.env.GHOSTKEYS_TOKEN = 'f'.repeat(32)
    await expect(readGhostkeysToken()).resolves.toBe('f'.repeat(32))
  })

  it('ignores an empty $GHOSTKEYS_CONFIG_DIR/token file and falls through', async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ghostkeys-token-test-'))
    await writeFile(path.join(tempDir, 'token'), '   \n', 'utf8')
    process.env.GHOSTKEYS_CONFIG_DIR = tempDir
    // Nothing else exists at this made-up config dir and there's no env token, so this should not throw.
    await expect(readGhostkeysToken()).resolves.not.toBe('')
  })
})

describe('tokenFilePaths', () => {
  const join = (...parts: string[]) => parts.join('/')

  it('tries $GHOSTKEYS_CONFIG_DIR/token first, then the daemon/ default, then the legacy path', () => {
    expect(tokenFilePaths('/Users/soham', '/custom/config-dir', join)).toEqual([
      '/custom/config-dir/token',
      '/Users/soham/Library/Application Support/Ghostkeys/daemon/token',
      '/Users/soham/Library/Application Support/Ghostkeys/token'
    ])
  })

  it('omits the config-dir candidate entirely when none is set', () => {
    expect(tokenFilePaths('/Users/soham', undefined, join)).toEqual([
      '/Users/soham/Library/Application Support/Ghostkeys/daemon/token',
      '/Users/soham/Library/Application Support/Ghostkeys/token'
    ])
  })

  it('treats a blank config dir the same as unset', () => {
    expect(tokenFilePaths('/Users/soham', '   ', join)).toEqual([
      '/Users/soham/Library/Application Support/Ghostkeys/daemon/token',
      '/Users/soham/Library/Application Support/Ghostkeys/token'
    ])
  })
})
