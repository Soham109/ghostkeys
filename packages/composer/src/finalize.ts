/**
 * Turn a draft (from the model or the offline parser) into validated, hardened bindings.
 * Every check here is code, independent of any prompt.
 */
import { bundleForIntegration, findAppByName } from './apps.js'
import { detectConflicts, type Conflict } from './conflicts.js'
import { explainBinding } from './explain.js'
import { checkAction, enforceDestructive, type DestructiveReason } from './guardrails.js'
import { labelFor } from './explain.js'
import {
  BindingSchema,
  DEVICE_GESTURES,
  KNOWN_INTEGRATION_COMMANDS,
  ZONE_GESTURES,
  formatIssues,
  type Action,
  type Binding,
  type Gesture
} from './schema.js'
import type { BindingDraft, ComposeContext, ComposeOk, ComposeRejected, ComposeSource } from './types.js'

export type FinalizeOutcome =
  | { kind: 'ok'; result: ComposeOk }
  /** Shape or reference errors the model can fix on a retry. */
  | { kind: 'retryable'; errors: string[] }
  | { kind: 'final'; result: ComposeRejected }

const SENSOR_FOR: Partial<Record<Gesture, 'imu' | 'gyro' | 'lid' | 'light'>> = {
  tap: 'imu',
  double: 'imu',
  triple: 'imu',
  sequence: 'imu',
  rhythm: 'imu',
  lid_nudge: 'lid',
  cover: 'light',
  cover_hold: 'light',
  tilt_left: 'gyro',
  tilt_right: 'gyro'
}
const SENSOR_TEXT = { imu: 'motion sensor', gyro: 'gyroscope', lid: 'lid angle sensor', light: 'ambient light sensor' }

function nextIds(existing: readonly { id: string }[], n: number): string[] {
  const taken = new Set(existing.map((b) => b.id))
  const ids: string[] = []
  let i = 1
  while (ids.length < n) {
    const id = `ai-${i++}`
    if (!taken.has(id)) ids.push(id)
  }
  return ids
}

export function normalizeApp(app: string): string {
  const a = app.trim()
  if (a === '*' || a === '' || /^(any|all|every|everywhere|global)( ?apps?)?$/i.test(a)) return '*'
  return findAppByName(a)?.bundleId ?? a
}

function rejected(source: ComposeSource, reason: 'unsafe' | 'impossible', explanation: string, violations: ComposeRejected['violations'] = []): FinalizeOutcome {
  return { kind: 'final', result: { status: 'rejected', source, reason, explanation, violations, attempts: 0 } }
}

export function finalizeDraft(draft: BindingDraft, ctx: ComposeContext, source: ComposeSource): FinalizeOutcome {
  const zones = ctx.config.zones
  const zoneIds = new Set(zones.map((z) => z.id))
  const warnings: string[] = []
  const adjustments: string[] = []
  let app = normalizeApp(draft.app)
  const action: Action = draft.action

  // 1. Device capabilities: a gesture the hardware cannot sense is impossible, not retryable.
  const sensor = SENSOR_FOR[draft.gesture]
  if (sensor && ctx.device?.sensors && ctx.device.sensors[sensor] === false) {
    return rejected(source, 'impossible', `This Mac has no ${SENSOR_TEXT[sensor]} available, so it cannot detect that gesture.`)
  }

  // 2. Safety: blocked patterns anywhere in the action are final.
  const violations = checkAction(action)
  if (violations.length) {
    const first = violations[0]!
    return rejected(source, 'unsafe', `Blocked for safety because the ${first.message}.`, violations)
  }

  // 3. Integrations only work inside their app: scope the binding when it was left global.
  if (action.kind === 'integration') {
    const bundle = bundleForIntegration(action.app)
    if (bundle && app === '*') {
      app = bundle
      adjustments.push(`Scoped the binding to ${action.app} because the integration only works there.`)
    }
    const known = KNOWN_INTEGRATION_COMMANDS[action.app]
    if (known && !known.includes(action.command))
      warnings.push(`"${action.command}" is not a documented ${action.app} integration command, so the daemon may not support it.`)
  }
  const steps = action.kind === 'macro' ? action.steps : [action]
  if (steps.some((s) => s.kind === 'integration')) warnings.push('Integrations need Automation permission for the target app.')
  if (steps.some((s) => s.kind === 'keystroke' || s.kind === 'text' || s.kind === 'window'))
    warnings.push('This action needs Accessibility permission.')

  // 4. Expand "anywhere" and build protocol bindings.
  const isZoneGesture = (ZONE_GESTURES as readonly string[]).includes(draft.gesture)
  let triggers: { zone: string | null; zones: string[] | null }[]
  if ((DEVICE_GESTURES as readonly string[]).includes(draft.gesture)) {
    triggers = [{ zone: null, zones: null }]
  } else if (draft.gesture === 'sequence') {
    triggers = [{ zone: draft.zones?.[0] ?? draft.zone, zones: draft.zones }]
  } else if (draft.allZones) {
    if (zones.length === 0) return { kind: 'retryable', errors: ['no zones are configured, so "anywhere" cannot be expanded'] }
    triggers = zones.map((z) => ({ zone: z.id, zones: null }))
  } else {
    triggers = [{ zone: draft.zone, zones: null }]
  }

  const errors: string[] = []
  if (isZoneGesture) {
    for (const t of triggers) {
      for (const z of t.zones ?? [t.zone]) {
        if (z && !zoneIds.has(z))
          errors.push(`zone "${z}" is not configured; configured zones are ${[...zoneIds].join(', ') || 'none'}`)
      }
    }
  }

  const label = labelFor(action)
  const ids = nextIds(ctx.config.bindings, triggers.length)
  const bindings: Binding[] = []
  for (const [i, t] of triggers.entries()) {
    const candidate = {
      id: ids[i]!,
      enabled: true,
      gesture: draft.gesture,
      zone: t.zone,
      zones: t.zones,
      modifiers: [...new Set(draft.modifiers)],
      app,
      action,
      label
    }
    const parsed = BindingSchema.safeParse(candidate)
    if (!parsed.success) errors.push(...formatIssues(parsed.error))
    else bindings.push(parsed.data)
  }
  if (errors.length) return { kind: 'retryable', errors: [...new Set(errors)] }

  // 5. Destructive actions: force a deliberate gesture and a confirmation.
  let destructive = false
  let reasons: DestructiveReason[] = []
  const hardened = bindings.map((b) => {
    const e = enforceDestructive(b)
    destructive ||= e.destructive
    reasons = e.reasons
    for (const a of e.adjustments) if (!adjustments.includes(a)) adjustments.push(a)
    return e.binding
  })

  // 6. Conflicts with existing bindings.
  const conflicts: Conflict[] = []
  for (const b of hardened) conflicts.push(...detectConflicts(b, ctx.config.bindings))

  const explanation = explainBinding(hardened, zones, { destructive })
  return {
    kind: 'ok',
    result: {
      status: 'ok',
      source,
      binding: hardened[0]!,
      bindings: hardened,
      explanation,
      destructive,
      destructiveReasons: reasons,
      requiresConfirmation: destructive,
      conflicts,
      warnings,
      adjustments,
      attempts: 0
    }
  }
}
