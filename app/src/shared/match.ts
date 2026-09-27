import type { Config, GestureMsg } from './protocol'
import { ZONELESS_GESTURES } from './protocol'

/** Does an enabled binding match this gesture? Mirrors the daemon's BindingResolver. */
export function matchesBinding(config: Config | null, g: GestureMsg): boolean {
  if (!config) return true
  const held = [...g.modifiers].sort().join('+')
  return config.bindings.some((b) => {
    if (!b.enabled || b.gesture !== g.gesture) return false
    if ([...b.modifiers].sort().join('+') !== held) return false
    if (b.app !== '*' && b.app !== g.app) return false
    if (g.gesture === 'sequence') return JSON.stringify(b.zones ?? []) === JSON.stringify(g.zones ?? [])
    if (ZONELESS_GESTURES.includes(g.gesture)) return !b.zone || !g.zone || b.zone === g.zone
    return !!b.zone && b.zone === g.zone
  })
}

/** Bound gestures only, unless the user asked to see every detection. */
export function isShown(config: Config | null, g: GestureMsg, showAll: boolean): boolean {
  return showAll || (g.bound ?? matchesBinding(config, g))
}
