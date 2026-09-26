// Actions that run arbitrary code or open arbitrary things need the user's explicit approval
// (docs/PROTOCOL.md, Authentication). The app shows the exact text in a native dialog, sends approve_action,
// and stores the hash the daemon replies with as `approvedHash` on the action. The daemon refuses anything else.
import type { Action, ActionKind, SimpleAction } from './protocol'

export const APPROVAL_KINDS: ActionKind[] = ['shell', 'applescript', 'shortcut', 'open']

type Approvable = Extract<SimpleAction, { approvedHash?: string }>

export function needsApprovalKind(a: SimpleAction): a is Approvable {
  return APPROVAL_KINDS.includes(a.kind)
}

/** The parts of an action that need approval (the action itself, or the matching steps of a macro). */
export function riskyParts(a: Action): Approvable[] {
  if (a.kind === 'macro') return a.steps.map(stripDelay).filter(needsApprovalKind)
  return needsApprovalKind(a) ? [a] : []
}

export function stripDelay(s: SimpleAction & { delayMs?: number }): SimpleAction {
  const { delayMs: _delay, ...rest } = s
  return rest as SimpleAction
}

/** What the daemon hashes: the action without approvedHash, label and delayMs. */
export function approvalPayload(a: Approvable): SimpleAction {
  const { approvedHash: _h, ...rest } = a as Approvable & { label?: string; delayMs?: number }
  delete (rest as { label?: string }).label
  delete (rest as { delayMs?: number }).delayMs
  return rest as SimpleAction
}

/** The exact text the user is approving. */
export function approvalText(a: SimpleAction): string {
  switch (a.kind) {
    case 'shell':
      return a.command
    case 'applescript':
      return a.source
    case 'shortcut':
      return `Run the Shortcut named "${a.name}"`
    case 'open':
      return `Open ${a.target}`
    default:
      return JSON.stringify(a)
  }
}

export function unapproved(a: Action): Approvable[] {
  return riskyParts(a).filter((p) => !p.approvedHash)
}

/** Keeps approvedHash only while the approved text is unchanged. */
export function keepApproval<T extends SimpleAction>(prev: SimpleAction | undefined, next: T): T {
  if (!needsApprovalKind(next)) return next
  const same = prev && prev.kind === next.kind && approvalText(prev) === approvalText(next)
  const prevHash = prev && needsApprovalKind(prev) ? prev.approvedHash : undefined
  const out = { ...next } as T & { approvedHash?: string }
  if (same && prevHash) out.approvedHash = prevHash
  else delete out.approvedHash
  return out
}

/** Writes hashes (in riskyParts order) back into the action. */
export function applyHashes(a: Action, hashes: (string | null)[]): Action {
  let i = 0
  const set = (p: SimpleAction): SimpleAction => {
    if (!needsApprovalKind(p)) return p
    const h = hashes[i++]
    return h ? ({ ...p, approvedHash: h } as SimpleAction) : p
  }
  if (a.kind === 'macro') return { ...a, steps: a.steps.map((s) => ({ ...set(s), ...(s.delayMs !== undefined ? { delayMs: s.delayMs } : {}) }) as typeof s) }
  return set(a)
}
