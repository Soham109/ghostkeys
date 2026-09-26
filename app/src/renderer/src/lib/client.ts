import type { AppMessage, DaemonMessage, DaemonMessageType, Stream } from '@shared/protocol'
import type { ConnState } from '@shared/ipc'

export type { ConnState }
type MsgOf<T extends DaemonMessageType> = Extract<DaemonMessage, { type: T }>
type Listener = (m: DaemonMessage) => void

/**
 * Typed client for ghostkeysd. The renderer never opens the socket itself: a browser WebSocket
 * carries an Origin header, which the daemon rejects. The main process holds the connection
 * (with the session token) and relays frames over IPC. Stream subscriptions are reference
 * counted and replayed whenever the connection comes back.
 */
export class GhostkeysClient {
  private listeners = new Map<string, Set<Listener>>()
  private stateListeners = new Set<(s: ConnState) => void>()
  private streamRefs = new Map<Stream, number>()
  private started = false
  state: ConnState = 'connecting'

  start(initial: ConnState, snapshot: DaemonMessage[]): void {
    if (this.started) return
    this.started = true
    window.gk.onMessage((msg) => this.dispatch(msg))
    window.gk.onConn((s) => this.setState(s))
    this.setState(initial)
    snapshot.forEach((m) => this.dispatch(m))
  }

  /** Screenshot mode only: feed a message through as if the daemon sent it. */
  inject(msg: DaemonMessage): void {
    this.dispatch(msg)
  }

  private dispatch(msg: DaemonMessage): void {
    this.listeners.get(msg.type)?.forEach((l) => l(msg))
    this.listeners.get('*')?.forEach((l) => l(msg))
  }

  private setState(s: ConnState): void {
    const was = this.state
    this.state = s
    if (s === 'open' && was !== 'open') {
      const streams = [...this.streamRefs.keys()]
      if (streams.length) window.gk.send({ type: 'subscribe', streams })
      window.gk.send({ type: 'config_get' })
    }
    if (s !== was) this.stateListeners.forEach((l) => l(s))
  }

  /** Ask the main process to skip its backoff and try again now. */
  retryNow(): void {
    window.gk.reconnect()
  }

  send(msg: AppMessage): boolean {
    if (this.state !== 'open') return false
    window.gk.send(msg)
    return true
  }

  on<T extends DaemonMessageType>(type: T, cb: (m: MsgOf<T>) => void): () => void
  on(type: '*', cb: (m: DaemonMessage) => void): () => void
  on(type: string, cb: (m: never) => void): () => void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(cb as Listener)
    this.listeners.set(type, set)
    return () => set.delete(cb as Listener)
  }

  onState(cb: (s: ConnState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  /** Subscribe to streams; returns the matching unsubscribe. Reference counted across callers. */
  subscribe(streams: Stream[]): () => void {
    const fresh = streams.filter((s) => (this.streamRefs.get(s) ?? 0) === 0)
    streams.forEach((s) => this.streamRefs.set(s, (this.streamRefs.get(s) ?? 0) + 1))
    if (fresh.length) this.send({ type: 'subscribe', streams: fresh })
    let done = false
    return () => {
      if (done) return
      done = true
      const gone: Stream[] = []
      streams.forEach((s) => {
        const n = (this.streamRefs.get(s) ?? 1) - 1
        if (n <= 0) {
          this.streamRefs.delete(s)
          gone.push(s)
        } else this.streamRefs.set(s, n)
      })
      if (gone.length) this.send({ type: 'unsubscribe', streams: gone })
    }
  }
}

export const client = new GhostkeysClient()
