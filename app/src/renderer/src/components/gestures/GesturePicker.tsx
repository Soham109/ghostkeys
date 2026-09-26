import * as React from 'react'
import { CAMERA_GESTURES, GESTURES, GESTURE_HINT, GESTURE_LABEL, SOUND_GESTURES, type Binding, type GestureKind } from '@shared/protocol'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/overlays'
import { ProTag } from '../ui/controls'
import { Chevron, Tick } from '../ui/glyphs'
import { GestureDemo, type DemoId } from './GestureDemo'

/** The demo that shows a binding's gesture, with its zone(s) and held keys. */
export function demoFor(b: Pick<Binding, 'gesture' | 'zone' | 'zones' | 'modifiers'>): {
  gesture: DemoId
  zone?: string | null
  pair?: [string, string] | null
  modifiers?: Binding['modifiers']
} {
  if (b.modifiers.length && (b.gesture === 'tap' || b.gesture === 'double' || b.gesture === 'triple'))
    return { gesture: 'modifier_tap', zone: b.zone, modifiers: b.modifiers }
  if (b.gesture === 'sequence' && b.zones?.length === 2 && b.zones[0] && b.zones[1]) return { gesture: 'sequence', pair: [b.zones[0], b.zones[1]] }
  return { gesture: b.gesture as DemoId, zone: b.zone && b.zone !== 'air' ? b.zone : null }
}

/**
 * Gesture picker with a live preview: hovering or arrowing through the list plays that gesture on the right.
 * Sound and camera gestures appear only when this Mac has the hardware.
 */
export function GesturePicker({
  value,
  onChange,
  sound,
  camera,
  pro,
  zone
}: {
  value: GestureKind
  onChange: (g: GestureKind) => void
  sound: boolean
  camera: boolean
  pro: GestureKind[]
  zone: string | null
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [hover, setHover] = React.useState<GestureKind>(value)
  React.useEffect(() => {
    if (open) setHover(value)
  }, [open, value])
  const touch = GESTURES.filter((g) => !SOUND_GESTURES.includes(g) && !CAMERA_GESTURES.includes(g))
  const groups: { label: string; items: GestureKind[] }[] = [
    { label: 'Taps and motion', items: touch },
    ...(sound ? [{ label: 'Sound mode', items: SOUND_GESTURES }] : []),
    ...(camera ? [{ label: 'Camera', items: CAMERA_GESTURES }] : [])
  ]
  const flat = groups.flatMap((g) => g.items)
  const onKey = (e: React.KeyboardEvent): void => {
    const i = flat.indexOf(hover)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = flat[(i + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length]!
      setHover(n)
      document.getElementById(`gp-${n}`)?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onChange(hover)
      setOpen(false)
    }
  }
  const demo = demoFor({ gesture: hover, zone, zones: null, modifiers: [] })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Gesture"
          className="flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-fill px-2.5 text-left text-[13px] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-fill-hover"
        >
          <span className="flex items-center gap-2">
            {GESTURE_LABEL[value]}
            {pro.includes(value) && <ProTag />}
          </span>
          <Chevron className="size-3 shrink-0 text-ink-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="flex w-[480px]" align="end" collisionPadding={12} onKeyDown={onKey}>
        <div role="listbox" aria-label="Gestures" aria-activedescendant={`gp-${hover}`} tabIndex={0} className="fade-bottom max-h-[340px] w-[220px] shrink-0 overflow-y-auto p-1 pb-4 outline-none">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="tag-mono px-2 pt-2 pb-1 text-ink-3">{g.label}</p>
              {g.items.map((k) => (
                <div
                  key={k}
                  id={`gp-${k}`}
                  role="option"
                  aria-selected={k === value}
                  onPointerEnter={() => setHover(k)}
                  onClick={() => {
                    onChange(k)
                    setOpen(false)
                  }}
                  className={cn('flex h-7 cursor-default items-center justify-between gap-2 rounded-[5px] px-2 text-[13px]', hover === k ? 'bg-fill-active text-ink' : 'text-ink-2')}
                >
                  <span className="flex items-center gap-2 truncate">
                    {GESTURE_LABEL[k]}
                    {pro.includes(k) && <ProTag />}
                  </span>
                  {k === value && <Tick />}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-3 shadow-[-1px_0_0_var(--hairline)]">
          <GestureDemo key={hover} {...demo} className="aspect-[1.5676] w-full rounded-[6px] bg-sunken shadow-[inset_0_0_0_1px_var(--hairline)]" />
          <p className="text-[13px] text-ink">{GESTURE_LABEL[hover]}</p>
          <p className="text-[12px] leading-relaxed text-ink-3">{GESTURE_HINT[hover]}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
