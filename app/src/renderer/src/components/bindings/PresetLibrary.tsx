import * as React from 'react'
import { Command } from 'cmdk'
import type { Preset } from '@shared/actions'
import { describeAction } from '@shared/actions'
import type { LibraryLayout } from '@shared/library'
import { appName } from '@/lib/apps'
import { useLibrary } from '@/lib/library'
import { cn } from '@/lib/utils'
import { Sheet } from '../ui/overlays'
import { Button } from '../ui/button'
import { ProTag } from '../ui/controls'
import { PRO_KINDS } from './ActionForm'
import { GestureDemo } from '../gestures/GestureDemo'
import { demoFor } from '../gestures/GesturePicker'
import { useStore } from '@/lib/store'
import { GESTURE_LABEL, type Binding } from '@shared/protocol'

const ALL = 'All'
const LAYOUTS = 'Ready-made layouts'

/** A second line only when it tells you something the name does not. */
function secondary(p: Preset): string | null {
  const text = p.description ?? describeAction(p.action)
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(text) === norm(p.name) || norm(p.name).includes(norm(text)) ? null : text
}

const itemValue = (p: Preset): string => `${p.name} ${p.category} ${p.keywords ?? ''} ${p.id}`.trim()

function PresetItem({ p, onPick }: { p: Preset; onPick: (p: Preset) => void }): React.JSX.Element {
  const sub = secondary(p)
  return (
    <Command.Item
      value={itemValue(p)}
      onSelect={() => onPick(p)}
      className="group flex min-h-10 cursor-default items-center gap-3 rounded-[6px] px-3 py-1.5 data-[selected=true]:bg-fill-active"
    >
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-[13px] text-ink">
          <span className="truncate">{p.name}</span>
          {PRO_KINDS.includes(p.action.kind) && <ProTag />}
        </p>
        {sub && <p className="line-clamp-2 text-[12px] leading-snug text-ink-3">{sub}</p>}
      </div>
      {p.app && <span className="shrink-0 text-[12px] text-ink-3">{appName(p.app)}</span>}
      <span className="num shrink-0 text-[12px] text-ink opacity-0 group-data-[selected=true]:opacity-100">Use &#x21a9;</span>
    </Command.Item>
  )
}

/** What choosing this preset would do: its gesture, played on this Mac. */
function Preview({
  preset,
  suggest,
  zones
}: {
  preset?: Preset
  suggest?: (p: Preset) => Pick<Binding, 'gesture' | 'zone' | 'zones' | 'modifiers'>
  zones: { id: string; name: string }[]
}): React.JSX.Element {
  if (!preset || !suggest) return <aside className="w-[232px] shrink-0 px-4 shadow-[-1px_0_0_var(--hairline)]" />
  const t = suggest(preset)
  const where = t.zone ? zones.find((z) => z.id === t.zone)?.name : null
  return (
    <aside className="flex w-[232px] shrink-0 flex-col gap-3 px-4 pt-1 shadow-[-1px_0_0_var(--hairline)]" aria-label="Preview">
      <GestureDemo {...demoFor(t)} className="aspect-[1.5676] w-full rounded-[6px] bg-sunken shadow-[inset_0_0_0_1px_var(--hairline)]" />
      <p className="text-[13px] leading-snug text-ink">{preset.name}</p>
      <p className="text-[12px] leading-relaxed text-ink-3">
        Starts as a {GESTURE_LABEL[t.gesture].toLowerCase()}
        {where ? ` on the ${where.toLowerCase()}` : ''}. You can change the gesture before adding it.
      </p>
    </aside>
  )
}

export function PresetLibrary({
  open,
  onOpenChange,
  onPick,
  onApplyLayout,
  initialTab,
  suggest
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (p: Preset) => void
  onApplyLayout: (l: LibraryLayout) => void
  initialTab?: string
  /** The trigger a preset would get if chosen now, for the preview. */
  suggest?: (p: Preset) => Pick<Binding, 'gesture' | 'zone' | 'zones' | 'modifiers'>
}): React.JSX.Element {
  const [active, setActive] = React.useState('')
  const zones = useStore((s) => s.draft?.zones ?? [])
  const lib = useLibrary()
  const [cat, setCat] = React.useState<string>(ALL)
  const [query, setQuery] = React.useState('')
  const cats = [ALL, ...lib.categories, ...(lib.layouts.length ? [LAYOUTS] : [])]
  const count = (c: string): number => (c === ALL ? lib.presets.length : c === LAYOUTS ? lib.layouts.length : lib.presets.filter((p) => p.category === c).length)

  React.useEffect(() => {
    if (open) {
      setQuery('')
      setCat(initialTab ?? ALL)
    }
  }, [open, initialTab])

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Library" width={960} bodyClassName="flex overflow-hidden" fade={false}>
      <nav className="flex w-[200px] shrink-0 flex-col shadow-[1px_0_0_var(--hairline)]" aria-label="Categories">
        <div className="fade-bottom flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2 pt-1 pb-6">
          {cats.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              aria-current={cat === c ? 'true' : undefined}
              className={cn(
                'flex h-7 shrink-0 items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors duration-150',
                cat === c ? 'bg-fill-active text-ink' : 'text-ink-2 hover:bg-fill-hover hover:text-ink',
                c === LAYOUTS && 'mt-3'
              )}
            >
              <span className="truncate">{c}</span>
              <span className="num text-[11px] text-ink-3">{count(c)}</span>
            </button>
          ))}
        </div>
        <p className="shrink-0 px-4 pt-3 pb-4 text-[11px] leading-relaxed text-ink-3 shadow-[0_-1px_0_var(--hairline)]">
          {lib.source === 'file' ? 'The shared preset library.' : 'Built-in presets.'} Pick one, choose where to tap, add it.
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {cat === LAYOUTS ? (
          <>
            <p className="px-5 pt-1 pb-3 text-[13px] text-ink-2">A layout replaces your bindings with a tested set. Nothing is saved until you press Save.</p>
            <ul className="fade-bottom min-h-0 flex-1 overflow-y-auto pb-6 shadow-[0_-1px_0_var(--hairline)]">
              {lib.layouts.map((l) => (
                <li key={l.id} className="flex items-center gap-4 px-5 py-3 shadow-[0_1px_0_var(--hairline)]">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] text-ink">
                      {l.name}
                      <ProTag feature="Layouts" />
                    </p>
                    {l.description && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-ink-3">{l.description}</p>}
                  </div>
                  <span className="num shrink-0 text-[11px] text-ink-3">{String(l.bindings.length).padStart(2, '0')} bindings</span>
                  <Button variant="outline" onClick={() => onApplyLayout(l)}>
                    Apply
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="flex min-h-0 flex-1">
          <Command loop className="flex min-h-0 flex-1 flex-col" key={cat} value={active} onValueChange={setActive}>
            <div className="px-4 pb-3">
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={`Search ${cat === ALL ? `${lib.presets.length} actions` : cat}`}
                className="h-8 w-full rounded-[6px] bg-fill px-3 text-[13px] text-ink shadow-[inset_0_0_0_1px_var(--hairline)] outline-none placeholder:text-ink-3 focus:shadow-[inset_0_0_0_1px_var(--ink-3)]"
              />
            </div>
            <Command.List className="fade-bottom min-h-0 flex-1 overflow-y-auto px-2 pb-8">
              <Command.Empty className="px-3 py-8 text-[13px] text-ink-3">No actions match. Try a broader word, or build your own with New binding.</Command.Empty>
              {cat === ALL
                ? lib.categories.map((c) => (
                    <Command.Group
                      key={c}
                      heading={c}
                      className="[&_[cmdk-group-heading]]:tag-mono [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-4 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-ink-3"
                    >
                      {lib.presets
                        .filter((p) => p.category === c)
                        .map((p) => (
                          <PresetItem key={p.id} p={p} onPick={onPick} />
                        ))}
                    </Command.Group>
                  ))
                : lib.presets.filter((p) => p.category === cat).map((p) => <PresetItem key={p.id} p={p} onPick={onPick} />)}
            </Command.List>
          </Command>
          <Preview preset={lib.presets.find((p) => itemValue(p) === active)} suggest={suggest} zones={zones} />
          </div>
        )}
      </div>
    </Sheet>
  )
}
