/**
 * Runtime (zod) validation for everything that comes off the wire. Types in ./types.ts are the
 * source of truth; these schemas are hand-kept in sync with them and checked against each other
 * in test/schemas.test.ts.
 *
 * We validate incoming daemon frames because the daemon is a local process the SDK does not
 * control the lifecycle of: a mid-upgrade daemon, a future protocol version, or a buggy
 * third-party reimplementation could send something that doesn't match docs/PROTOCOL.md, and a
 * malformed frame should become a recoverable `protocolError` event, not a thrown exception deep
 * in a WebSocket callback.
 */
import { z } from 'zod'
import {
  ACTION_KINDS,
  APP_OPS,
  CONTINUOUS_AIR_GESTURES,
  MEDIA_COMMANDS,
  MODIFIERS,
  PERMISSION_STATES,
  REJECT_REASONS,
  SURFACES,
  SYSTEM_OPS,
  WINDOW_OPS
} from './types.js'

const modifierSchema = z.enum(MODIFIERS as unknown as [string, ...string[]])
const surfaceSchema = z.enum(SURFACES as unknown as [string, ...string[]])
const rejectReasonSchema = z.enum(REJECT_REASONS as unknown as [string, ...string[]])
const permissionStateSchema = z.enum(PERMISSION_STATES as unknown as [string, ...string[]])
const inputSourceSchema = z.enum(['imu', 'sound', 'camera'])
const tapTypeSchema = z.enum(['fingertip', 'knuckle', 'nail'])
const handSchema = z.enum(['left', 'right'])

export const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
})

export const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  surface: surfaceSchema,
  rect: rectSchema,
  color: z.string()
})

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** `approvedHash` is optional on every gated kind: the client only ever reads it, the daemon computes it. */
const approvable = { approvedHash: z.string().optional() }

const simpleActionSchemaBase = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keystroke'), key: z.string(), modifiers: z.array(modifierSchema) }),
  z.object({ kind: z.literal('volume'), step: z.number() }),
  z.object({ kind: z.literal('mute') }),
  z.object({ kind: z.literal('media'), command: z.enum(MEDIA_COMMANDS as unknown as [string, ...string[]]) }),
  z.object({ kind: z.literal('brightness'), step: z.number() }),
  z.object({ kind: z.literal('open'), target: z.string(), ...approvable }),
  z.object({ kind: z.literal('shell'), command: z.string(), ...approvable }),
  z.object({ kind: z.literal('applescript'), source: z.string(), ...approvable }),
  z.object({ kind: z.literal('shortcut'), name: z.string(), ...approvable }),
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('clipboard'), text: z.string() }),
  z.object({ kind: z.literal('window'), op: z.enum(WINDOW_OPS as unknown as [string, ...string[]]) }),
  z.object({ kind: z.literal('app'), op: z.enum(APP_OPS as unknown as [string, ...string[]]) }),
  z.object({
    kind: z.literal('integration'),
    app: z.string(),
    command: z.string(),
    args: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({ kind: z.literal('system'), op: z.enum(SYSTEM_OPS as unknown as [string, ...string[]]) })
])

export const macroStepSchema = z.intersection(simpleActionSchemaBase, z.object({ delayMs: z.number().optional() }))

export const actionSchema: z.ZodType = z.union([
  simpleActionSchemaBase,
  z.object({ kind: z.literal('macro'), steps: z.array(macroStepSchema) })
])

export const actionKindSchema = z.enum(ACTION_KINDS as unknown as [string, ...string[]])

export const testActionInputSchema = z.union([
  z.intersection(simpleActionSchemaBase, z.object({ label: z.string().optional() })),
  z.intersection(z.object({ kind: z.literal('macro'), steps: z.array(macroStepSchema) }), z.object({ label: z.string().optional() }))
])

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const knobSpecSchema = z.object({
  axis: z.enum(['x', 'y']),
  stepPx: z.number(),
  inverse: actionSchema.nullable().optional()
})

export const bindingSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  gesture: z.string(),
  zone: z.string().nullable(),
  zones: z.array(z.string()).nullable(),
  modifiers: z.array(modifierSchema),
  app: z.string(),
  action: actionSchema,
  label: z.string().nullable().optional(),
  knob: knobSpecSchema.nullable().optional()
})

export const soundSettingsSchema = z.object({
  enabled: z.boolean(),
  sessionSeconds: z.number(),
  autoApps: z.array(z.string())
})

export const cameraSettingsSchema = z.object({
  enabled: z.boolean(),
  sessionSeconds: z.number(),
  autoApps: z.array(z.string()),
  deskMode: z.boolean()
})

export const settingsSchema = z.object({
  sensitivity: z.number(),
  typingGateMs: z.number(),
  doubleWindowMs: z.number(),
  minConfidence: z.number(),
  hud: z.boolean(),
  haptics: z.boolean(),
  sound: soundSettingsSchema,
  camera: cameraSettingsSchema
})

export const configSchema = z.object({
  version: z.number(),
  zones: z.array(zoneSchema),
  bindings: z.array(bindingSchema),
  settings: settingsSchema
})

// ---------------------------------------------------------------------------
// Daemon -> app
// ---------------------------------------------------------------------------

export const helloMsgSchema = z.object({
  type: z.literal('hello'),
  version: z.string(),
  device: z.object({ model: z.string(), chip: z.string(), family: z.string() }),
  sensors: z.object({
    imu: z.boolean(),
    gyro: z.boolean(),
    lid: z.boolean(),
    light: z.boolean(),
    sound: z.boolean(),
    camera: z.boolean()
  }),
  permissions: z.object({
    accessibility: z.boolean(),
    microphone: permissionStateSchema,
    camera: permissionStateSchema
  })
})

export const detectorStateSchema = z.object({
  noiseFloorMg: z.number(),
  thresholdMg: z.number(),
  level: z.number()
})

export const statusMsgSchema = z.object({
  type: z.literal('status'),
  paused: z.boolean(),
  pausedReason: z.enum(['user', 'rate_limit']).nullable(),
  calibrated: z.boolean(),
  zones: z.array(z.string()),
  imuHz: z.number(),
  detector: detectorStateSchema
})

const vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const imuMsgSchema = z.object({
  type: z.literal('imu'),
  t: z.number(),
  a: vec3Schema,
  g: vec3Schema
})

export const lidMsgSchema = z.object({
  type: z.literal('lid'),
  t: z.number(),
  angle: z.number()
})

export const lightMsgSchema = z.object({
  type: z.literal('light'),
  t: z.number(),
  value: z.number()
})

export const tapMsgSchema = z.object({
  type: z.literal('tap'),
  t: z.number(),
  zone: z.string(),
  confidence: z.number(),
  x: z.number(),
  y: z.number(),
  strength: z.number(),
  source: inputSourceSchema.optional(),
  tapType: tapTypeSchema.optional()
})

export const rejectedMsgSchema = z.object({
  type: z.literal('rejected'),
  t: z.number(),
  reason: rejectReasonSchema,
  gesture: z.string().optional()
})

export const gestureMsgSchema = z.object({
  type: z.literal('gesture'),
  t: z.number(),
  gesture: z.string(),
  zone: z.string().nullable(),
  zones: z.array(z.string()).nullable(),
  modifiers: z.array(modifierSchema),
  confidence: z.number(),
  app: z.string().nullable(),
  hand: handSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  source: inputSourceSchema.optional()
})

export const actionMsgSchema = z.object({
  type: z.literal('action'),
  t: z.number(),
  bindingId: z.string().nullable(),
  label: z.string(),
  ok: z.boolean(),
  error: z.string().nullable()
})

export const calibrationMsgSchema = z.discriminatedUnion('phase', [
  z.object({ type: z.literal('calibration'), phase: z.literal('started'), zones: z.array(z.string()), target: z.number() }),
  z.object({
    type: z.literal('calibration'),
    phase: z.literal('capturing'),
    zone: z.string(),
    count: z.number(),
    target: z.number()
  }),
  z.object({ type: z.literal('calibration'), phase: z.literal('negatives'), secondsLeft: z.number() }),
  z.object({ type: z.literal('calibration'), phase: z.literal('training') }),
  z.object({
    type: z.literal('calibration'),
    phase: z.literal('done'),
    accuracy: z.record(z.string(), z.number()),
    overall: z.number(),
    confusion: z.array(z.array(z.number())),
    labels: z.array(z.string())
  }),
  z.object({ type: z.literal('calibration'), phase: z.literal('cancelled') }),
  z.object({
    type: z.literal('calibration'),
    phase: z.literal('taptype_capturing'),
    tapType: z.string(),
    count: z.number(),
    target: z.number(),
    types: z.array(z.string()),
    missed: z.boolean().optional()
  }),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_cancelled'), reason: z.string() }),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_training') }),
  z.object({
    type: z.literal('calibration'),
    phase: z.literal('taptype_done'),
    accuracy: z.number(),
    counts: z.record(z.string(), z.number()),
    types: z.array(z.string()),
    simulated: z.boolean().optional()
  }),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_failed'), error: z.string() })
])

export const configMsgSchema = z.object({
  type: z.literal('config'),
  config: configSchema
})

export const errorMsgSchema = z.object({
  type: z.literal('error'),
  message: z.string()
})

export const approvedMsgSchema = z.object({
  type: z.literal('approved'),
  hash: z.string(),
  kind: z.string().nullable()
})

export const revokedMsgSchema = z.object({
  type: z.literal('revoked'),
  hash: z.string(),
  found: z.boolean()
})

export const integrationCatalogSchema = z.record(z.string(), z.unknown())

export const catalogMsgSchema = z.object({
  type: z.literal('catalog'),
  catalog: integrationCatalogSchema
})

export const sessionMsgSchema = z.object({
  type: z.literal('session'),
  kind: z.enum(['sound', 'air']),
  active: z.boolean(),
  secondsLeft: z.number(),
  simulated: z.boolean().optional(),
  reason: z.string().optional(),
  trigger: z.string().optional(),
  sonar: z.boolean().optional(),
  tapTypes: z.boolean().optional(),
  error: z.string().optional()
})

export const airMsgSchema = z.object({
  type: z.literal('air'),
  t: z.number(),
  gesture: z.enum(CONTINUOUS_AIR_GESTURES as unknown as [string, ...string[]]),
  phase: z.enum(['began', 'changed', 'ended']),
  hand: handSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  scale: z.number().optional(),
  confidence: z.number().optional()
})

export const daemonMessageSchema = z.union([
  helloMsgSchema,
  statusMsgSchema,
  imuMsgSchema,
  lidMsgSchema,
  lightMsgSchema,
  tapMsgSchema,
  rejectedMsgSchema,
  gestureMsgSchema,
  actionMsgSchema,
  calibrationMsgSchema,
  configMsgSchema,
  errorMsgSchema,
  approvedMsgSchema,
  revokedMsgSchema,
  catalogMsgSchema,
  sessionMsgSchema,
  airMsgSchema
])

/** Dispatch table keyed by `type`, used by the client to pick a schema before falling back to the union. */
export const daemonMessageSchemaByType: Record<string, z.ZodType> = {
  hello: helloMsgSchema,
  status: statusMsgSchema,
  imu: imuMsgSchema,
  lid: lidMsgSchema,
  light: lightMsgSchema,
  tap: tapMsgSchema,
  rejected: rejectedMsgSchema,
  gesture: gestureMsgSchema,
  action: actionMsgSchema,
  calibration: calibrationMsgSchema,
  config: configMsgSchema,
  error: errorMsgSchema,
  approved: approvedMsgSchema,
  revoked: revokedMsgSchema,
  catalog: catalogMsgSchema,
  session: sessionMsgSchema,
  air: airMsgSchema
}
