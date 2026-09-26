import type { Binding, Config, Zone } from '@shared/protocol'
import { GESTURE_LABEL, ZONELESS_GESTURES } from '@shared/protocol'
import { sortModifiers } from '@shared/actions'

export function triggerKey(b: Binding): string {
  const where = ZONELESS_GESTURES.includes(b.gesture) ? '-' : b.gesture === 'sequence' ? (b.zones ?? []).join('>') : (b.zone ?? '')
  return [b.gesture, where, sortModifiers(b.modifiers).join('+'), b.app].join('|')
}

export function zoneById(zones: Zone[], id: string | null | undefined): Zone | undefined {
  return id ? zones.find((z) => z.id === id) : undefined
}

export function whereText(b: Binding, zones: Zone[]): string {
  if (ZONELESS_GESTURES.includes(b.gesture)) return 'Whole laptop'
  if (b.gesture === 'sequence') {
    const zs = (b.zones ?? []).map((id) => zoneById(zones, id)?.name ?? id)
    return zs.length ? zs.join(' then ') : 'Pick two zones'
  }
  return zoneById(zones, b.zone)?.name ?? (b.zone ? `${b.zone} (missing)` : 'Pick a zone')
}

export function triggerText(b: Binding, zones: Zone[]): string {
  return `${whereText(b, zones)}, ${GESTURE_LABEL[b.gesture].toLowerCase()}`
}

export function bindingsForZone(config: Config, zoneId: string): Binding[] {
  return config.bindings.filter((b) => b.zone === zoneId || (b.gesture === 'sequence' && b.zones?.includes(zoneId)))
}

export interface Conflict {
  kind: 'duplicate' | 'delay' | 'missing-zone'
  message: string
}

export function conflictsFor(config: Config): Record<string, Conflict[]> {
  const out: Record<string, Conflict[]> = {}
  const add = (id: string, c: Conflict): void => {
    ;(out[id] ??= []).push(c)
  }
  const enabled = config.bindings.filter((b) => b.enabled)
  const seen = new Map<string, Binding>()
  for (const b of enabled) {
    const k = triggerKey(b)
    const first = seen.get(k)
    if (first) {
      add(b.id, { kind: 'duplicate', message: `Same trigger as "${first.label}". Only one of them will run.` })
      add(first.id, { kind: 'duplicate', message: `Same trigger as "${b.label}". Only one of them will run.` })
    } else seen.set(k, b)
  }
  const windowS = (config.settings.doubleWindowMs / 1000).toFixed(2).replace(/0$/, '')
  for (const b of enabled) {
    if (b.gesture !== 'tap' || !b.zone) continue
    const multi = enabled.find(
      (o) => (o.gesture === 'double' || o.gesture === 'triple' || o.gesture === 'rhythm') && o.zone === b.zone && (o.app === b.app || o.app === '*' || b.app === '*')
    )
    if (multi) add(b.id, { kind: 'delay', message: `Waits ${windowS} s to rule out a ${GESTURE_LABEL[multi.gesture].toLowerCase()} here.` })
  }
  for (const b of config.bindings) {
    const ids = ZONELESS_GESTURES.includes(b.gesture) ? [] : b.gesture === 'sequence' ? (b.zones ?? []) : [b.zone ?? '']
    if (ids.some((id) => !config.zones.some((z) => z.id === id))) add(b.id, { kind: 'missing-zone', message: 'Its zone no longer exists.' })
  }
  return out
}
