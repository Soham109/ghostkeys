/** Detect when a new binding collides with bindings already in the config. */
import { appDisplayName } from './apps.js'
import type { Gesture, Modifier } from './schema.js'

/** The fields conflict detection needs. Existing config bindings are read loosely. */
export interface BindingTrigger {
  id: string
  enabled?: boolean
  gesture: Gesture | string
  zone: string | null
  zones?: string[] | null
  modifiers?: Modifier[] | string[]
  app?: string
  label?: string
}

export type ConflictKind =
  /** Same trigger, same app layer: only one of them can run. */
  | 'duplicate'
  /** The new binding is app-specific and will win over an existing "*" binding inside that app. */
  | 'overrides'
  /** The new binding is "*" and an existing app-specific binding will win over it inside that app. */
  | 'overridden'

export interface Conflict {
  kind: ConflictKind
  bindingId: string
  label: string
  enabled: boolean
  message: string
}

function triggerKey(b: BindingTrigger): string {
  const zones =
    b.gesture === 'sequence' ? (b.zones ?? []).join('>') : b.zone === null || b.zone === undefined ? '-' : b.zone
  const mods = [...(b.modifiers ?? [])].map(String).sort().join('+')
  return `${b.gesture}|${zones}|${mods}`
}

export function sameTrigger(a: BindingTrigger, b: BindingTrigger): boolean {
  return triggerKey(a) === triggerKey(b)
}

export function detectConflicts(candidate: BindingTrigger, existing: readonly BindingTrigger[]): Conflict[] {
  const out: Conflict[] = []
  const candApp = candidate.app ?? '*'
  for (const e of existing) {
    if (e.id === candidate.id) continue
    if (!sameTrigger(candidate, e)) continue
    const eApp = e.app ?? '*'
    const label = e.label ?? e.id
    const enabled = e.enabled !== false
    const off = enabled ? '' : ' (currently disabled)'
    if (eApp === candApp) {
      out.push({
        kind: 'duplicate',
        bindingId: e.id,
        label,
        enabled,
        message: `The same gesture is already bound to "${label}" in ${appDisplayName(eApp)}${off}; saving both means only one runs.`
      })
    } else if (eApp === '*') {
      out.push({
        kind: 'overrides',
        bindingId: e.id,
        label,
        enabled,
        message: `Inside ${appDisplayName(candApp)} this replaces the everywhere binding "${label}"${off}.`
      })
    } else if (candApp === '*') {
      out.push({
        kind: 'overridden',
        bindingId: e.id,
        label,
        enabled,
        message: `Inside ${appDisplayName(eApp)} the existing binding "${label}"${off} still wins over this one.`
      })
    }
  }
  return out
}
