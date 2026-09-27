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
 *
 * Every object schema here uses `.passthrough()`: a field this SDK doesn't know about yet (the
 * daemon's protocol has grown several times over this project's life) is kept on the parsed object
 * instead of being silently stripped. That matters most for anything that round-trips through
 * getConfig() -> setConfig(): a stripped field is saved back to the daemon as if the app meant to
 * remove it, which for something like `settings.sonar` means silently turning a feature off. A
 * message type this SDK has no schema for at all (an even newer addition) never reaches
 * `daemonMessageSchemaByType` in the first place; the client emits it as an `unknown` event instead
 * of discarding it - see client.ts's handleRawMessage().
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
const inputSourceSchema = z.enum(['imu', 'sound', 'camera', 'sonar'])
const tapTypeSchema = z.enum(['fingertip', 'knuckle', 'nail'])
const handSchema = z.enum(['left', 'right'])
const sideSchema = z.enum(['left', 'right'])

export const rectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number()
  })
  .passthrough()

export const zoneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    surface: surfaceSchema,
    rect: rectSchema,
    color: z.string(),
    enabled: z.boolean().optional()
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** `approvedHash` is optional on every gated kind: the client only ever reads it, the daemon computes it. */
const approvable = { approvedHash: z.string().optional() }

const simpleActionSchemaBase = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('keystroke'), key: z.string(), modifiers: z.array(modifierSchema) }).passthrough(),
  z.object({ kind: z.literal('volume'), step: z.number() }).passthrough(),
  z.object({ kind: z.literal('mute') }).passthrough(),
  z.object({ kind: z.literal('media'), command: z.enum(MEDIA_COMMANDS as unknown as [string, ...string[]]) }).passthrough(),
  z.object({ kind: z.literal('brightness'), step: z.number() }).passthrough(),
  z.object({ kind: z.literal('open'), target: z.string(), ...approvable }).passthrough(),
  z.object({ kind: z.literal('shell'), command: z.string(), ...approvable }).passthrough(),
  z.object({ kind: z.literal('applescript'), source: z.string(), ...approvable }).passthrough(),
  z.object({ kind: z.literal('shortcut'), name: z.string(), ...approvable }).passthrough(),
  z.object({ kind: z.literal('text'), text: z.string() }).passthrough(),
  z.object({ kind: z.literal('clipboard'), text: z.string() }).passthrough(),
  z.object({ kind: z.literal('window'), op: z.enum(WINDOW_OPS as unknown as [string, ...string[]]) }).passthrough(),
  z.object({ kind: z.literal('app'), op: z.enum(APP_OPS as unknown as [string, ...string[]]) }).passthrough(),
  z
    .object({
      kind: z.literal('integration'),
      app: z.string(),
      command: z.string(),
      args: z.record(z.string(), z.unknown()).optional()
    })
    .passthrough(),
  z.object({ kind: z.literal('system'), op: z.enum(SYSTEM_OPS as unknown as [string, ...string[]]) }).passthrough()
])

export const macroStepSchema = z.intersection(simpleActionSchemaBase, z.object({ delayMs: z.number().optional() }))

export const actionSchema: z.ZodType = z.union([
  simpleActionSchemaBase,
  z.object({ kind: z.literal('macro'), steps: z.array(macroStepSchema) }).passthrough()
])

export const actionKindSchema = z.enum(ACTION_KINDS as unknown as [string, ...string[]])

export const testActionInputSchema = z.union([
  z.intersection(simpleActionSchemaBase, z.object({ label: z.string().optional() })),
  z.intersection(z.object({ kind: z.literal('macro'), steps: z.array(macroStepSchema) }), z.object({ label: z.string().optional() }))
])

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const knobSpecSchema = z
  .object({
    axis: z.enum(['x', 'y']),
    stepPx: z.number(),
    inverse: actionSchema.nullable().optional()
  })
  .passthrough()

export const sliderSpecSchema = z
  .object({
    mode: z.enum(['absolute', 'relative']),
    stepMm: z.number(),
    inverse: actionSchema.nullable().optional()
  })
  .passthrough()

export const bindingSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    gesture: z.string(),
    zone: z.string().nullable(),
    zones: z.array(z.string()).nullable(),
    modifiers: z.array(modifierSchema),
    app: z.string(),
    action: actionSchema,
    label: z.string().nullable().optional(),
    knob: knobSpecSchema.nullable().optional(),
    slider: sliderSpecSchema.nullable().optional()
  })
  .passthrough()

export const soundSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sessionSeconds: z.number(),
    autoApps: z.array(z.string())
  })
  .passthrough()

export const cameraSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sessionSeconds: z.number(),
    autoApps: z.array(z.string()),
    deskMode: z.boolean()
  })
  .passthrough()

export const sonarSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sessionSeconds: z.number(),
    autoApps: z.array(z.string())
  })
  .passthrough()

export const settingsSchema = z
  .object({
    sensitivity: z.number(),
    typingGateMs: z.number(),
    doubleWindowMs: z.number(),
    minConfidence: z.number(),
    followUpConfidence: z.number(),
    lightTouch: z.boolean(),
    learnFromUse: z.boolean(),
    hud: z.boolean(),
    haptics: z.boolean(),
    sound: soundSettingsSchema,
    camera: cameraSettingsSchema,
    sonar: sonarSettingsSchema
  })
  .passthrough()

export const configSchema = z
  .object({
    version: z.number(),
    zones: z.array(zoneSchema),
    bindings: z.array(bindingSchema),
    settings: settingsSchema
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Daemon -> app
// ---------------------------------------------------------------------------

export const helloMsgSchema = z
  .object({
    type: z.literal('hello'),
    version: z.string(),
    device: z.object({ model: z.string(), chip: z.string(), family: z.string() }).passthrough(),
    sensors: z
      .object({
        imu: z.boolean(),
        gyro: z.boolean(),
        lid: z.boolean(),
        light: z.boolean(),
        sound: z.boolean(),
        camera: z.boolean()
      })
      .passthrough(),
    permissions: z
      .object({
        accessibility: z.boolean(),
        microphone: permissionStateSchema,
        camera: permissionStateSchema
      })
      .passthrough()
  })
  .passthrough()

export const detectorStateSchema = z
  .object({
    noiseFloorMg: z.number(),
    thresholdMg: z.number(),
    level: z.number()
  })
  .passthrough()

export const statusMsgSchema = z
  .object({
    type: z.literal('status'),
    paused: z.boolean(),
    pausedReason: z.enum(['user', 'rate_limit']).nullable(),
    calibrated: z.boolean(),
    zones: z.array(z.string()),
    imuHz: z.number(),
    detector: detectorStateSchema
  })
  .passthrough()

const vec3Schema = z.tuple([z.number(), z.number(), z.number()])

export const imuMsgSchema = z
  .object({
    type: z.literal('imu'),
    t: z.number(),
    a: vec3Schema,
    g: vec3Schema
  })
  .passthrough()

export const lidMsgSchema = z
  .object({
    type: z.literal('lid'),
    t: z.number(),
    angle: z.number()
  })
  .passthrough()

export const lightMsgSchema = z
  .object({
    type: z.literal('light'),
    t: z.number(),
    value: z.number()
  })
  .passthrough()

export const tapMsgSchema = z
  .object({
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
  .passthrough()

export const rejectedMsgSchema = z
  .object({
    type: z.literal('rejected'),
    t: z.number(),
    reason: rejectReasonSchema,
    zone: z.string().nullable().optional(),
    confidence: z.number().optional(),
    strength: z.number().optional(),
    gesture: z.string().optional()
  })
  .passthrough()

export const candidateMsgSchema = z
  .object({
    type: z.literal('candidate'),
    t: z.number(),
    zone: z.string().nullable(),
    confidence: z.number(),
    strength: z.number(),
    outcome: z.string()
  })
  .passthrough()

export const gestureMsgSchema = z
  .object({
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
    side: sideSchema.optional(),
    distanceMm: z.number().optional(),
    source: inputSourceSchema.optional()
  })
  .passthrough()

export const actionMsgSchema = z
  .object({
    type: z.literal('action'),
    t: z.number(),
    bindingId: z.string().nullable(),
    label: z.string(),
    ok: z.boolean(),
    error: z.string().nullable()
  })
  .passthrough()

const calibrationPeaksSchema = z
  .object({
    p10: z.number(),
    p50: z.number(),
    p90: z.number()
  })
  .passthrough()

const calibrationRecommendationSchema = z
  .object({
    keep: z.array(z.string()),
    drop: z.record(z.string(), z.string()),
    merge: z.array(z.tuple([z.string(), z.string()])),
    expectedAccuracy: z.record(z.string(), z.number())
  })
  .passthrough()

const calibrationBindingChangedSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    gesture: z.string(),
    from: z.string(),
    to: z.string()
  })
  .passthrough()

export const calibrationMsgSchema = z.discriminatedUnion('phase', [
  z.object({ type: z.literal('calibration'), phase: z.literal('started'), zones: z.array(z.string()), target: z.number() }).passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('capturing'),
      zone: z.string(),
      count: z.number(),
      target: z.number()
    })
    .passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('negatives'), secondsLeft: z.number() }).passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('training') }).passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('done'),
      accuracy: z.record(z.string(), z.number()),
      overall: z.number(),
      confusion: z.array(z.array(z.number())),
      labels: z.array(z.string()),
      peaks: z.record(z.string(), calibrationPeaksSchema),
      recommendation: calibrationRecommendationSchema
    })
    .passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('cancelled') }).passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('taptype_capturing'),
      tapType: z.string(),
      count: z.number(),
      target: z.number(),
      types: z.array(z.string()),
      missed: z.boolean().optional()
    })
    .passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_cancelled'), reason: z.string() }).passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_training') }).passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('taptype_done'),
      accuracy: z.number(),
      counts: z.record(z.string(), z.number()),
      types: z.array(z.string()),
      simulated: z.boolean().optional()
    })
    .passthrough(),
  z.object({ type: z.literal('calibration'), phase: z.literal('taptype_failed'), error: z.string() }).passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('recommendation_applied'),
      disabled: z.array(z.string()),
      keep: z.array(z.string()),
      mergeSuggested: z.array(z.tuple([z.string(), z.string()])),
      overall: z.number().optional(),
      accuracy: z.record(z.string(), z.number()).optional(),
      labels: z.array(z.string()).optional()
    })
    .passthrough(),
  z
    .object({
      type: z.literal('calibration'),
      phase: z.literal('merge_applied'),
      zone: z.string(),
      name: z.string(),
      merged: z.tuple([z.string(), z.string()]),
      samples: z.number(),
      bindingsChanged: z.array(calibrationBindingChangedSchema),
      conflicts: z.array(z.tuple([z.string(), z.string()])),
      overall: z.number().optional(),
      accuracy: z.record(z.string(), z.number()).optional(),
      labels: z.array(z.string()).optional(),
      note: z.string().optional()
    })
    .passthrough()
])

const feedbackCandidateSchema = z
  .object({
    t: z.number(),
    zone: z.string().nullable().optional(),
    confidence: z.number().optional(),
    probability: z.number().optional(),
    strength: z.number().optional(),
    droppedBecause: z.string().optional(),
    skipped: z.string().optional()
  })
  .passthrough()

export const feedbackMsgSchema = z.discriminatedUnion('kind', [
  z
    .object({
      type: z.literal('feedback'),
      kind: z.literal('missed'),
      zone: z.string(),
      found: z.boolean(),
      diagnostic: z.string().nullable(),
      candidates: z.array(feedbackCandidateSchema),
      retrained: z.boolean(),
      reason: z.string().optional(),
      candidate: feedbackCandidateSchema.optional(),
      counts: z.record(z.string(), z.number()).optional(),
      overall: z.number().optional()
    })
    .passthrough(),
  z
    .object({
      type: z.literal('feedback'),
      kind: z.literal('false'),
      zone: z.string().optional(),
      t: z.number().optional(),
      retrained: z.boolean(),
      reason: z.string().optional(),
      peakG: z.number().optional(),
      counts: z.record(z.string(), z.number()).optional(),
      overall: z.number().optional()
    })
    .passthrough()
])

export const adaptationMsgSchema = z
  .object({
    type: z.literal('adaptation'),
    kept: z.boolean(),
    confirmed: z.number(),
    accuracyBefore: z.number(),
    accuracyAfter: z.number(),
    reason: z.string().optional()
  })
  .passthrough()

export const diagnosticsMsgSchema = z
  .object({
    type: z.literal('diagnostics'),
    path: z.string(),
    samples: z.number(),
    seconds: z.number()
  })
  .passthrough()

export const configMsgSchema = z
  .object({
    type: z.literal('config'),
    config: configSchema
  })
  .passthrough()

export const errorMsgSchema = z
  .object({
    type: z.literal('error'),
    message: z.string()
  })
  .passthrough()

export const approvedMsgSchema = z
  .object({
    type: z.literal('approved'),
    hash: z.string(),
    kind: z.string().nullable()
  })
  .passthrough()

export const revokedMsgSchema = z
  .object({
    type: z.literal('revoked'),
    hash: z.string(),
    found: z.boolean()
  })
  .passthrough()

export const integrationCatalogSchema = z.record(z.string(), z.unknown())

export const catalogMsgSchema = z
  .object({
    type: z.literal('catalog'),
    catalog: integrationCatalogSchema
  })
  .passthrough()

export const sessionMsgSchema = z
  .object({
    type: z.literal('session'),
    kind: z.enum(['sound', 'sonar', 'air']),
    active: z.boolean(),
    secondsLeft: z.number(),
    sonarField: z.boolean().optional(),
    continuous: z.boolean().optional(),
    enabled: z.boolean().optional(),
    waiting: z.enum(['paused', 'asleep', 'display_asleep', 'lid_closed']).optional(),
    tonesOff: z.string().optional(),
    coveredBy: z.string().optional(),
    simulated: z.boolean().optional(),
    reason: z.string().optional(),
    trigger: z.string().optional(),
    sonar: z.boolean().optional(),
    tapTypes: z.boolean().optional(),
    error: z.string().optional()
  })
  .passthrough()

export const airMsgSchema = z
  .object({
    type: z.literal('air'),
    t: z.number(),
    // Camera gestures, plus the continuous sonar values (source "sonar").
    gesture: z.enum(CONTINUOUS_AIR_GESTURES as unknown as [string, ...string[]]),
    phase: z.enum(['began', 'changed', 'ended']),
    hand: handSchema.optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    dx: z.number().optional(),
    dy: z.number().optional(),
    scale: z.number().optional(),
    confidence: z.number().optional(),
    side: sideSchema.optional(),
    value: z.number().optional(),
    displacementMm: z.number().optional(),
    dxMm: z.number().optional(),
    dyMm: z.number().optional(),
    cancelled: z.boolean().optional(),
    source: inputSourceSchema.optional()
  })
  .passthrough()

export const daemonMessageSchema = z.union([
  helloMsgSchema,
  statusMsgSchema,
  imuMsgSchema,
  lidMsgSchema,
  lightMsgSchema,
  tapMsgSchema,
  rejectedMsgSchema,
  candidateMsgSchema,
  gestureMsgSchema,
  actionMsgSchema,
  calibrationMsgSchema,
  feedbackMsgSchema,
  adaptationMsgSchema,
  diagnosticsMsgSchema,
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
  candidate: candidateMsgSchema,
  gesture: gestureMsgSchema,
  action: actionMsgSchema,
  calibration: calibrationMsgSchema,
  feedback: feedbackMsgSchema,
  adaptation: adaptationMsgSchema,
  diagnostics: diagnosticsMsgSchema,
  config: configMsgSchema,
  error: errorMsgSchema,
  approved: approvedMsgSchema,
  revoked: revokedMsgSchema,
  catalog: catalogMsgSchema,
  session: sessionMsgSchema,
  air: airMsgSchema
}
