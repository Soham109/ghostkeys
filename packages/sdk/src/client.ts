import { CalibrationFlow, type CalibrationFlowOptions } from './calibration.js'
import { TypedEmitter, type Unsubscribe } from './emitter.js'
import { configRevision } from './hash.js'
import { ConfigConflictError, GhostkeysProtocolError, GhostkeysTimeoutError, NotConnectedError } from './errors.js'
import { daemonMessageSchemaByType } from './protocol/schemas.js'
import { readGhostkeysToken } from './token.js'
import {
  DEFAULT_URL,
  type Action,
  type ActionMsg,
  type AppMessage,
  type CalibrationMsg,
  type Config,
  type ConfigMsg,
  type DaemonMessage,
  type DaemonMessageOf,
  type DaemonMessageType,
  type HelloMsg,
  type IntegrationCatalog,
  type StatusMsg,
  type Stream,
  type TestActionInput
} from './protocol/types.js'
import { resolveWebSocketCtor, WS_READY_STATE, type WebSocketCtor, type WebSocketLike } from './ws.js'

export interface ReconnectOptions {
  /** Delay before the first reconnect attempt, in ms. Default 300. */
  minDelayMs?: number
  /** Cap on the backoff delay, in ms. Default 10000. */
  maxDelayMs?: number
  /** Give up after this many consecutive failed attempts. Default Infinity (never give up). */
  maxAttempts?: number
}

export interface GhostkeysClientOptions {
  /** Default ws://127.0.0.1:47823/ — the daemon only ever binds to loopback. */
  url?: string
  /** Explicit WebSocket constructor (e.g. `ws`'s `WebSocket`, or a fake for tests). See ws.ts. */
  webSocket?: WebSocketCtor
  /**
   * The `X-Ghostkeys-Token` handshake header (docs/PROTOCOL.md "Authentication"). Defaults to
   * `GHOSTKEYS_TOKEN` from the environment, then the token ghostkeysd wrote to
   * `~/Library/Application Support/Ghostkeys/token` on this launch (re-read on every connection
   * attempt, since a restarted daemon writes a new one). Pass `null` to send no token at all, e.g.
   * against a test double that doesn't check it.
   */
  token?: string | null
  /** true (default) for exponential backoff with default bounds, false to disable, or tuned bounds. */
  reconnect?: boolean | ReconnectOptions
  /** How long request helpers (pause, getConfig, testAction, ...) wait for a reply. Default 5000ms. */
  requestTimeoutMs?: number
  /** How long connect() waits for the daemon's `hello`. Defaults to requestTimeoutMs. */
  helloTimeoutMs?: number
}

type DaemonEvents = { [K in DaemonMessageType]: DaemonMessageOf<K> }

export interface GhostkeysClientEvents extends DaemonEvents {
  open: undefined
  connect: HelloMsg
  reconnecting: { attempt: number; delayMs: number }
  reconnected: HelloMsg
  disconnect: { code?: number; reason?: string; willReconnect: boolean }
  socketError: unknown
  /** A frame arrived that isn't valid per docs/PROTOCOL.md (unknown type, or failed schema validation). */
  protocolError: { raw: string; issue: unknown }
}

type EventName = keyof GhostkeysClientEvents

const DEFAULT_RECONNECT: Required<ReconnectOptions> = { minDelayMs: 300, maxDelayMs: 10_000, maxAttempts: Infinity }

/**
 * A WebSocket client for ghostkeysd (docs/PROTOCOL.md). Auto-reconnects with backoff, re-subscribes
 * to streams after a reconnect, validates every incoming frame with zod, and wraps the request/reply
 * message pairs (pause/resume, config_get/config_set, test_action, calibration_*) as promises.
 *
 * ```ts
 * const client = new GhostkeysClient()
 * client.on('gesture', (g) => console.log(g.gesture, g.zone))
 * await client.connect()
 * client.subscribe(['taps'])
 * ```
 */
export class GhostkeysClient {
  private readonly url: string
  private readonly explicitWebSocket?: WebSocketCtor
  private readonly explicitToken: string | null | undefined
  private readonly reconnectOptions: Required<ReconnectOptions> | null
  private readonly requestTimeoutMs: number
  private readonly helloTimeoutMs: number

  private readonly emitter = new TypedEmitter<GhostkeysClientEvents>()
  /**
   * A separate channel for config replies that getConfig()/setConfig() wait on, distinct from the
   * public 'config' event on `emitter` (which every config message, including the post-connect
   * greeting, is still published to). The greeting config is deliberately never routed here: see
   * the comment on `greetConfigSeen` in trackState().
   */
  private readonly configReplyEmitter = new TypedEmitter<{ reply: ConfigMsg }>()
  private ws: WebSocketLike | null = null
  private manualClose = false
  private connectPromise: Promise<HelloMsg> | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private outgoingQueue: AppMessage[] = []
  private readonly desiredStreams = new Set<Stream>()
  /** Reset per physical connection in openSocket(); see trackState(). */
  private greetConfigSeen = false

  private _lastHello?: HelloMsg
  private _lastStatus?: StatusMsg
  private _lastConfig?: Config
  private _lastConfigRevision?: string

  constructor(options: GhostkeysClientOptions = {}) {
    this.url = options.url ?? DEFAULT_URL
    this.explicitWebSocket = options.webSocket
    this.explicitToken = options.token
    this.reconnectOptions = options.reconnect === false ? null : { ...DEFAULT_RECONNECT, ...(options.reconnect === true || options.reconnect === undefined ? {} : options.reconnect) }
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000
    this.helloTimeoutMs = options.helloTimeoutMs ?? this.requestTimeoutMs
  }

  // ---------------------------------------------------------------------
  // Connection state
  // ---------------------------------------------------------------------

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WS_READY_STATE.OPEN
  }

  get lastHello(): HelloMsg | undefined {
    return this._lastHello
  }

  get lastStatus(): StatusMsg | undefined {
    return this._lastStatus
  }

  get lastConfig(): Config | undefined {
    return this._lastConfig
  }

  /** Fingerprint of the last config seen (from getConfig, a config_set reply, or a broadcast). Use with setConfig's ifRevision. */
  get lastConfigRevision(): string | undefined {
    return this._lastConfigRevision
  }

  /** Connects (or returns the in-flight connect promise) and resolves once the daemon's `hello` arrives. */
  async connect(): Promise<HelloMsg> {
    if (this.connectPromise) return this.connectPromise
    this.manualClose = false
    this.reconnectAttempt = 0
    this.connectPromise = this.openSocket(false).finally(() => {
      this.connectPromise = null
    })
    const hello = await this.connectPromise
    this.emitter.emit('connect', hello)
    return hello
  }

  /** Closes the connection and disables auto-reconnect for this disconnect. */
  disconnect(): void {
    this.manualClose = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close(1000, 'client disconnect')
    this.ws = null
  }

  on<K extends EventName>(event: K, listener: (payload: GhostkeysClientEvents[K]) => void): Unsubscribe {
    return this.emitter.on(event, listener)
  }

  once<K extends EventName>(event: K, listener: (payload: GhostkeysClientEvents[K]) => void): Unsubscribe {
    return this.emitter.once(event, listener)
  }

  off<K extends EventName>(event: K, listener: (payload: GhostkeysClientEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  /** Low-level escape hatch: sends any app -> daemon message, queuing it if not connected yet. */
  send(message: AppMessage): void {
    if (this.ws && this.ws.readyState === WS_READY_STATE.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      this.outgoingQueue.push(message)
    }
  }

  // ---------------------------------------------------------------------
  // Streams
  // ---------------------------------------------------------------------

  /** Subscribes to one or more of "imu" | "lid" | "light" | "taps". Persists across reconnects. */
  subscribe(streams: Stream[]): void {
    for (const s of streams) this.desiredStreams.add(s)
    this.send({ type: 'subscribe', streams })
  }

  unsubscribe(streams: Stream[]): void {
    for (const s of streams) this.desiredStreams.delete(s)
    this.send({ type: 'unsubscribe', streams })
  }

  // ---------------------------------------------------------------------
  // Request/reply helpers
  // ---------------------------------------------------------------------

  async pause(): Promise<StatusMsg> {
    const wait = this.awaitEvent('status', (msg) => msg.paused === true, 'pause to be acknowledged')
    this.send({ type: 'pause' })
    return wait
  }

  async resume(): Promise<StatusMsg> {
    const wait = this.awaitEvent('status', (msg) => msg.paused === false, 'resume to be acknowledged')
    this.send({ type: 'resume' })
    return wait
  }

  /**
   * Fetches the current config. Correlated via `configReplyEmitter` (see trackState()), which never
   * fires for the one `config` message the daemon sends unprompted right after connecting - so this
   * cannot be accidentally satisfied by that greeting, even if getConfig() is called immediately
   * after connect(). It can still, in principle, resolve with a `config` broadcast triggered by
   * another connected client's own `config_set` landing at the same moment instead of the direct
   * reply to this `config_get`: the wire protocol has no per-request correlation id to rule that
   * out. That race needs two clients mutating config within the same instant to matter, which
   * normal CLI/app usage won't hit in practice.
   */
  async getConfig(): Promise<{ config: Config; revision: string }> {
    const wait = this.awaitConfigReply('config_get reply')
    this.send({ type: 'config_get' })
    const msg = await wait
    return { config: msg.config, revision: configRevision(msg.config) }
  }

  /**
   * Saves a new config. Pass `ifRevision` (from a prior getConfig()/setConfig() call) to guard
   * against clobbering a change made elsewhere since you last read the config: if the client's
   * current revision no longer matches, this throws `ConfigConflictError` without sending
   * anything, so you can getConfig() again and re-apply your change on top of the latest one.
   */
  async setConfig(config: Config, opts: { ifRevision?: string } = {}): Promise<{ config: Config; revision: string }> {
    if (opts.ifRevision !== undefined && opts.ifRevision !== this._lastConfigRevision) {
      throw new ConfigConflictError(opts.ifRevision, this._lastConfigRevision)
    }
    const wait = new Promise<{ config: Config; revision: string }>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        offReply()
        offError()
      }
      const offReply = this.configReplyEmitter.on('reply', (msg) => {
        cleanup()
        resolve({ config: msg.config, revision: configRevision(msg.config) })
      })
      const offError = this.emitter.on('error', (msg) => {
        cleanup()
        reject(new GhostkeysProtocolError(msg.message))
      })
      const timer = setTimeout(() => {
        cleanup()
        reject(new GhostkeysTimeoutError('config_set reply', this.requestTimeoutMs))
      }, this.requestTimeoutMs)
    })
    this.send({ type: 'config_set', config })
    return wait
  }

  /**
   * Runs an action once, outside of any binding. Matches the reply by `bindingId === null` (how
   * the daemon marks test_action results), which is a good heuristic but not a true correlation
   * id: the protocol has none. If another client fires its own test_action at the same moment,
   * either reply could resolve this promise first.
   */
  async testAction(action: Action | TestActionInput): Promise<ActionMsg> {
    const wait = this.awaitEvent('action', (msg) => msg.bindingId === null, 'test_action result')
    this.send({ type: 'test_action', action })
    return wait
  }

  /** Prompts for Accessibility permission (AXIsProcessTrustedWithOptions) and resolves with the updated `hello`. */
  async requestAccessibility(): Promise<HelloMsg> {
    const wait = this.awaitEvent('hello', () => true, 'accessibility prompt result')
    this.send({ type: 'request_permission', which: 'accessibility' })
    return wait
  }

  /** Starts a calibration session and returns a `CalibrationFlow` to drive it. */
  async startCalibration(zones: string[], target = 20, options?: CalibrationFlowOptions): Promise<CalibrationFlow> {
    const wait = this.awaitEvent('calibration', (msg): msg is Extract<CalibrationMsg, { phase: 'started' }> => msg.phase === 'started', 'calibration to start')
    this.send({ type: 'calibration_start', zones, target })
    const started = await wait
    return new CalibrationFlow(
      {
        send: (m) => this.send(m),
        onCalibration: (listener) => this.on('calibration', listener)
      },
      started.zones,
      started.target,
      options
    )
  }

  /**
   * Approves a gated action (`open`, `shell`, `applescript` or `shortcut`, including as a macro
   * step) so it can actually run. Call this only after showing the user the exact action (this is
   * what "the app shows a native confirmation" in PROTOCOL.md means) - approving without that
   * defeats the whole point of the gate. Returns the hash to store as the action's `approvedHash`.
   */
  async approveAction(action: Action): Promise<{ hash: string; kind: string | null }> {
    const wait = this.awaitEvent('approved', () => true, 'approve_action reply')
    this.send({ type: 'approve_action', action })
    const msg = await wait
    return { hash: msg.hash, kind: msg.kind }
  }

  /** Revokes a previously approved action, by its hash or by the action itself. */
  async revokeAction(hashOrAction: string | Action): Promise<{ hash: string; found: boolean }> {
    const wait = this.awaitEvent('revoked', () => true, 'revoke_action reply')
    if (typeof hashOrAction === 'string') this.send({ type: 'revoke_action', hash: hashOrAction })
    else this.send({ type: 'revoke_action', action: hashOrAction })
    const msg = await wait
    return { hash: msg.hash, found: msg.found }
  }

  /** The GhostkeysIntegrations catalog of context-aware apps/commands, for building `integration` actions. */
  async getCatalog(): Promise<IntegrationCatalog> {
    const wait = this.awaitEvent('catalog', () => true, 'catalog_get reply')
    this.send({ type: 'catalog_get' })
    const msg = await wait
    return msg.catalog
  }

  /** Starts a short microphone session (optional sound mode: knock_knuckle, rub, wave gestures). */
  async startSoundSession(seconds?: number): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'sound', 'sound session to start')
    this.send({ type: 'sound_session_start', seconds })
    return wait
  }

  async stopSoundSession(): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'sound', 'sound session to stop')
    this.send({ type: 'sound_session_stop' })
    return wait
  }

  /** Starts a short camera session (optional camera add-on: air_tap, pinch/palm/circle gestures). */
  async startAirSession(seconds?: number, camera?: string): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'air', 'camera session to start')
    this.send({ type: 'air_session_start', seconds, camera })
    return wait
  }

  async stopAirSession(): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'air', 'camera session to stop')
    this.send({ type: 'air_session_stop' })
    return wait
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Resolves on the first config reply that isn't the post-connect greeting. See trackState(). */
  private awaitConfigReply(what: string, timeoutMs: number = this.requestTimeoutMs): Promise<ConfigMsg> {
    return new Promise<ConfigMsg>((resolve, reject) => {
      const off = this.configReplyEmitter.on('reply', (msg) => {
        clearTimeout(timer)
        off()
        resolve(msg)
      })
      const timer = setTimeout(() => {
        off()
        reject(new GhostkeysTimeoutError(what, timeoutMs))
      }, timeoutMs)
    })
  }

  private awaitEvent<K extends DaemonMessageType, T extends DaemonMessageOf<K>>(
    event: K,
    predicate: (msg: DaemonMessageOf<K>) => msg is T,
    what: string,
    timeoutMs?: number
  ): Promise<T>
  private awaitEvent<K extends DaemonMessageType>(
    event: K,
    predicate: (msg: DaemonMessageOf<K>) => boolean,
    what: string,
    timeoutMs?: number
  ): Promise<DaemonMessageOf<K>>
  private awaitEvent<K extends DaemonMessageType>(
    event: K,
    predicate: (msg: DaemonMessageOf<K>) => boolean,
    what: string,
    timeoutMs: number = this.requestTimeoutMs
  ): Promise<DaemonMessageOf<K>> {
    return new Promise<DaemonMessageOf<K>>((resolve, reject) => {
      const off = this.emitter.on(event, (msg: any) => {
        if (!predicate(msg)) return
        clearTimeout(timer)
        off()
        resolve(msg)
      })
      const timer = setTimeout(() => {
        off()
        reject(new GhostkeysTimeoutError(what, timeoutMs))
      }, timeoutMs)
    })
  }

  /**
   * Resolves the `X-Ghostkeys-Token` header for this connection attempt. `null` means "send no
   * token" (an explicit choice, e.g. for a test double); `undefined` means "not set", which falls
   * back to readGhostkeysToken() (env var, then the token file). Re-resolved on every attempt
   * (rather than cached) because a restarted daemon writes a new token file.
   */
  private async resolveToken(): Promise<string | undefined> {
    if (this.explicitToken === null) return undefined
    if (this.explicitToken !== undefined) return this.explicitToken
    return readGhostkeysToken()
  }

  private async openSocket(isReconnect: boolean): Promise<HelloMsg> {
    const [Ctor, token] = await Promise.all([resolveWebSocketCtor(this.explicitWebSocket), this.resolveToken()])
    // Never send an Origin header: the daemon rejects any handshake that carries one (that's how it
    // tells a browser page apart from this SDK). `ws` does not add one unless explicitly configured
    // to, so simply not setting `origin` here is what keeps this compliant.
    const headers = token ? { 'X-Ghostkeys-Token': token } : undefined
    const ws = new Ctor(this.url, undefined, headers ? { headers } : undefined)
    this.ws = ws
    this.greetConfigSeen = false

    // The hello-wait has its own timer independent of the "did the socket even open" promise below.
    // If opening fails first, this timer must be cleared immediately (not left to fire up to
    // helloTimeoutMs later into an unhandled rejection) - hence the manual setup instead of
    // awaitEvent(), and the `.catch(() => {})` that marks the promise "handled" the instant it
    // exists, before we necessarily ever get around to `await`-ing it ourselves.
    let helloOff: Unsubscribe | undefined
    let helloTimer: ReturnType<typeof setTimeout> | undefined
    const cleanupHello = () => {
      helloOff?.()
      if (helloTimer) clearTimeout(helloTimer)
    }
    const helloWait = new Promise<HelloMsg>((resolve, reject) => {
      helloOff = this.emitter.on('hello', (msg) => resolve(msg))
      helloTimer = setTimeout(() => reject(new GhostkeysTimeoutError('daemon hello', this.helloTimeoutMs)), this.helloTimeoutMs)
    })
    helloWait.catch(() => {})

    // onmessage must be wired up in the same synchronous tick as the socket is created, before we
    // ever `await` anything: a local daemon (real or fake) can flush its greet frames as part of
    // the same read as the open handshake, and a listener attached after an `await` boundary can
    // miss them entirely (no message queueing happens underneath — it's a plain callback slot).
    ws.onmessage = (ev) => this.handleRawMessage(ev.data)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        ws.onopen = () => {
          settled = true
          resolve()
        }
        ws.onerror = (err) => {
          this.emitter.emit('socketError', err)
          if (!settled) {
            settled = true
            reject(
              err instanceof Error
                ? err
                : new NotConnectedError(
                    'WebSocket error while connecting. If this is ghostkeysd, check the auth token ' +
                      '(GhostkeysClientOptions.token, or GHOSTKEYS_TOKEN in the daemon\'s environment).'
                  )
            )
          }
        }
        ws.onclose = () => {
          if (!settled) {
            settled = true
            reject(
              new NotConnectedError(
                'connection closed during the handshake. If this is ghostkeysd, check the auth token ' +
                  '(GhostkeysClientOptions.token, or GHOSTKEYS_TOKEN in the daemon\'s environment).'
              )
            )
          }
        }
      })
    } catch (err) {
      cleanupHello()
      this.ws = null
      throw err
    }

    ws.onerror = (err) => this.emitter.emit('socketError', err)
    ws.onclose = (ev) => this.handleClose(ev)

    this.emitter.emit('open', undefined)
    this.flushOutgoing()
    if (isReconnect && this.desiredStreams.size > 0) {
      this.send({ type: 'subscribe', streams: [...this.desiredStreams] })
    }

    let hello: HelloMsg
    try {
      hello = await helloWait
    } catch (err) {
      ws.close()
      throw err
    } finally {
      cleanupHello()
    }
    this.reconnectAttempt = 0
    return hello
  }

  private flushOutgoing(): void {
    const queue = this.outgoingQueue
    this.outgoingQueue = []
    for (const message of queue) this.send(message)
  }

  private handleClose(ev: { code?: number; reason?: string }): void {
    const willReconnect = !this.manualClose && this.reconnectOptions !== null
    this.ws = null
    this.emitter.emit('disconnect', { code: ev.code, reason: ev.reason, willReconnect })
    if (willReconnect) this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const opts = this.reconnectOptions
    if (!opts) return
    this.reconnectAttempt += 1
    if (this.reconnectAttempt > opts.maxAttempts) return
    const backoff = Math.min(opts.maxDelayMs, opts.minDelayMs * 2 ** (this.reconnectAttempt - 1))
    const delayMs = Math.round(backoff * (0.85 + Math.random() * 0.3))
    this.emitter.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.openSocket(true)
        .then((hello) => this.emitter.emit('reconnected', hello))
        .catch(() => this.scheduleReconnect())
    }, delayMs)
  }

  private handleRawMessage(data: unknown): void {
    const text = typeof data === 'string' ? data : safeBufferToString(data)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      this.emitter.emit('protocolError', { raw: text, issue: err })
      return
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { type?: unknown }).type !== 'string') {
      this.emitter.emit('protocolError', { raw: text, issue: 'message has no string "type" field' })
      return
    }
    const type = (parsed as { type: string }).type
    const schema = daemonMessageSchemaByType[type]
    if (!schema) {
      this.emitter.emit('protocolError', { raw: text, issue: `unknown message type "${type}"` })
      return
    }
    const result = schema.safeParse(parsed)
    if (!result.success) {
      this.emitter.emit('protocolError', { raw: text, issue: result.error })
      return
    }
    const msg = result.data as DaemonMessage
    this.trackState(msg)
    this.emitter.emit(msg.type as DaemonMessageType, msg as any)
  }

  private trackState(msg: DaemonMessage): void {
    if (msg.type === 'hello') this._lastHello = msg
    else if (msg.type === 'status') this._lastStatus = msg
    else if (msg.type === 'config') {
      this._lastConfig = msg.config
      this._lastConfigRevision = configRevision(msg.config)
      // The daemon sends exactly one `config` message unprompted, as part of the post-connect
      // greeting (hello, then status, then config), before any client could possibly have sent
      // config_get/config_set on this connection. So the very first config message seen per
      // connection is unconditionally that greeting, never a reply to a request - and is swallowed
      // here rather than published to configReplyEmitter, so getConfig()/setConfig() can never
      // resolve with it by mistake even if called in the same tick as connect(). Every config
      // message after that one is a genuine reply (to this client's own request, or, more rarely,
      // to another client's) and is published normally.
      if (this.greetConfigSeen) {
        this.configReplyEmitter.emit('reply', msg)
      } else {
        this.greetConfigSeen = true
      }
    }
  }
}

function safeBufferToString(data: unknown): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return String(data)
}
