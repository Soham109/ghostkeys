import type { Action, Modifier } from '@ghostkeys/sdk'

const MODIFIER_WORD: Record<Modifier, string> = {
  control: 'ctrl',
  option: 'opt',
  shift: 'shift',
  command: 'cmd',
  fn: 'fn'
}

const MODIFIER_ORDER: Modifier[] = ['fn', 'control', 'option', 'shift', 'command']

export function comboText(key: string, modifiers: Modifier[]): string {
  const mods = MODIFIER_ORDER.filter((m) => modifiers.includes(m)).map((m) => MODIFIER_WORD[m])
  return [...mods, key].join('+')
}

/** A short, human summary of an action: used in table rows and default binding labels. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'keystroke':
      return `press ${comboText(a.key, a.modifiers)}`
    case 'volume':
      return a.step >= 0 ? `volume up ${a.step}%` : `volume down ${Math.abs(a.step)}%`
    case 'mute':
      return 'mute or unmute'
    case 'media':
      return `media: ${a.command}`
    case 'brightness':
      return `brightness ${a.step >= 0 ? '+' : ''}${a.step}`
    case 'open':
      return `open ${a.target}`
    case 'shell':
      return `shell: ${firstLine(a.command)}`
    case 'applescript':
      return 'run applescript'
    case 'shortcut':
      return `run shortcut "${a.name}"`
    case 'text':
      return `type ${JSON.stringify(truncate(a.text, 24))}`
    case 'clipboard':
      return 'copy to clipboard'
    case 'window':
      return `window: ${a.op}`
    case 'app':
      return `app: ${a.op}`
    case 'integration':
      return `${a.app}: ${a.command}`
    case 'system':
      return `system: ${a.op}`
    case 'macro':
      return `macro (${a.steps.length} step${a.steps.length === 1 ? '' : 's'})`
  }
}

/** True for actions that can quit an app (destructive), including inside a macro. */
export function isDestructive(a: Action): boolean {
  if (a.kind === 'app' && a.op === 'quit') return true
  if (a.kind === 'macro') return a.steps.some((s) => s.kind === 'app' && s.op === 'quit')
  return false
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? ''
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}...` : s
}
