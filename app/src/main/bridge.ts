import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { parseDaemonMessage, type AppMessage, type Config, type DaemonMessage, type SessionMsg } from '@shared/protocol'
import type { ConnState } from '@shared/ipc'

export const TOKEN_HEADER = 'X-Ghostkeys-Token'

/**
 * The app's only connection to the daemon. Node's `ws` sends no Origin header (the daemon rejects
 * any handshake that has one) and adds the per-launch session token. Messages are relayed to the
 * renderer over IPC; the tray and HUD also listen here, so they work with the window closed.
 */
export class DaemonBridge extends EventEmitter {
  private ws: WebSocket | null = null
  private retry = 300
  private timer: NodeJS.Timeout | null = null
  /** True until start(); reconnectNow() before that must not open a second socket. */
  private closed = true
  state: ConnState = 'connecting'
  paused = false
  pausedReason: string | null = null
  sessions: { sound?: SessionMsg; air?: SessionMsg } = {}
  config: Config | null = null
  hello: DaemonMessage | null = null
  status: DaemonMessage | null = null

  constructor(
    private readonly port: number,
    private readonly token: () => string | null
  ) {
    super()
  }

  get connected(): boolean {
    return this.state === 'open'
  }

  start(): void {
    if (!this.closed) return
    this.closed = false
    this.open()
  }

  private setState(s: ConnState): void {
    if (s === this.state) return
    this.state = s
    this.emit('conn', s)
    this.emit('change')
  }

  private open(): void {
    if (this.closed) return
    this.setState('connecting')
    const token = this.token()
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/`, {
      headers: token ? { [TOKEN_HEADER]: token } : {},
      handshakeTimeout: 3000,
      perMessageDeflate: false
    })
    this.ws = ws
    ws.on('open', () => {
      this.retry = 300
      this.setState('open')
    })
    ws.on('message', (data) => {
      const msg = parseDaemonMessage(String(data))
      if (msg) this.onMessage(msg)
    })
    ws.on('unexpected-response', (_req, res) => {
      console.error(`[bridge] handshake refused: HTTP ${res.statusCode}`)
    })
    ws.on('close', () => {
      this.ws = null
      this.sessions = {}
      this.setState('closed')
      this.schedule()
    })
    ws.on('error', () => {
      // 'close' follows and schedules the retry
    })
  }

  private schedule(): void {
    if (this.closed || this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, this.retry)
    this.retry = Math.min(Math.round(this.retry * 1.7), 4000)
  }

  reconnectNow(): void {
    if (this.connected || this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.retry = 300
    if (!this.ws) this.open()
  }

  private onMessage(msg: DaemonMessage): void {
    if (msg.type === 'status') {
      this.paused = msg.paused
      this.pausedReason = msg.pausedReason ?? null
      this.status = msg
      this.emit('change')
    } else if (msg.type === 'config') {
      this.config = msg.config
    } else if (msg.type === 'hello') {
      this.hello = msg
    } else if (msg.type === 'session') {
      this.sessions[msg.kind === 'sound' ? 'sound' : 'air'] = msg
      this.emit('change')
    }
    this.emit('message', msg)
  }

  send(msg: AppMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false
    this.ws.send(JSON.stringify(msg))
    return true
  }

  snapshot(): DaemonMessage[] {
    if (!this.connected) return []
    const out: DaemonMessage[] = []
    if (this.hello) out.push(this.hello)
    if (this.status) out.push(this.status)
    if (this.config) out.push({ type: 'config', config: this.config })
    for (const m of Object.values(this.sessions)) if (m) out.push(m)
    return out
  }

  stop(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
  }
}
