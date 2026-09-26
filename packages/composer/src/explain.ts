/** Plain-English, one-sentence explanations and labels. Built in code, never taken from the model. */
import { appDisplayName } from './apps.js'
import type { Action, Binding, LeafAction, Modifier, Zone } from './schema.js'

const MOD_NAMES: Record<Modifier, string> = { shift: 'Shift', control: 'Control', option: 'Option', command: 'Command', fn: 'Fn' }

/** Remove em and en dashes (and their lookalikes) and collapse to a single sentence. */
export function sanitizeSentence(s: string): string {
  let out = s
    .replace(/\s*[‒–—―⸺⸻﹘﹣]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
  // Keep only the first sentence.
  const m = out.match(/^(.+?[.!?])(\s|$)/)
  if (m?.[1]) out = m[1]
  if (!/[.!?]$/.test(out)) out += '.'
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export function hasDash(s: string): boolean {
  return /[‒–—―⸺⸻﹘﹣]/.test(s)
}

function zoneName(id: string | null | undefined, zones: readonly Zone[]): string {
  if (!id) return 'laptop'
  const z = zones.find((x) => x.id === id)
  return (z?.name ?? id.replace(/-/g, ' ')).toLowerCase()
}

function joinWords(list: string[]): string {
  if (list.length <= 1) return list.join('')
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

export function describeTrigger(b: Pick<Binding, 'gesture' | 'zone' | 'zones' | 'modifiers'>, zones: readonly Zone[], anywhere = false): string {
  const z = anywhere ? 'anywhere' : `the ${zoneName(b.zone, zones)}`
  let g: string
  switch (b.gesture) {
    case 'tap':
      g = `tapping ${z}`
      break
    case 'double':
      g = `double tapping ${z}`
      break
    case 'triple':
      g = `triple tapping ${z}`
      break
    case 'rhythm':
      g = `tapping ${z} in the tap, pause, double tap rhythm`
      break
    case 'sequence':
      g = `tapping the ${zoneName(b.zones?.[0], zones)} then the ${zoneName(b.zones?.[1], zones)}`
      break
    case 'lid_nudge':
      g = 'nudging the lid back and forth'
      break
    case 'cover':
      g = 'briefly covering the light sensor'
      break
    case 'cover_hold':
      g = 'covering the light sensor and holding'
      break
    case 'tilt_left':
      g = 'tilting the laptop left'
      break
    case 'tilt_right':
      g = 'tilting the laptop right'
      break
  }
  if (b.modifiers.length) g += ` while holding ${joinWords(b.modifiers.map((m) => MOD_NAMES[m]))}`
  return g
}

function keyCombo(key: string, mods: readonly Modifier[]): string {
  const k = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1)
  return [...mods.map((m) => MOD_NAMES[m]), k].join(' ')
}

function quote(s: string, max = 40): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return `"${one.length > max ? `${one.slice(0, max - 3)}...` : one}"`
}

const KEY_MEANINGS: Record<string, string> = {
  'Command W': 'close the window or tab',
  'Command Q': 'quit the app',
  'Command Option Escape': 'open Force Quit',
  'Command Z': 'undo',
  'Command C': 'copy',
  'Command V': 'paste'
}

const WINDOW_TEXT: Record<string, string> = {
  left: 'snaps the window to the left half',
  right: 'snaps the window to the right half',
  top: 'snaps the window to the top half',
  bottom: 'snaps the window to the bottom half',
  maximize: 'maximizes the window',
  center: 'centers the window',
  'next-display': 'moves the window to the next display',
  minimize: 'minimizes the window',
  fullscreen: 'toggles full screen'
}
const SYSTEM_TEXT: Record<string, string> = {
  lock: 'locks the screen',
  'sleep-display': 'puts the display to sleep',
  screenshot: 'takes a screenshot',
  'screenshot-area': 'takes a screenshot of an area you pick',
  'dnd-toggle': 'toggles Do Not Disturb',
  'mission-control': 'opens Mission Control',
  launchpad: 'opens Launchpad',
  'show-desktop': 'shows the desktop'
}
const APP_TEXT: Record<string, string> = {
  hide: 'hides the frontmost app',
  quit: 'quits the frontmost app',
  'switch-next': 'switches to the next app',
  'switch-previous': 'switches to the previous app'
}
const MEDIA_TEXT: Record<string, string> = { playpause: 'plays or pauses media', next: 'skips to the next track', previous: 'goes back to the previous track' }

function integrationText(a: Extract<LeafAction, { kind: 'integration' }>): string {
  if (a.app === 'excel') {
    switch (a.command) {
      case 'wrap-iferror': {
        const fb = a.args?.['fallback'] ?? a.args?.['value']
        return fb === undefined ? 'wraps the formula in IFERROR' : `wraps the formula in IFERROR with ${quote(String(fb))} as the fallback`
      }
      case 'toggle-absolute':
        return 'toggles absolute references in the formula'
      case 'cycle-number-format':
        return 'cycles the number format'
      case 'insert-xlookup':
        return 'inserts an XLOOKUP'
    }
  }
  return `runs the ${a.app} ${a.command.replace(/-/g, ' ')} command`
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case 'macro': {
      const parts = a.steps.map((s) => {
        const { delayMs, ...leaf } = s
        const d = delayMs ? `waits ${delayMs} ms and ` : ''
        return d + describeAction(leaf as LeafAction)
      })
      return joinWords(parts)
    }
    case 'keystroke': {
      const combo = keyCombo(a.key, a.modifiers)
      const meaning = KEY_MEANINGS[combo]
      return `presses ${combo}${meaning ? ` to ${meaning}` : ''}`
    }
    case 'volume':
      return `turns the volume ${a.step > 0 ? 'up' : 'down'} by ${Math.abs(a.step)} percent`
    case 'mute':
      return 'toggles mute'
    case 'media':
      return MEDIA_TEXT[a.command] ?? 'controls media'
    case 'brightness':
      return `turns the brightness ${a.step > 0 ? 'up' : 'down'}`
    case 'open':
      return `opens ${/^[a-z]+:\/\//i.test(a.target) ? a.target : a.target}`
    case 'shell':
      return `runs the shell command ${quote(a.command)}`
    case 'applescript':
      return `runs the AppleScript ${quote(a.source.replace(/"/g, ''), 60)}`
    case 'shortcut':
      return `runs the ${quote(a.name)} shortcut`
    case 'text':
      return `types ${quote(a.text)}`
    case 'clipboard':
      return `copies ${quote(a.text)} to the clipboard`
    case 'window':
      return WINDOW_TEXT[a.op] ?? 'moves the window'
    case 'app':
      return APP_TEXT[a.op] ?? 'acts on the frontmost app'
    case 'integration':
      return integrationText(a)
    case 'system':
      return SYSTEM_TEXT[a.op] ?? 'runs a system command'
  }
}

/** "turns the volume up" -> "turn the volume up". */
function imperative(d: string): string {
  const verb = (w: string): string => {
    if (w === 'copies') return 'copy'
    if (w === 'goes') return 'go'
    if (/(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2)
    return w.endsWith('s') ? w.slice(0, -1) : w
  }
  return d.replace(/^(\w+)( or (\w+))?/, (_m, a: string, _o?: string, b?: string) => (b ? `${verb(a)} or ${verb(b)}` : verb(a)))
}

/** Short label for the binding list, e.g. "Wrap in IFERROR" or "Lock screen and play or pause". */
export function labelFor(a: Action): string {
  const leaves = a.kind === 'macro' ? a.steps.map(({ delayMs: _d, ...leaf }) => leaf as LeafAction) : [a]
  const s = joinWords(leaves.map((l, i) => {
    const d = imperative(describeAction(l))
    return i === 0 ? d.charAt(0).toUpperCase() + d.slice(1) : d
  }))
  return s.length > 60 ? `${s.slice(0, 57)}...` : s
}

export function explainBinding(bindings: readonly Binding[], zones: readonly Zone[], opts: { destructive?: boolean } = {}): string {
  const b = bindings[0]
  if (!b) return 'Nothing was bound.'
  const where = b.app === '*' ? '' : ` in ${appDisplayName(b.app)}`
  const trigger = describeTrigger(b, zones, bindings.length > 1 && b.gesture !== 'sequence')
  const confirm = opts.destructive ? ', after you confirm it once' : ''
  return sanitizeSentence(`${trigger}${where} ${describeAction(b.action)}${confirm}.`)
}
