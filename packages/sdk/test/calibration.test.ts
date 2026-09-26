import { describe, expect, it } from 'vitest'
import { WebSocket as NodeWebSocket } from 'ws'
import { CalibrationFlow, type CalibrationTransport } from '../src/calibration.js'
import { GhostkeysClient } from '../src/client.js'
import { CalibrationCancelledError, GhostkeysTimeoutError } from '../src/errors.js'
import type { AppMessage, CalibrationMsg } from '../src/protocol/types.js'
import type { WebSocketCtor } from '../src/ws.js'
import { FakeDaemon } from './fake-server.js'
import { testConfig } from './fixtures.js'

const webSocket = NodeWebSocket as unknown as WebSocketCtor

/** A scripted transport: records what CalibrationFlow sends, and lets the test push progress messages. */
class ScriptedTransport implements CalibrationTransport {
  sent: AppMessage[] = []
  private listeners = new Set<(m: CalibrationMsg) => void>()

  send(message: AppMessage): void {
    this.sent.push(message)
  }

  onCalibration(listener: (message: CalibrationMsg) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  push(message: CalibrationMsg): void {
    for (const l of [...this.listeners]) l(message)
  }
}

describe('CalibrationFlow (scripted transport, no socket)', () => {
  it('captureZone sends calibration_zone and resolves only once count reaches target', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 3)

    const progress: CalibrationMsg[] = []
    flow.onProgress((m) => progress.push(m))

    const promise = flow.captureZone('left-palm')
    expect(transport.sent).toEqual([{ type: 'calibration_zone', zone: 'left-palm' }])

    // Intermediate counts must not resolve the promise.
    transport.push({ type: 'calibration', phase: 'capturing', zone: 'left-palm', count: 1, target: 3 })
    transport.push({ type: 'calibration', phase: 'capturing', zone: 'left-palm', count: 2, target: 3 })
    let settled = false
    promise.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)

    transport.push({ type: 'calibration', phase: 'capturing', zone: 'left-palm', count: 3, target: 3 })
    const result = await promise
    expect(result).toEqual({ zone: 'left-palm', count: 3, target: 3 })
    expect(progress).toHaveLength(3)
  })

  it('captureZone ignores capturing messages for a different zone', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm', 'right-palm'], 2)
    const promise = flow.captureZone('left-palm')
    transport.push({ type: 'calibration', phase: 'capturing', zone: 'right-palm', count: 2, target: 2 })
    let settled = false
    promise.then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    transport.push({ type: 'calibration', phase: 'capturing', zone: 'left-palm', count: 2, target: 2 })
    await promise
  })

  it('negatives sends calibration_negatives and resolves at secondsLeft 0', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2)
    const promise = flow.negatives(2)
    expect(transport.sent).toEqual([{ type: 'calibration_negatives', seconds: 2 }])
    transport.push({ type: 'calibration', phase: 'negatives', secondsLeft: 1 })
    transport.push({ type: 'calibration', phase: 'negatives', secondsLeft: 0 })
    await promise
  })

  it('finish waits through training and resolves with the done report', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2)
    const promise = flow.finish()
    transport.push({ type: 'calibration', phase: 'training' })
    const done: CalibrationMsg = { type: 'calibration', phase: 'done', accuracy: { 'left-palm': 1 }, overall: 1, confusion: [[1]], labels: ['left-palm'] }
    transport.push(done)
    await expect(promise).resolves.toEqual(done)
  })

  it('finish rejects with CalibrationCancelledError if the session is cancelled first', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2)
    const promise = flow.finish()
    transport.push({ type: 'calibration', phase: 'cancelled' })
    await expect(promise).rejects.toBeInstanceOf(CalibrationCancelledError)
  })

  it('cancel sends calibration_cancel and resolves on the cancelled reply', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2)
    const promise = flow.cancel()
    expect(transport.sent).toEqual([{ type: 'calibration_cancel' }])
    transport.push({ type: 'calibration', phase: 'cancelled' })
    await promise
  })

  it('times out if the daemon never replies', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2, { timeoutMs: 30 })
    await expect(flow.captureZone('left-palm')).rejects.toBeInstanceOf(GhostkeysTimeoutError)
  })

  it('rejects further calls once disposed', async () => {
    const transport = new ScriptedTransport()
    const flow = new CalibrationFlow(transport, ['left-palm'], 2)
    flow.dispose()
    await expect(flow.captureZone('left-palm')).rejects.toThrow(/already finished/)
  })
})

describe('GhostkeysClient.startCalibration (through the fake daemon)', () => {
  it('drives a full calibrate -> capture -> negatives -> finish flow', async () => {
    const daemon = await FakeDaemon.start(testConfig())
    const client = new GhostkeysClient({ url: daemon.url, webSocket })
    await client.connect()

    const flow = await client.startCalibration(['left-palm', 'right-grille'], 5)
    expect(flow.zones).toEqual(['left-palm', 'right-grille'])
    expect(flow.target).toBe(5)

    await flow.captureZone('left-palm')
    await flow.captureZone('right-grille')
    await flow.negatives(1)
    const done = await flow.finish()
    expect(done.phase).toBe('done')
    expect(done.overall).toBeGreaterThan(0)

    client.disconnect()
    await daemon.close()
  })
})
