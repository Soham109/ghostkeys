// Actions that run arbitrary code or open arbitrary things need the user's explicit approval
// (docs/audit/SAFETY_AUDIT.md H4). The daemon refuses unapproved ones; the app asks, then sends approve_action.
import type { Action, ActionKind, SimpleAction } from './protocol'

export const APPROVAL_KINDS: ActionKind[] = ['shell', 'applescript', 'shortcut', 'open']

/** The steps of an action that need approval (the action itself, or the risky steps of a macro). */
export function riskyParts(a: Action): SimpleAction[] {
  if (a.kind === 'macro') return a.steps.filter((s) => APPROVAL_KINDS.includes(s.kind)).map(stripDelay)
  return APPROVAL_KINDS.includes(a.kind) ? [a] : []
}

export function stripDelay(s: SimpleAction & { delayMs?: number }): SimpleAction {
  const { delayMs: _delay, ...rest } = s
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
      return `Shortcut: ${a.name}`
    case 'open':
      return `Open: ${a.target}`
    default:
      return JSON.stringify(a)
  }
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => k !== 'delayMs')
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** Stable key for "this exact action was approved". Changing any text changes the key. */
export function approvalKey(a: SimpleAction): string {
  const str = canonical(a)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `${a.kind}:${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}:${str.length}`
}

export function unapproved(a: Action, approved: ReadonlySet<string> | readonly string[]): SimpleAction[] {
  const set = approved instanceof Set ? approved : new Set(approved)
  return riskyParts(a).filter((p) => !set.has(approvalKey(p)))
}
