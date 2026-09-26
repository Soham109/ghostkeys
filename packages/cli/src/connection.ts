import { GhostkeysClient, type GhostkeysClientEvents, type GhostkeysClientOptions } from '@ghostkeys/sdk'
import { WebSocket } from 'ws'

export interface CreateClientOptions {
  port?: number
  /** Most one-shot commands should not auto-reconnect; `gk watch` overrides this. */
  reconnect?: GhostkeysClientOptions['reconnect']
}

export function createClient(opts: CreateClientOptions = {}): GhostkeysClient {
  return new GhostkeysClient({
    url: opts.port ? `ws://127.0.0.1:${opts.port}/` : undefined,
    webSocket: WebSocket as unknown as GhostkeysClientOptions['webSocket'],
    reconnect: opts.reconnect ?? false
  })
}

/** Resolves with the next `event`, or `undefined` if none arrives within `timeoutMs`. */
export function waitFor<K extends keyof GhostkeysClientEvents>(
  client: GhostkeysClient,
  event: K,
  timeoutMs = 2000
): Promise<GhostkeysClientEvents[K] | undefined> {
  return new Promise((resolve) => {
    const off = client.once(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
    const timer = setTimeout(() => {
      off()
      resolve(undefined)
    }, timeoutMs)
  })
}

export function daemonPortHint(port?: number): number {
  return port ?? 47823
}
