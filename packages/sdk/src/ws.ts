/**
 * The slice of the browser WebSocket API the client needs. Both the global `WebSocket` (browser,
 * and Node 22+) and the `ws` package's `WebSocket` class implement this shape, so either can be
 * used interchangeably as `GhostkeysClientOptions.webSocket`.
 */
export interface WebSocketLike {
  readyState: number
  onopen: ((this: WebSocketLike, ev: unknown) => void) | null
  onmessage: ((this: WebSocketLike, ev: { data: unknown }) => void) | null
  onclose: ((this: WebSocketLike, ev: { code?: number; reason?: string }) => void) | null
  onerror: ((this: WebSocketLike, ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface WebSocketConnectOptions {
  /**
   * Extra handshake headers, e.g. `X-Ghostkeys-Token` (see docs/PROTOCOL.md "Authentication").
   * Only a Node-capable implementation (the `ws` package) can actually send these: the browser
   * `WebSocket` API has no way to set request headers, by spec, so a real browser page can never
   * authenticate to ghostkeysd. The daemon also rejects any handshake that carries an `Origin`
   * header, which every browser sends unconditionally and `ws` does not send unless explicitly
   * configured to - so this client never sets one.
   */
  headers?: Record<string, string>
}

/**
 * A WebSocket constructor. The 2-argument browser/Node-global form is a subtype of this (extra
 * constructor arguments are simply ignored by spec-compliant WebSocket implementations), so this
 * type covers both `ws`'s `new WebSocket(url, protocols, options)` and the plain global one.
 */
export type WebSocketCtor = new (url: string, protocols?: string | string[], options?: WebSocketConnectOptions) => WebSocketLike

export const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3
} as const

/**
 * Resolves a WebSocket constructor: an explicit one wins; otherwise a dynamic `import('ws')` is
 * preferred over the global `WebSocket` (browser, or Node 22+), because ghostkeysd requires an
 * `X-Ghostkeys-Token` handshake header that only `ws` (or another Node-capable implementation) can
 * actually send - the spec-compliant global `WebSocket` has no API for custom headers at all. The
 * dynamic import keeps `ws` an optional dependency: a bundler that never resolves it just fails the
 * import, and this file has no eager static import of it.
 */
export async function resolveWebSocketCtor(explicit?: WebSocketCtor): Promise<WebSocketCtor> {
  if (explicit) return explicit
  try {
    const mod: any = await import('ws')
    const ctor = mod.default ?? mod.WebSocket
    if (typeof ctor === 'function') return ctor as WebSocketCtor
  } catch {
    // fall through: no `ws` installed (likely a browser bundle) - try the global instead.
  }
  const g = globalThis as unknown as { WebSocket?: WebSocketCtor }
  if (typeof g.WebSocket === 'function') return g.WebSocket
  throw new Error(
    'no WebSocket implementation found: pass { webSocket } to GhostkeysClient, or run on a runtime with a ' +
      'global WebSocket, or `pnpm add ws` for Node'
  )
}
