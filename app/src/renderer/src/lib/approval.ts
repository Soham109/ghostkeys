import { toast } from 'sonner'
import type { Action, Config } from '@shared/protocol'
import { applyHashes, riskyParts, unapproved } from '@shared/approval'

export function isRisky(a: Action): boolean {
  return riskyParts(a).length > 0
}

export function approvalState(a: Action): 'none' | 'approved' | 'pending' {
  if (!isRisky(a)) return 'none'
  return unapproved(a).length ? 'pending' : 'approved'
}

/**
 * One native dialog for every unapproved shell, AppleScript, Shortcut and open step in `actions`.
 * Returns the actions with the daemon's approvedHash filled in, or null if the user declined.
 */
async function approveAll(actions: Action[], context: string): Promise<Action[] | null> {
  const pendingPer = actions.map((a) => riskyParts(a).map((p) => !p.approvedHash))
  const pending = actions.flatMap((a) => unapproved(a))
  if (!pending.length) return actions
  const hashes = await window.gk.approve(pending, context)
  if (!hashes) {
    toast('Not approved', { description: 'Nothing was run or saved.' })
    return null
  }
  if (hashes.some((h) => !h)) {
    toast('The service did not confirm the approval', { description: 'Check that Ghostkeys is running, then try again.' })
    return null
  }
  let k = 0
  return actions.map((a, i) => {
    const perPart = pendingPer[i]!.map((isPending) => (isPending ? (hashes[k++] ?? null) : null))
    return perPart.some(Boolean) ? applyHashes(a, perPart) : a
  })
}

export async function ensureActionApproved(a: Action, context: string): Promise<Action | null> {
  const r = await approveAll([a], context)
  return r ? r[0]! : null
}

/** Every enabled binding's action (and knob inverse) must be approved before a save. */
export async function ensureApproved(config: Config, context: string): Promise<Config | null> {
  const slots: { b: number; inverse: boolean }[] = []
  const actions: Action[] = []
  config.bindings.forEach((b, i) => {
    if (!b.enabled) return
    slots.push({ b: i, inverse: false })
    actions.push(b.action)
    if (b.knob?.inverse) {
      slots.push({ b: i, inverse: true })
      actions.push(b.knob.inverse)
    }
  })
  const r = await approveAll(actions, context)
  if (!r) return null
  const out = structuredClone(config)
  slots.forEach((s, i) => {
    const b = out.bindings[s.b]!
    if (s.inverse && b.knob) b.knob.inverse = r[i]!
    else b.action = r[i]!
  })
  return out
}
