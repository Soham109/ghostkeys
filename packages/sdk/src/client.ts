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
  type DiagnosticsMsg,
  type FeedbackFalseMsg,
  type FeedbackMissedMsg,
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
  /** Default ws://127.0.0.1:47823/, since the daemon only ever binds to loopback. */
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
  /**
   * After `hello`, connect() also waits (best-effort) for the greeting's `config` message, so
   * `lastConfig`/`lastConfigRevision` are already populated by the time connect() resolves -
   * without this, a fresh client's very first `setConfig(..., { ifRevision })` call right after
   * connect() would have no revision to compare against yet. Never fails connect(): if config
   * doesn't arrive within this time, connect() resolves anyway. Default 2000ms.
   */
  greetTimeoutMs?: number
}

type DaemonEvents = { [K in DaemonMessageType]: DaemonMessageOf<K> }

export interface GhostkeysClientEvents extends DaemonEvents {
  open: undefined
  connect: HelloMsg
  reconnecting: { attempt: number; delayMs: number }
  reconnected: HelloMsg
  disconnect: { code?: number; reason?: string; willReconnect: boolean }
  socketError: unknown
  /**
   * A message whose `type` this SDK doesn't have a schema for - most likely a newer daemon speaking
   * a protocol addition this SDK version predates. Passed through unvalidated (not silently
   * discarded) so a caller can still react to it, e.g. by shape-checking `raw` itself.
   */
  unknown: { type: string; raw: unknown }
  /** A frame that's unparsable JSON, has no string "type", or has a recognized type but fails its schema. */
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
  private readonly greetTimeoutMs: number

  private readonly emitter = new TypedEmitter<GhostkeysClientEvents>()
  /**
   * A separate channel for config replies that getConfig()/setConfig() wait on, distinct from the
   * public 'config' event on `emitter` (which every config message, including the post-connect
   * greeting, is still published to). A `config` message is only ever routed here while
   * `pendingConfigRequests > 0`, i.e. while this client is actually waiting on a `config_get` or
   * `config_set` it sent - never for the unprompted greeting, and never for a `config` broadcast
   * caused by some other client's request. See trackState().
   */
  private readonly configReplyEmitter = new TypedEmitter<{ reply: ConfigMsg }>()
  private ws: WebSocketLike | null = null
  private manualClose = false
  private connectPromise: Promise<HelloMsg> | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private outgoingQueue: AppMessage[] = []
  private readonly desiredStreams = new Set<Stream>()
  /** Incremented when this client sends config_get/config_set, decremented when a config reply is matched. */
  private pendingConfigRequests = 0
  /** Reset per physical connection in openSocket(); true once any "config" message has arrived on it. */
  private sawConfigThisConnection = false

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
    this.greetTimeoutMs = options.greetTimeoutMs ?? Math.min(2000, this.requestTimeoutMs)
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
    this.pendingConfigRequests++
    this.send({ type: 'config_get' })
    const msg = await wait
    return { config: msg.config, revision: configRevision(msg.config) }
  }

  /**
   * Saves a new config. Pass `ifRevision` (from a prior getConfig()/setConfig() call, possibly on a
   * different `GhostkeysClient` instance - a revision is a content hash, not tied to any particular
   * connection) to guard against clobbering a change made elsewhere since that revision was read: if
   * the actual current revision no longer matches, this throws `ConfigConflictError` without sending
   * `config_set`, so you can getConfig() again and re-apply your change on top of the latest one.
   *
   * If this client instance doesn't know the current revision yet (e.g. it just connected, or the
   * revision came from a different, already-disconnected client), it fetches one via getConfig()
   * first rather than assuming a conflict - a fresh client has no basis to claim the config changed
   * when it never saw a "before" to compare against.
   */
  async setConfig(config: Config, opts: { ifRevision?: string } = {}): Promise<{ config: Config; revision: string }> {
    if (opts.ifRevision !== undefined) {
      const current = this._lastConfigRevision ?? (await this.getConfig()).revision
      if (opts.ifRevision !== current) {
        throw new ConfigConflictError(opts.ifRevision, current)
      }
    }
    const wait = new Promise<{ config: Config; revision: string }>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        offReply()
        offError()
      }
      // Matched via trackState() routing a "config" message here (which already decrements
      // pendingConfigRequests for us) - only the give-up paths below need to decrement themselves.
      const offReply = this.configReplyEmitter.on('reply', (msg) => {
        cleanup()
        resolve({ config: msg.config, revision: configRevision(msg.config) })
      })
      const offError = this.emitter.on('error', (msg) => {
        cleanup()
        this.pendingConfigRequests = Math.max(0, this.pendingConfigRequests - 1)
        reject(new GhostkeysProtocolError(msg.message))
      })
      const timer = setTimeout(() => {
        cleanup()
        this.pendingConfigRequests = Math.max(0, this.pendingConfigRequests - 1)
        reject(new GhostkeysTimeoutError('config_set reply', this.requestTimeoutMs))
      }, this.requestTimeoutMs)
    })
    this.pendingConfigRequests++
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
  async startAirSession(seconds?: number, camera?: 'front' | 'desk_view'): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'air', 'camera session to start')
    this.send({ type: 'air_session_start', seconds, camera })
    return wait
  }

  async stopAirSession(): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'air', 'camera session to stop')
    this.send({ type: 'air_session_stop' })
    return wait
  }

  /**
   * Retries starting sonar at once (it otherwise starts by itself when settings.sonar.enabled turns
   * on). Resolves with the resulting session state, whether that's active or a failure (the daemon
   * replies a session message either way - see docs/PROTOCOL.md "session").
   */
  async startSonarSession(): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'sonar', 'sonar session reply')
    this.send({ type: 'sonar_session_start' })
    return wait
  }

  /** Turns settings.sonar.enabled off (this is a setting, not a timed session: it stays off until turned back on). */
  async stopSonarSession(): Promise<DaemonMessageOf<'session'>> {
    const wait = this.awaitEvent('session', (msg) => msg.kind === 'sonar', 'sonar session to stop')
    this.send({ type: 'sonar_session_stop' })
    return wait
  }

  /** Disables the daemon's recommended drops from the last calibration (except merge-pair zones) and retrains. */
  async applyCalibrationRecommendation(): Promise<Extract<CalibrationMsg, { phase: 'recommendation_applied' }>> {
    const wait = this.awaitEvent(
      'calibration',
      (msg): msg is Extract<CalibrationMsg, { phase: 'recommendation_applied' }> => msg.phase === 'recommendation_applied',
      'calibration_apply_recommendation reply'
    )
    this.send({ type: 'calibration_apply_recommendation' })
    return wait
  }

  /** Merges two confused zones into one (rect = union, samples relabeled, model retrained, bindings updated). */
  async applyCalibrationMerge(zones: [string, string], name?: string): Promise<Extract<CalibrationMsg, { phase: 'merge_applied' }>> {
    const wait = this.awaitEvent(
      'calibration',
      (msg): msg is Extract<CalibrationMsg, { phase: 'merge_applied' }> => msg.phase === 'merge_applied',
      'calibration_apply_merge reply'
    )
    this.send({ type: 'calibration_apply_merge', zones, name })
    return wait
  }

  /** "I just tapped this zone and nothing happened." At most one every 2s and 20/minute (daemon-enforced). */
  async reportMissedTap(zone: string): Promise<FeedbackMissedMsg> {
    const wait = this.awaitEvent(
      'feedback',
      (msg): msg is FeedbackMissedMsg => msg.kind === 'missed',
      'feedback_missed reply'
    )
    this.send({ type: 'feedback_missed', zone })
    return wait
  }

  /** "The last accepted tap was not meant" (nothing is undone). At most one every 2s and 20/minute (daemon-enforced). */
  async reportFalseTap(): Promise<FeedbackFalseMsg> {
    const wait = this.awaitEvent('feedback', (msg): msg is FeedbackFalseMsg => msg.kind === 'false', 'feedback_false reply')
    this.send({ type: 'feedback_false' })
    return wait
  }

  /** Writes the last 10s of raw motion + detector decisions to <config dir>/diagnostics/*.gkrec. At most one every 5s. */
  async exportDiagnostics(): Promise<DiagnosticsMsg> {
    const wait = this.awaitEvent('diagnostics', () => true, 'diagnostics_export reply')
    this.send({ type: 'diagnostics_export' })
    return wait
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /**
   * Resolves on the first config reply routed by trackState() (i.e. sent while
   * `pendingConfigRequests > 0`) - never the unprompted greeting, and never some other client's
   * broadcast that arrives while no request of ours is outstanding. On timeout, gives back the
   * pending-request slot this call reserved, since trackState() will never get to do it for us.
   */
  private awaitConfigReply(what: string, timeoutMs: number = this.requestTimeoutMs): Promise<ConfigMsg> {
    return new Promise<ConfigMsg>((resolve, reject) => {
      const off = this.configReplyEmitter.on('reply', (msg) => {
        clearTimeout(timer)
        off()
        resolve(msg)
      })
      const timer = setTimeout(() => {
        off()
        this.pendingConfigRequests = Math.max(0, this.pendingConfigRequests - 1)
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
    this.sawConfigThisConnection = false

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
    // miss them entirely (no message queueing happens underneath: it is a plain callback slot).
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
    // Best-effort: the greeting's config is normally already in flight right behind hello, so this
    // rarely actually waits. Never fails connect() - a daemon (or test double) that doesn't send an
    // unprompted config just means lastConfig/lastConfigRevision stay unset a little longer.
    await this.waitForGreetingConfig()
    this.reconnectAttempt = 0
    return hello
  }

  /** Resolves once this connection's post-connect config broadcast has been seen, or after greetTimeoutMs. */
  private waitForGreetingConfig(): Promise<void> {
    if (this.sawConfigThisConnection) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const cleanup = () => {
        off()
        clearTimeout(timer)
      }
      const off = this.emitter.on('config', () => {
        cleanup()
        resolve()
      })
      const timer = setTimeout(() => {
        cleanup()
        resolve()
      }, this.greetTimeoutMs)
    })
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
      this.emitter.emit('unknown', { type, raw: parsed })
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
      this.sawConfigThisConnection = true
      // Only route to configReplyEmitter while a config_get/config_set of ours is actually
      // outstanding. This is what keeps getConfig()/setConfig() from ever resolving with the
      // unprompted post-connect greeting (pendingConfigRequests is 0 at that point, since it arrives
      // before this client could have sent anything), or with some other client's broadcast that
      // happens to land while we have nothing pending - while still working correctly even if a test
      // double's greeting never sends a config at all (earlier logic here keyed off "the first config
      // message ever seen," which broke exactly that case: it swallowed the real reply to this
      // client's very first request, treating it as if it were the missing greeting).
      if (this.pendingConfigRequests > 0) {
        this.pendingConfigRequests--
        this.configReplyEmitter.emit('reply', msg)
      }
    }
  }
}

function safeBufferToString(data: unknown): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return String(data)
}
