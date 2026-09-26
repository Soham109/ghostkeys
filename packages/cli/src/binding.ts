import type { Action, Binding, Zone } from '@ghostkeys/sdk'
import { describeAction } from './describe.js'
import type { ParsedBindSpec } from './grammar.js'

/** Picks the next "bN" id after the highest existing one, falling back to a timestamp-based id. */
export function nextBindingId(bindings: Binding[]): string {
  let max = 0
  for (const b of bindings) {
    const m = /^b(\d+)$/.exec(b.id)
    if (m?.[1]) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  if (max > 0 || bindings.every((b) => /^b\d+$/.test(b.id))) return `b${max + 1}`
  return `b-${Date.now().toString(36)}`
}

/** Zone ids named by `spec` that don't exist in `zones`. Empty when everything checks out. */
export function unknownZones(spec: ParsedBindSpec, zones: Zone[]): string[] {
  const known = new Set(zones.map((z) => z.id))
  const named = spec.zone ? [spec.zone] : (spec.zones ?? [])
  return named.filter((z) => !known.has(z))
}

export interface BuildBindingOptions {
  id: string
  enabled?: boolean
  label?: string
}

/** Pure: turns a parsed bind spec + resolved action into a `Binding` ready to append to a config. */
export function buildBinding(spec: ParsedBindSpec, action: Action, opts: BuildBindingOptions): Binding {
  return {
    id: opts.id,
    enabled: opts.enabled ?? true,
    gesture: spec.gesture,
    zone: spec.zone,
    zones: spec.zones,
    modifiers: spec.modifiers,
    app: spec.app,
    action,
    label: opts.label ?? describeAction(action)
  }
}

export function describeBinding(b: Binding): string {
  const target = b.zone ?? (b.zones ? b.zones.join(' then ') : 'anywhere')
  const mods = b.modifiers.length ? `+${b.modifiers.join('+')} ` : ''
  const app = b.app === '*' ? '' : ` in ${b.app}`
  return `${b.gesture} ${mods}${target}${app} -> ${describeAction(b.action)}`
}
