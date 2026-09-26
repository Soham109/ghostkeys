import * as React from 'react'
import { MODIFIERS, MODIFIER_GLYPH, type Modifier } from '@shared/protocol'
import { keyGlyph, sortModifiers } from '@shared/actions'
import { cn } from '@/lib/utils'

const CODE_TO_KEY: Record<string, string> = {
  Space: 'space',
  Enter: 'return',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Backspace: 'delete',
  Delete: 'forwarddelete',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

export function keyFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = e.code
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase()
  return CODE_TO_KEY[code] ?? null
}

function modsFromEvent(e: React.KeyboardEvent): Modifier[] {
  const m: Modifier[] = []
  if (e.ctrlKey) m.push('control')
  if (e.altKey) m.push('option')
  if (e.shiftKey) m.push('shift')
  if (e.metaKey) m.push('command')
  if (e.getModifierState?.('Fn')) m.push('fn')
  return m
}

/** The whole field is the target: click it, then press a shortcut. */
export function KeystrokeRecorder({
  value,
  onChange
}: {
  value: { key: string; modifiers: Modifier[] }
  onChange: (v: { key: string; modifiers: Modifier[] }) => void
}): React.JSX.Element {
  const [recording, setRecording] = React.useState(false)
  const [live, setLive] = React.useState<Modifier[]>([])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!recording) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setRecording(true)
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const mods = modsFromEvent(e)
    setLive(mods)
    const key = keyFromEvent(e)
    if (!key) return
    if (key === 'escape' && mods.length === 0) {
      setRecording(false)
      return
    }
    onChange({ key, modifiers: sortModifiers(mods) })
    setRecording(false)
    setLive([])
  }

  const combo = recording
    ? live.length
      ? sortModifiers(live).map((m) => MODIFIER_GLYPH[m]).join('')
      : ''
    : sortModifiers(value.modifiers).map((m) => MODIFIER_GLYPH[m]).join('') + keyGlyph(value.key)
  return (
    <button
      type="button"
      onClick={() => setRecording((r) => !r)}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => recording && setLive(modsFromEvent(e))}
      onBlur={() => setRecording(false)}
      aria-label={recording ? 'Recording. Press a shortcut, or Escape to cancel.' : `Shortcut ${combo}. Click to record a new one.`}
      className={cn(
        'flex h-9 w-full items-center gap-3 rounded-[6px] px-3 text-left transition-shadow duration-150',
        recording
          ? 'animate-[breathe_1.4s_ease-in-out_infinite] bg-fill shadow-[inset_0_0_0_1px_var(--ink)]'
          : 'bg-fill shadow-[inset_0_0_0_1px_var(--hairline)] hover:shadow-[inset_0_0_0_1px_var(--hairline-strong)]'
      )}
    >
      <span className="num text-[15px] tracking-[0.04em] text-ink">{combo}</span>
      <span className="text-[13px] text-ink-3">{recording ? (combo ? 'now a key' : 'Press a shortcut') : ''}</span>
    </button>
  )
}

export function ModifierChips({ value, onChange, label }: { value: Modifier[]; onChange: (m: Modifier[]) => void; label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      {MODIFIERS.map((m) => {
        const on = value.includes(m)
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            aria-label={m}
            onClick={() => onChange(sortModifiers(on ? value.filter((x) => x !== m) : [...value, m]))}
            className={cn(
              'inline-flex h-7 min-w-8 items-center justify-center rounded-[6px] px-2 font-mono text-[12px] transition-colors duration-150',
              on ? 'bg-fill-active text-ink shadow-[inset_0_0_0_1px_var(--hairline-strong)]' : 'text-ink-3 hover:text-ink-2'
            )}
          >
            {MODIFIER_GLYPH[m]}
          </button>
        )
      })}
    </div>
  )
}
