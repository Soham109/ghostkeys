import * as React from 'react'
import { Command } from 'cmdk'
import { Search } from 'lucide-react'
import type { Preset } from '@shared/actions'
import { describeAction } from '@shared/actions'
import type { LibraryLayout } from '@shared/library'
import { appName } from '@/lib/apps'
import { useLibrary } from '@/lib/library'
import { cn } from '@/lib/utils'
import { Dialog } from '../ui/overlays'
import { Button } from '../ui/button'

const ALL = 'All'

/** A second line only when it tells you something the name does not. */
function secondary(p: Preset): string | null {
  const text = p.description ?? describeAction(p.action)
  const norm = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]/g, '')
  return norm(text) === norm(p.name) || norm(p.name).includes(norm(text)) ? null : text
}
const LAYOUTS = 'Ready-made layouts'

export function PresetLibrary({
  open,
  onOpenChange,
  onPick,
  onApplyLayout
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (p: Preset) => void
  onApplyLayout: (l: LibraryLayout) => void
}): React.JSX.Element {
  const lib = useLibrary()
  const [cat, setCat] = React.useState<string>(ALL)
  const [query, setQuery] = React.useState('')
  const cats = [ALL, ...lib.categories, ...(lib.layouts.length ? [LAYOUTS] : [])]
  const count = (c: string): number => (c === ALL ? lib.presets.length : c === LAYOUTS ? lib.layouts.length : lib.presets.filter((p) => p.category === c).length)
  const list = cat === ALL ? lib.presets : lib.presets.filter((p) => p.category === cat)

  React.useEffect(() => {
    if (open) setQuery('')
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Action library" className="flex h-[560px] w-[780px] max-w-[calc(100vw-48px)]">
      <nav className="flex w-[200px] shrink-0 flex-col gap-px overflow-y-auto p-2 shadow-[1px_0_0_var(--hairline)]" aria-label="Categories">
        <p className="label-mono px-2 pt-2 pb-2">Library</p>
        {cats.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            aria-current={cat === c ? 'true' : undefined}
            className={cn(
              'flex h-7 items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors duration-150',
              cat === c ? 'bg-fill-active text-ink' : 'text-ink-2 hover:bg-fill-hover hover:text-ink',
              c === LAYOUTS && 'mt-3'
            )}
          >
            <span className="truncate">{c}</span>
            <span className="num text-[11px] text-ink-3">{count(c)}</span>
          </button>
        ))}
        <p className="mt-auto px-2 pt-4 pb-1 text-[11px] leading-relaxed text-ink-3">
          {lib.source === 'file' ? 'From the shared preset library.' : 'Built-in presets.'} Pick one, choose where to tap, and add it.
        </p>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        {cat === LAYOUTS ? (
          <>
            <div className="flex h-12 shrink-0 items-center px-4 text-[13px] text-ink-2 hairline-b">
              A layout replaces your bindings with a tested set. You can discard before saving.
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto">
              {lib.layouts.map((l) => (
                <li key={l.id} className="flex items-center gap-4 px-4 py-3 shadow-[0_1px_0_var(--hairline)]">
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-ink">{l.name}</p>
                    {l.description && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-3">{l.description}</p>}
                  </div>
                  <span className="num shrink-0 text-[11px] text-ink-3">{l.bindings.length} bindings</span>
                  <Button variant="outline" size="md" onClick={() => onApplyLayout(l)}>
                    Apply
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Command loop className="flex min-h-0 flex-1 flex-col" key={cat}>
            <div className="flex h-12 shrink-0 items-center gap-2 px-4 hairline-b">
              <Search className="size-4 text-ink-3" />
              <Command.Input
                autoFocus
                value={query}
                onValueChange={setQuery}
                placeholder={`Search ${cat === ALL ? `${lib.presets.length} actions` : cat}`}
                className="h-full flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-3"
              />
            </div>
            <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-[13px] text-ink-3">No actions match. Try a broader word, or build your own with New binding.</Command.Empty>
              {list.map((p) => (
                <Command.Item
                  key={p.id}
                  value={`${p.name} ${p.category} ${p.keywords ?? ''} ${p.id}`}
                  onSelect={() => onPick(p)}
                  className="group flex min-h-10 cursor-default items-center gap-3 rounded-[6px] px-3 py-1.5 data-[selected=true]:bg-fill-active"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">{p.name}</p>
                    {secondary(p) && <p className="truncate text-[12px] text-ink-3">{secondary(p)}</p>}
                  </div>
                  {p.app && <span className="shrink-0 text-[11px] text-ink-3">{appName(p.app)}</span>}
                  {cat === ALL && <span className="w-28 shrink-0 truncate text-right text-[11px] text-ink-3">{p.category}</span>}
                  <span className="shrink-0 text-[12px] text-ink opacity-0 group-data-[selected=true]:opacity-100">Use</span>
                </Command.Item>
              ))}
            </Command.List>
          </Command>
        )}
      </div>
    </Dialog>
  )
}
