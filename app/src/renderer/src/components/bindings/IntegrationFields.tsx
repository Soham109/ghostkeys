import * as React from 'react'
import { Command } from 'cmdk'
import type { Action, IntegrationArgValue, IntegrationCommand } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { Input, Switch } from '../ui/controls'
import { Chevron } from '../ui/glyphs'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/overlays'

type IntegrationAction = Extract<Action, { kind: 'integration' }>

export function useCatalog(): ReturnType<typeof useStore.getState>['catalog'] {
  const catalog = useStore((s) => s.catalog)
  React.useEffect(() => {
    if (!catalog) client.send({ type: 'catalog_get' })
  }, [catalog])
  return catalog
}

export function findCommand(catalog: ReturnType<typeof useStore.getState>['catalog'], a: { app: string; command: string }): IntegrationCommand | undefined {
  return catalog?.commands.find((c) => c.app === a.app && c.command === a.command)
}

function defaultArgs(cmd: IntegrationCommand): Record<string, IntegrationArgValue> {
  const out: Record<string, IntegrationArgValue> = {}
  for (const a of cmd.args) {
    if (a.defaultValue == null) continue
    out[a.name] = a.kind === 'bool' ? a.defaultValue === 'true' : a.kind === 'number' ? Number(a.defaultValue) : a.defaultValue
  }
  return out
}

/** Searchable picker of the daemon's app commands, grouped by app, with an args form from the catalog. */
export function IntegrationFields({ action, onChange, compact }: { action: IntegrationAction; onChange: (a: Action) => void; compact?: boolean }): React.JSX.Element {
  const catalog = useCatalog()
  const [open, setOpen] = React.useState(false)
  const cmd = findCommand(catalog, action)
  const appName = (key: string): string => catalog?.apps.find((a) => a.key === key)?.name ?? key
  const unsupported = catalog?.unsupported[`${action.app}/${action.command}`]

  if (!catalog) return <p className="text-[12px] text-ink-3">Loading the list of app commands from the helper.</p>

  const flags: string[] = []
  if (cmd?.automationBundleId) flags.push(`Asks once to control ${appName(action.app)}`)
  if (cmd && (cmd.mechanism === 'keystrokes' || cmd.mechanism === 'appleScriptAndKeys')) flags.push('Needs Accessibility')
  if (cmd && !cmd.undoable) flags.push('Cannot be undone in the app')

  return (
    <div className="flex flex-col gap-3">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Choose an app command"
            className="flex min-h-9 w-full items-center gap-2 rounded-[6px] bg-fill px-3 py-1.5 text-left shadow-[inset_0_0_0_1px_var(--hairline)] hover:shadow-[inset_0_0_0_1px_var(--hairline-strong)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-ink">{cmd?.title ?? action.command}</span>
              <span className="block truncate text-[12px] text-ink-3">{appName(action.app)}</span>
            </span>
            <Chevron className="size-3 shrink-0 text-ink-3" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[380px]">
          <Command loop>
            <Command.Input placeholder={`Search ${catalog.commands.length} commands`} className="h-9 w-full bg-transparent px-3 text-[13px] text-ink outline-none placeholder:text-ink-3 hairline-b" />
            <Command.List className="fade-bottom max-h-80 overflow-y-auto px-1 pt-1 pb-2">
              <Command.Empty className="px-3 py-4 text-[12px] text-ink-3">No command matches.</Command.Empty>
              {catalog.apps.map((app) => {
                const cmds = catalog.commands.filter((c) => c.app === app.key)
                if (!cmds.length) return null
                return (
                  <Command.Group
                    key={app.key}
                    heading={app.name}
                    className="[&_[cmdk-group-heading]]:tag-mono [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-ink-3"
                  >
                    {cmds.map((c) => (
                      <Command.Item
                        key={`${c.app}/${c.command}`}
                        value={`${app.name} ${c.title} ${c.command}`}
                        onSelect={() => {
                          onChange({ kind: 'integration', app: c.app, command: c.command, args: defaultArgs(c) })
                          setOpen(false)
                        }}
                        className="flex cursor-default flex-col rounded-[5px] px-2 py-1.5 data-[selected=true]:bg-fill-active"
                      >
                        <span className="text-[13px] text-ink">{c.title}</span>
                        <span className="line-clamp-1 text-[12px] text-ink-3">{c.summary}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                )
              })}
            </Command.List>
          </Command>
        </PopoverContent>
      </Popover>

      {!compact && cmd && <p className="text-[12px] leading-relaxed text-ink-2">{cmd.summary}</p>}
      {unsupported && <p className="text-[12px] leading-relaxed text-ink-2">This one can&rsquo;t work: {unsupported}.</p>}

      {cmd && cmd.args.length > 0 && (
        <div className="grid grid-cols-[96px_1fr] items-center gap-x-4 gap-y-2">
          {cmd.args.map((arg) => {
            const v = action.args[arg.name]
            const set = (val: IntegrationArgValue | undefined): void => {
              const args = { ...action.args }
              if (val === undefined || val === '') delete args[arg.name]
              else args[arg.name] = val
              onChange({ ...action, args })
            }
            return (
              <React.Fragment key={arg.name}>
                <label className="truncate text-[12px] text-ink-2" title={arg.help}>
                  {arg.name}
                  {arg.required && <span className="text-ink-3"> *</span>}
                </label>
                {arg.kind === 'bool' ? (
                  <div className="flex items-center gap-3">
                    <Switch checked={v === true || v === 'true'} onCheckedChange={(c) => set(c)} aria-label={arg.name} />
                    <span className="truncate text-[12px] text-ink-3">{arg.help}</span>
                  </div>
                ) : (
                  <Input
                    type={arg.kind === 'number' ? 'number' : 'text'}
                    value={v === undefined ? '' : String(v)}
                    placeholder={arg.defaultValue ?? arg.help}
                    title={arg.help}
                    onChange={(e) => set(arg.kind === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
                  />
                )}
              </React.Fragment>
            )
          })}
        </div>
      )}

      {!compact && (flags.length > 0 || cmd?.notes) && (
        <div className="flex flex-col gap-1">
          {flags.length > 0 && <p className="tag-mono text-ink-3">{flags.join(' · ')}</p>}
          {cmd?.notes && <p className="text-[12px] leading-relaxed text-ink-3">{cmd.notes}</p>}
        </div>
      )}
    </div>
  )
}
