import type { Config, Settings } from '@ghostkeys/sdk'
import pc from 'picocolors'

interface Identified {
  id: string
}

function diffById<T extends Identified>(label: string, before: T[], after: T[], lines: string[]): void {
  const beforeMap = new Map(before.map((x) => [x.id, x]))
  const afterMap = new Map(after.map((x) => [x.id, x]))
  for (const [id, a] of afterMap) {
    const b = beforeMap.get(id)
    if (!b) lines.push(pc.green(`  + ${label} ${id}`))
    else if (JSON.stringify(b) !== JSON.stringify(a)) lines.push(pc.yellow(`  ~ ${label} ${id}`))
  }
  for (const id of beforeMap.keys()) {
    if (!afterMap.has(id)) lines.push(pc.red(`  - ${label} ${id}`))
  }
}

/** A readable, id-keyed diff between two configs: zones, bindings and settings. Pure, no I/O. */
export function diffConfig(current: Config, next: Config): string[] {
  const lines: string[] = []
  diffById('zone', current.zones, next.zones, lines)
  diffById('binding', current.bindings, next.bindings, lines)

  const before = current.settings
  const after = next.settings
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    // sound/camera are nested objects: compare by value, not by reference, or two structurally
    // identical configs from different sources (e.g. a round trip through JSON) would always "differ".
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      lines.push(pc.yellow(`  ~ settings.${key}: ${JSON.stringify(before[key])} to ${JSON.stringify(after[key])}`))
    }
  }

  if (lines.length === 0) lines.push(pc.dim('  no changes'))
  return lines
}
