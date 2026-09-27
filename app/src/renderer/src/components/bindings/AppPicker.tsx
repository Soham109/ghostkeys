import * as React from 'react'
import { Command } from 'cmdk'
import { COMMON_APPS, appName } from '@/lib/apps'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/overlays'
import { Chevron, Tick } from '../ui/glyphs'
import { AppIcon } from '../AppIcon'

/** "Everywhere" or a specific app, picked from common apps or typed as a bundle id. */
export function AppPicker({ value, onChange }: { value: string; onChange: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const looksLikeBundle = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(query.trim())
  const pick = (id: string): void => {
    onChange(id)
    setOpen(false)
    setQuery('')
  }
  const item = 'flex h-8 cursor-default items-center justify-between gap-2 rounded-[5px] px-2 text-[13px] text-ink-2 data-[selected=true]:bg-fill-active data-[selected=true]:text-ink'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="App layer"
          title={value === '*' ? 'Every app' : value}
          className="flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-fill px-2.5 text-left text-[13px] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-fill-hover"
        >
          <AppIcon bundleId={value} />
          <span className="truncate">{appName(value)}</span>
          <Chevron className="ml-auto size-3 shrink-0 text-ink-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)]">
        <Command loop>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Search apps"
            className="h-9 w-full bg-transparent px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 hairline-b"
          />
          <Command.List className="fade-bottom max-h-64 overflow-y-auto px-1 pt-1 pb-2">
            <Command.Empty className="px-2 py-3 text-[12px] text-ink-3">No app by that name. You can also type an app ID, such as com.example.App.</Command.Empty>
            <Command.Item value="Everywhere *" onSelect={() => pick('*')} className={item}>
              Everywhere
              {value === '*' && <Tick />}
            </Command.Item>
            {looksLikeBundle && !COMMON_APPS.some((a) => a.id === query.trim()) && (
              <Command.Item value={`use ${query}`} onSelect={() => pick(query.trim())} className={item}>
                <span>
                  Use <span className="font-mono text-[12px]">{query.trim()}</span>
                </span>
              </Command.Item>
            )}
            {COMMON_APPS.map((a) => (
              <Command.Item key={a.id} value={`${a.name} ${a.id}`} onSelect={() => pick(a.id)} className={cn(item)} title={a.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <AppIcon bundleId={a.id} />
                  <span className="truncate">{a.name}</span>
                </span>
                {value === a.id && <Tick />}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
