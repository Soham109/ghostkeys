import { CalibrationCancelledError, GhostkeysTimeoutError } from './errors.js'
import { TypedEmitter, type Unsubscribe } from './emitter.js'
import type { AppMessage, CalibrationDoneMsg, CalibrationMsg } from './protocol/types.js'

/** What a `CalibrationFlow` needs from its client, kept minimal so it can be unit-tested standalone. */
export interface CalibrationTransport {
  send(message: AppMessage): void
  onCalibration(listener: (message: CalibrationMsg) => void): Unsubscribe
}

export interface CalibrationFlowEvents {
  progress: CalibrationMsg
}

export interface CalibrationFlowOptions {
  /** Default timeout for captureZone()/negatives()/finish()/cancel(), in ms. Default 10000. */
  timeoutMs?: number
  /** Extra timeout budget for finish(), on top of timeoutMs, to cover model training. Default 60000. */
  trainingTimeoutMs?: number
}

/**
 * Drives one calibration run as an async state machine over the daemon's `calibration_*` messages.
 * Created by `GhostkeysClient.startCalibration()`; also usable standalone against any
 * `CalibrationTransport` (that's what test/calibration.test.ts does, without a socket at all).
 *
 * The daemon does not send an explicit "back to idle" message when a zone finishes capturing: it
 * just stops sending `capturing` updates once `count` reaches `target`. So `captureZone()` treats
 * "a capturing message for this zone with count >= target" as the zone being done.
 */
export class CalibrationFlow {
  readonly zones: string[]
  readonly target: number

  private readonly transport: CalibrationTransport
  private readonly timeoutMs: number
  private readonly trainingTimeoutMs: number
  private readonly emitter = new TypedEmitter<CalibrationFlowEvents>()
  private readonly unlisten: Unsubscribe
  private disposed = false

  constructor(transport: CalibrationTransport, zones: string[], target: number, options: CalibrationFlowOptions = {}) {
    this.transport = transport
    this.zones = zones
    this.target = target
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.trainingTimeoutMs = options.trainingTimeoutMs ?? 60_000
    this.unlisten = transport.onCalibration((msg) => this.emitter.emit('progress', msg))
  }

  /** Subscribe to every calibration message for this session (capturing counts, countdowns, ...). */
  onProgress(listener: (message: CalibrationMsg) => void): Unsubscribe {
    return this.emitter.on('progress', listener)
  }

  /**
   * Tells the daemon following taps belong to `zone`, then resolves once `target` samples have
   * been captured for it. Reject rate / stray taps just mean it takes longer; there is no partial
   * failure state from the daemon's side.
   */
  async captureZone(zone: string, timeoutMs = this.timeoutMs): Promise<{ zone: string; count: number; target: number }> {
    this.assertNotDisposed()
    const wait = this.waitFor(
      (msg): msg is Extract<CalibrationMsg, { phase: 'capturing' }> =>
        msg.phase === 'capturing' && msg.zone === zone && msg.count >= this.target,
      `calibration zone "${zone}" to finish capturing`,
      timeoutMs
    )
    this.transport.send({ type: 'calibration_zone', zone })
    const msg = await wait
    return { zone: msg.zone, count: msg.count, target: msg.target }
  }

  /** Starts the negatives countdown (user types/clicks normally) and resolves once it hits zero. */
  async negatives(seconds: number, timeoutMs = seconds * 1000 + this.timeoutMs): Promise<void> {
    this.assertNotDisposed()
    const wait = this.waitFor(
      (msg): msg is Extract<CalibrationMsg, { phase: 'negatives' }> => msg.phase === 'negatives' && msg.secondsLeft <= 0,
      'negatives countdown to finish',
      timeoutMs
    )
    this.transport.send({ type: 'calibration_negatives', seconds })
    await wait
  }

  /**
   * Trains and saves the model, resolving with the accuracy report. Throws
   * `CalibrationCancelledError` if another client cancels the session first.
   */
  async finish(): Promise<CalibrationDoneMsg> {
    this.assertNotDisposed()
    const wait = this.waitFor(
      (msg): msg is Extract<CalibrationMsg, { phase: 'done' | 'cancelled' }> => msg.phase === 'done' || msg.phase === 'cancelled',
      'calibration to finish training',
      this.timeoutMs + this.trainingTimeoutMs
    )
    this.transport.send({ type: 'calibration_finish' })
    const msg = await wait
    if (msg.phase === 'cancelled') throw new CalibrationCancelledError()
    this.dispose()
    return msg
  }

  /** Cancels the session. Safe to call even if it has already finished or been cancelled. */
  async cancel(timeoutMs = this.timeoutMs): Promise<void> {
    if (this.disposed) return
    const wait = this.waitFor((msg): msg is Extract<CalibrationMsg, { phase: 'cancelled' }> => msg.phase === 'cancelled', 'calibration to cancel', timeoutMs)
    this.transport.send({ type: 'calibration_cancel' })
    await wait
    this.dispose()
  }

  /** Stops listening for calibration messages without sending anything to the daemon. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unlisten()
    this.emitter.removeAllListeners()
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('this CalibrationFlow has already finished, been cancelled, or been disposed')
  }

  private waitFor<T extends CalibrationMsg>(predicate: (msg: CalibrationMsg) => msg is T, what: string, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const off = this.onProgress((msg) => {
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
}
