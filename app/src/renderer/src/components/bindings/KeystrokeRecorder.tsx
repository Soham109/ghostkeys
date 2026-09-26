import * as React from 'react'
import { MODIFIERS, MODIFIER_GLYPH, type Modifier } from '@shared/protocol'
import { keyGlyph, sortModifiers } from '@shared/actions'
import { cn } from '@/lib/utils'
import { Kbd } from '../ui/controls'

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

/** Click, then press a key combination. The fn chip can be toggled since macOS rarely reports it. */
export function KeystrokeRecorder({
  value,
  onChange
}: {
  value: { key: string; modifiers: Modifier[] }
  onChange: (v: { key: string; modifiers: Modifier[] }) => void
}): React.JSX.Element {
  const [recording, setRecording] = React.useState(false)
  const [live, setLive] = React.useState<Modifier[]>([])
  const ref = React.useRef<HTMLButtonElement>(null)

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

  const shown = recording ? live : value.modifiers
  return (
    <div className="flex flex-col gap-2">
      <button
        ref={ref}
        type="button"
        onClick={() => setRecording((r) => !r)}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => recording && setLive(modsFromEvent(e))}
        onBlur={() => setRecording(false)}
        aria-label={recording ? 'Recording. Press a key combination, or Escape to cancel.' : 'Record a key combination'}
        className={cn(
          'flex h-12 w-full items-center justify-between rounded-[6px] px-3 text-left transition-shadow duration-150',
          recording ? 'bg-fill-hover shadow-[inset_0_0_0_1px_var(--ink-2)]' : 'bg-fill shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-fill-hover'
        )}
      >
        <span className="flex items-center gap-1">
          {shown.length > 0 && sortModifiers(shown).map((m) => <Kbd key={m} className="h-7 min-w-7 text-[13px] text-ink">{MODIFIER_GLYPH[m]}</Kbd>)}
          {recording ? (
            <span className="ml-1 text-[13px] text-ink-2">{shown.length ? 'now a key' : 'Press a key combination'}</span>
          ) : (
            <Kbd className="h-7 min-w-7 px-2 text-[13px] text-ink">{keyGlyph(value.key)}</Kbd>
          )}
        </span>
        <span className="text-[12px] text-ink-3">{recording ? 'Esc to cancel' : 'Click to record'}</span>
      </button>
      <div className="flex items-center gap-1.5">
        <span className="mr-1 text-[12px] text-ink-3">Modifiers</span>
        {MODIFIERS.map((m) => {
          const on = value.modifiers.includes(m)
          return (
            <button
              key={m}
              type="button"
              aria-pressed={on}
              aria-label={m}
              onClick={() => onChange({ ...value, modifiers: sortModifiers(on ? value.modifiers.filter((x) => x !== m) : [...value.modifiers, m]) })}
              className={cn(
                'inline-flex h-6 min-w-7 items-center justify-center rounded-[5px] px-1.5 font-mono text-[12px] transition-colors duration-150',
                on ? 'bg-ink text-bg' : 'text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:text-ink'
              )}
            >
              {MODIFIER_GLYPH[m]}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function ModifierChips({ value, onChange, label }: { value: Modifier[]; onChange: (m: Modifier[]) => void; label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
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
              on ? 'bg-ink text-bg' : 'text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:text-ink'
            )}
          >
            {MODIFIER_GLYPH[m]}
          </button>
        )
      })}
    </div>
  )
}
