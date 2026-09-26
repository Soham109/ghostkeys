import { describe, expect, it } from 'vitest'
import { actionSchema, daemonMessageSchemaByType } from '../src/protocol/schemas.js'
import { DAEMON_MESSAGE_TYPES } from '../src/protocol/types.js'

describe('daemonMessageSchemaByType', () => {
  it('has exactly one schema per DaemonMessage type', () => {
    expect(Object.keys(daemonMessageSchemaByType).sort()).toEqual([...DAEMON_MESSAGE_TYPES].sort())
  })

  const samples: Record<string, unknown> = {
    hello: {
      type: 'hello',
      version: '0.1.0',
      device: { model: 'Mac17,8', chip: 'Apple M5 Pro', family: 'macbook-pro-14' },
      sensors: { imu: true, gyro: true, lid: true, light: true, sound: false, camera: false },
      permissions: { accessibility: false, microphone: 'not_determined', camera: 'not_determined' }
    },
    status: {
      type: 'status',
      paused: false,
      pausedReason: null,
      calibrated: true,
      zones: ['left-palm'],
      imuHz: 797,
      detector: { noiseFloorMg: 1.2, thresholdMg: 17.5, level: 3.1 }
    },
    imu: { type: 'imu', t: 1.5, a: [0.01, -0.02, -0.99], g: [0.1, 0, -0.2] },
    lid: { type: 'lid', t: 1.5, angle: 112 },
    light: { type: 'light', t: 1.5, value: 0.42 },
    tap: { type: 'tap', t: 1.5, zone: 'right-grille', confidence: 0.93, x: 0.91, y: 0.2, strength: 0.6 },
    rejected: { type: 'rejected', t: 1.5, reason: 'typing' },
    gesture: {
      type: 'gesture',
      t: 1.5,
      gesture: 'double',
      zone: 'right-grille',
      zones: null,
      modifiers: ['shift'],
      confidence: 0.91,
      app: 'com.microsoft.Excel'
    },
    action: { type: 'action', t: 1.5, bindingId: 'b1', label: 'Volume up', ok: true, error: null },
    calibration: { type: 'calibration', phase: 'started', zones: ['left-palm'], target: 20 },
    config: {
      type: 'config',
      config: {
        version: 1,
        zones: [{ id: 'left-palm', name: 'Left palm rest', surface: 'base', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff' }],
        bindings: [],
        settings: {
          sensitivity: 0.5,
          typingGateMs: 450,
          doubleWindowMs: 350,
          minConfidence: 0.8,
          hud: true,
          haptics: false,
          sound: { enabled: false, sessionSeconds: 30, autoApps: [] },
          camera: { enabled: false, sessionSeconds: 30, autoApps: [], deskMode: false }
        }
      }
    },
    error: { type: 'error', message: 'unknown message type: bogus' },
    approved: { type: 'approved', hash: 'a'.repeat(64), kind: 'shell' },
    revoked: { type: 'revoked', hash: 'a'.repeat(64), found: true },
    catalog: { type: 'catalog', catalog: { apps: [], commands: [], unsupported: {} } },
    session: { type: 'session', kind: 'sound', active: true, secondsLeft: 30 },
    air: { type: 'air', t: 1.5, gesture: 'pinch_hold', phase: 'changed', dx: 0.01, dy: -0.02 }
  }

  for (const [type, sample] of Object.entries(samples)) {
    it(`accepts a valid ${type} message`, () => {
      const schema = daemonMessageSchemaByType[type]
      expect(schema).toBeDefined()
      expect(schema!.safeParse(sample).success).toBe(true)
    })
  }

  it('rejects a gesture message with a nullable field missing entirely', () => {
    const { zone, ...withoutZone } = samples.gesture as any
    expect(daemonMessageSchemaByType.gesture!.safeParse(withoutZone).success).toBe(false)
  })

  it('rejects an action message where bindingId is missing (must be string or explicit null)', () => {
    const { bindingId, ...withoutBindingId } = samples.action as any
    expect(daemonMessageSchemaByType.action!.safeParse(withoutBindingId).success).toBe(false)
  })

  it('accepts every calibration phase variant', () => {
    const schema = daemonMessageSchemaByType.calibration!
    expect(schema.safeParse({ type: 'calibration', phase: 'started', zones: [], target: 20 }).success).toBe(true)
    expect(schema.safeParse({ type: 'calibration', phase: 'capturing', zone: 'left-palm', count: 1, target: 20 }).success).toBe(true)
    expect(schema.safeParse({ type: 'calibration', phase: 'negatives', secondsLeft: 5 }).success).toBe(true)
    expect(schema.safeParse({ type: 'calibration', phase: 'training' }).success).toBe(true)
    expect(
      schema.safeParse({ type: 'calibration', phase: 'done', accuracy: {}, overall: 1, confusion: [[1]], labels: ['left-palm'] }).success
    ).toBe(true)
    expect(schema.safeParse({ type: 'calibration', phase: 'cancelled' }).success).toBe(true)
    expect(schema.safeParse({ type: 'calibration', phase: 'not-a-real-phase' }).success).toBe(false)
  })
})

describe('actionSchema', () => {
  it('accepts every simple action kind', () => {
    const actions = [
      { kind: 'keystroke', key: 'v', modifiers: ['command'] },
      { kind: 'volume', step: 6 },
      { kind: 'mute' },
      { kind: 'media', command: 'playpause' },
      { kind: 'brightness', step: -1 },
      { kind: 'open', target: 'Finder' },
      { kind: 'shell', command: 'echo hi' },
      { kind: 'applescript', source: 'beep' },
      { kind: 'shortcut', name: 'My Shortcut' },
      { kind: 'text', text: 'hello' },
      { kind: 'clipboard', text: 'hello' },
      { kind: 'window', op: 'left' },
      { kind: 'app', op: 'quit' },
      { kind: 'integration', app: 'excel', command: 'wrap-iferror' },
      { kind: 'system', op: 'lock' }
    ]
    for (const action of actions) expect(actionSchema.safeParse(action).success).toBe(true)
  })

  it('accepts a macro of simple actions with delayMs', () => {
    const macro = {
      kind: 'macro',
      steps: [
        { kind: 'keystroke', key: 'left', modifiers: ['command'] },
        { kind: 'keystroke', key: 'right', modifiers: ['command', 'shift'], delayMs: 40 }
      ]
    }
    expect(actionSchema.safeParse(macro).success).toBe(true)
  })

  it('rejects an unknown action kind', () => {
    expect(actionSchema.safeParse({ kind: 'nonsense' }).success).toBe(false)
  })

  it('rejects a macro step nested inside a macro step (only simple actions are valid steps)', () => {
    const macro = { kind: 'macro', steps: [{ kind: 'macro', steps: [] }] }
    expect(actionSchema.safeParse(macro).success).toBe(false)
  })
})
