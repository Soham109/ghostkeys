import { createHash } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AppMessage, Config } from '../src/protocol/types.js'

/**
 * A tiny in-process stand-in for ghostkeysd. It listens on 127.0.0.1 on an OS-assigned port,
 * speaks exactly the frames docs/PROTOCOL.md describes for the handful of flows the SDK's tests
 * exercise, and lets a test script the rest by handling `onMessage` itself. It does not implement
 * real gesture detection, calibration training or actions: it's a protocol double, not a daemon
 * clone.
 */
export class FakeDaemon {
  readonly wss: WebSocketServer
  readonly clients = new Set<WebSocket>()
  url = ''
  config: Config
  paused = false
  /** Extra handler a test can set to react to specific incoming message types. */
  onMessage: ((client: WebSocket, message: any) => void) | null = null
  /** When false, greet() sends nothing on connect (used to test connect() timing out). */
  autoGreet = true
  /** When set, only handshakes carrying this exact X-Ghostkeys-Token header are accepted (PROTOCOL.md "Authentication"). */
  requiredToken: string | null = null
  /** Every handshake's headers, most recent last: lets a test assert what the client actually sent. */
  handshakeHeaders: Record<string, string | string[] | undefined>[] = []
  private calibrationTarget = 20
  private approvedHashes = new Set<string>()

  private constructor(wss: WebSocketServer, config: Config) {
    this.wss = wss
    this.config = config
  }

  static async start(config: Config): Promise<FakeDaemon> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve())
      wss.once('error', reject)
    })
    const daemon = new FakeDaemon(wss, config)
    const address = wss.address()
    if (typeof address === 'object' && address) daemon.url = `ws://127.0.0.1:${address.port}/`
    wss.on('connection', (ws, request) => {
      daemon.handshakeHeaders.push({ ...request.headers })
      if (daemon.requiredToken !== null && request.headers['x-ghostkeys-token'] !== daemon.requiredToken) {
        ws.close(1008, 'invalid token')
        return
      }
      daemon.handleConnection(ws)
    })
    return daemon
  }

  async close(): Promise<void> {
    for (const c of this.clients) c.close()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  broadcast(message: unknown): void {
    const data = JSON.stringify(message)
    for (const c of this.clients) if (c.readyState === c.OPEN) c.send(data)
  }

  send(client: WebSocket, message: unknown): void {
    if (client.readyState === client.OPEN) client.send(JSON.stringify(message))
  }

  private handleConnection(ws: WebSocket): void {
    this.clients.add(ws)
    ws.on('close', () => this.clients.delete(ws))
    if (this.autoGreet) this.greet(ws)
    ws.on('message', (data) => {
      let message: AppMessage
      try {
        message = JSON.parse(data.toString())
      } catch {
        this.send(ws, { type: 'error', message: 'invalid JSON' })
        return
      }
      this.handleMessage(ws, message)
    })
  }

  private greet(ws: WebSocket): void {
    this.send(ws, this.hello())
    this.send(ws, this.status())
    this.send(ws, { type: 'config', config: this.config })
  }

  hello() {
    return {
      type: 'hello' as const,
      version: '0.1.0-fake',
      device: { model: 'Mac17,8', chip: 'Apple M5 Pro', family: 'macbook-pro-14' },
      sensors: { imu: true, gyro: true, lid: true, light: true, sound: false, camera: false },
      permissions: { accessibility: false, microphone: 'not_determined' as const, camera: 'not_determined' as const }
    }
  }

  status() {
    return {
      type: 'status' as const,
      paused: this.paused,
      pausedReason: this.paused ? ('user' as const) : null,
      calibrated: true,
      zones: this.config.zones.map((z) => z.id),
      imuHz: 797,
      detector: { noiseFloorMg: 1.2, thresholdMg: 17.5, level: 3.1 }
    }
  }

  private handleMessage(ws: WebSocket, message: AppMessage): void {
    this.onMessage?.(ws, message)
    switch (message.type) {
      case 'pause':
        this.paused = true
        this.broadcast(this.status())
        break
      case 'resume':
        this.paused = false
        this.broadcast(this.status())
        break
      case 'config_get':
        this.send(ws, { type: 'config', config: this.config })
        break
      case 'config_set':
        this.config = message.config
        this.broadcast({ type: 'config', config: this.config })
        break
      case 'test_action':
        this.broadcast({
          type: 'action',
          t: 1,
          bindingId: null,
          label: (message.action as any).label ?? 'Test',
          ok: true,
          error: null
        })
        break
      case 'request_permission':
        this.broadcast(this.hello())
        break
      case 'calibration_start':
        this.calibrationTarget = message.target
        this.broadcast({ type: 'calibration', phase: 'started', zones: message.zones, target: message.target })
        break
      case 'calibration_zone':
        // Real hardware would take many taps to reach `target`; this double just declares the
        // zone captured immediately so integration tests stay fast and deterministic. The state
        // machine's handling of the intermediate counts is covered by calibration.test.ts against
        // a scripted transport instead.
        this.broadcast({ type: 'calibration', phase: 'capturing', zone: message.zone, count: this.calibrationTarget, target: this.calibrationTarget })
        break
      case 'calibration_negatives':
        this.broadcast({ type: 'calibration', phase: 'negatives', secondsLeft: 0 })
        break
      case 'calibration_finish':
        this.broadcast({ type: 'calibration', phase: 'training' })
        this.broadcast({
          type: 'calibration',
          phase: 'done',
          accuracy: { 'right-grille': 0.97 },
          overall: 0.95,
          confusion: [[1]],
          labels: ['right-grille']
        })
        break
      case 'calibration_cancel':
        this.broadcast({ type: 'calibration', phase: 'cancelled' })
        break
      case 'approve_action': {
        const hash = FakeDaemon.actionHash(message.action)
        this.approvedHashes.add(hash)
        this.send(ws, { type: 'approved', hash, kind: (message.action as { kind?: string }).kind ?? null })
        break
      }
      case 'revoke_action': {
        const hash = 'hash' in message ? message.hash : FakeDaemon.actionHash(message.action)
        const found = this.approvedHashes.delete(hash)
        this.send(ws, { type: 'revoked', hash, found })
        break
      }
      case 'catalog_get':
        this.send(ws, { type: 'catalog', catalog: { apps: ['excel'], commands: ['wrap-iferror'], unsupported: {} } })
        break
      case 'sound_session_start':
        this.broadcast({ type: 'session', kind: 'sound', active: true, secondsLeft: message.seconds ?? 30 })
        break
      case 'sound_session_stop':
        this.broadcast({ type: 'session', kind: 'sound', active: false, secondsLeft: 0, reason: 'requested' })
        break
      case 'air_session_start':
        this.broadcast({ type: 'session', kind: 'air', active: true, secondsLeft: message.seconds ?? 30 })
        break
      case 'air_session_stop':
        this.broadcast({ type: 'session', kind: 'air', active: false, secondsLeft: 0, reason: 'requested' })
        break
      default:
        break
    }
  }

  /** Mirrors ApprovalStore.hash: SHA-256 of the action's canonical JSON without approvedHash/label/delayMs. */
  private static actionHash(action: unknown): string {
    const clone: Record<string, unknown> = { ...(action as Record<string, unknown>) }
    delete clone.approvedHash
    delete clone.label
    delete clone.delayMs
    return createHash('sha256').update(JSON.stringify(clone, Object.keys(clone).sort())).digest('hex')
  }
}
