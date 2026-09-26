import { toast } from 'sonner'
import type { Action, SimpleAction } from '@shared/protocol'
import { riskyParts, unapproved } from '@shared/approval'
import { useStore } from './store'

export function approvedKeys(): string[] {
  return useStore.getState().info?.prefs.approved ?? []
}

export function needsApproval(a: Action, approved: string[] = approvedKeys()): SimpleAction[] {
  return unapproved(a, approved)
}

export function isRisky(a: Action): boolean {
  return riskyParts(a).length > 0
}

/**
 * Makes sure every shell, AppleScript, Shortcut and open step in these actions was approved by the
 * user in a native dialog showing the exact text. Resolves false if the user declines.
 */
export async function ensureApproved(actions: Action[], context: string): Promise<boolean> {
  const approved = approvedKeys()
  const pending = actions.flatMap((a) => needsApproval(a, approved))
  if (!pending.length) return true
  const next = await window.gk.approve(pending, context)
  if (!next) {
    toast('Not approved', { description: 'Nothing was run or saved.' })
    return false
  }
  const info = useStore.getState().info
  if (info) useStore.setState({ info: { ...info, prefs: { ...info.prefs, approved: next } } })
  return true
}

/** Hook-friendly: is this exact action approved right now? */
export function useApproval(a: Action): 'none' | 'approved' | 'pending' {
  const approved = useStore((s) => s.info?.prefs.approved)
  if (!isRisky(a)) return 'none'
  return unapproved(a, approved ?? []).length ? 'pending' : 'approved'
}
