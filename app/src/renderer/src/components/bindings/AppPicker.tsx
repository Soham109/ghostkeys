import * as React from 'react'
import { Command } from 'cmdk'
import { Check, ChevronDown } from 'lucide-react'
import { COMMON_APPS, appName } from '@/lib/apps'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/overlays'

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
          className="flex h-7 w-full items-center justify-between gap-2 rounded-[6px] bg-fill px-2.5 text-left text-[13px] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-fill-hover"
        >
          <span className="truncate">{appName(value)}</span>
          {value !== '*' && <span className="ml-auto truncate font-mono text-[11px] text-ink-3">{value}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-ink-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)]">
        <Command loop>
          <Command.Input
            value={query}
            onValueChange={setQuery}
            placeholder="Search apps or type a bundle id"
            className="h-9 w-full bg-transparent px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 hairline-b"
          />
          <Command.List className="max-h-64 overflow-y-auto p-1">
            <Command.Empty className="px-2 py-3 text-[12px] text-ink-3">No match. Type a full bundle id like com.example.App.</Command.Empty>
            <Command.Item value="Everywhere *" onSelect={() => pick('*')} className={item}>
              Everywhere
              {value === '*' && <Check className="size-3.5" />}
            </Command.Item>
            {looksLikeBundle && !COMMON_APPS.some((a) => a.id === query.trim()) && (
              <Command.Item value={`use ${query}`} onSelect={() => pick(query.trim())} className={item}>
                <span>
                  Use <span className="font-mono text-[12px]">{query.trim()}</span>
                </span>
              </Command.Item>
            )}
            {COMMON_APPS.map((a) => (
              <Command.Item key={a.id} value={`${a.name} ${a.id}`} onSelect={() => pick(a.id)} className={cn(item)}>
                <span className="truncate">{a.name}</span>
                {value === a.id ? <Check className="size-3.5" /> : <span className="truncate font-mono text-[11px] text-ink-3">{a.id}</span>}
              </Command.Item>
            ))}
          </Command.List>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
