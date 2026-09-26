import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { BookOpen, Copy, Info, MoreHorizontal, Play, Plus, Search, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { GESTURE_LABEL, MODIFIER_GLYPH, ZONELESS_GESTURES, type Binding, type Config, type GestureKind } from '@shared/protocol'
import { describeAction, isDestructive, sortModifiers, type Preset } from '@shared/actions'
import type { LibraryLayout } from '@shared/library'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { appName } from '@/lib/apps'
import { conflictsFor, triggerKey, whereText, zoneById } from '@/lib/bindings'
import { cn, uid } from '@/lib/utils'
import { PageHeader, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Input, Kbd, Switch, Tip, ZoneDot } from '@/components/ui/controls'
import { Confirm, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { BindingEditor } from '@/components/bindings/BindingEditor'
import { ApprovalBadge } from '@/components/bindings/ApprovalBadge'
import { ensureApproved } from '@/lib/approval'
import { PresetLibrary } from '@/components/bindings/PresetLibrary'

function freshBinding(config: Config, seed?: Partial<Binding>, zoneId?: string): Binding {
  const base: Binding = {
    id: uid('b'),
    enabled: true,
    gesture: 'double',
    zone: zoneId ?? config.zones[0]?.id ?? null,
    zones: null,
    modifiers: [],
    app: '*',
    action: { kind: 'media', command: 'playpause' },
    label: 'Play or pause',
    ...seed
  }
  if (zoneId) return { ...base, zone: zoneId }
  // Pick a trigger nobody uses yet, so two clicks give a working binding.
  const used = new Set(config.bindings.map(triggerKey))
  const gestures: GestureKind[] = ['double', 'tap', 'triple', 'rhythm']
  for (const g of gestures) {
    for (const z of config.zones) {
      const candidate = { ...base, gesture: g, zone: z.id, zones: null }
      if (!used.has(triggerKey(candidate))) return candidate
    }
  }
  return base
}

function TriggerCell({ b, config }: { b: Binding; config: Config }): React.JSX.Element {
  const zoneless = ZONELESS_GESTURES.includes(b.gesture)
  const dots = zoneless ? [] : b.gesture === 'sequence' ? (b.zones ?? []).map((id) => zoneById(config.zones, id)) : [zoneById(config.zones, b.zone)]
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex w-4 shrink-0 items-center -space-x-0.5">
        {dots.map((z, i) => (
          <ZoneDot key={i} color={z?.color ?? 'var(--ink-3)'} className="shadow-[0_0_0_1.5px_var(--bg)]" />
        ))}
        {zoneless && <span className="size-2 rounded-full shadow-[inset_0_0_0_1px_var(--ink-3)]" />}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[13px] text-ink">{GESTURE_LABEL[b.gesture]}</p>
        <p className="truncate text-[12px] text-ink-3">{whereText(b, config.zones)}</p>
      </div>
      {b.modifiers.length > 0 && (
        <span className="ml-1 flex shrink-0 gap-0.5">
          {sortModifiers(b.modifiers).map((m) => (
            <Kbd key={m}>{MODIFIER_GLYPH[m]}</Kbd>
          ))}
        </span>
      )}
    </div>
  )
}

const GRID = 'grid grid-cols-[52px_minmax(0,1.25fr)_minmax(0,1.35fr)_76px] items-center gap-4'

export function BindingsScreen(): React.JSX.Element {
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const editingBinding = useStore((s) => s.editingBinding)
  const editorSeed = useStore((s) => s.editorSeed)
  const presetsOpen = useStore((s) => s.presetsOpen)
  const [editor, setEditor] = React.useState<{ binding: Binding; isNew: boolean } | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [confirmDelete, setConfirmDelete] = React.useState<Binding | null>(null)
  const [pendingLayout, setPendingLayout] = React.useState<LibraryLayout | null>(null)

  const openEditor = React.useCallback((binding: Binding, isNew: boolean) => {
    setEditor({ binding, isNew })
    setEditorOpen(true)
  }, [])

  // Requests from elsewhere (command palette, Live screen).
  React.useEffect(() => {
    if (!editingBinding || !draft) return
    useStore.setState({ editingBinding: null })
    if (editingBinding.startsWith('new')) {
      const zoneId = editingBinding.split(':')[1]
      openEditor(freshBinding(draft, undefined, zoneId), true)
    } else {
      const b = draft.bindings.find((x) => x.id === editingBinding)
      if (b) openEditor(b, false)
    }
  }, [editingBinding, draft, openEditor])

  React.useEffect(() => {
    if (!editorSeed) return
    useStore.setState({ editorSeed: null })
    openEditor(editorSeed, true)
  }, [editorSeed, openEditor])

  if (!draft) return <PageHeader title="Gestures and actions" />

  const conflicts = conflictsFor(draft)
  const q = query.trim().toLowerCase()
  const visible = draft.bindings.filter(
    (b) =>
      !q ||
      [b.label, describeAction(b.action), GESTURE_LABEL[b.gesture], whereText(b, draft.zones), appName(b.app)].some((t) => t.toLowerCase().includes(q))
  )
  const layers = [...new Set(visible.map((b) => b.app))].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : appName(a).localeCompare(appName(b))))

  const save = (b: Binding): void => {
    setDraft((c) => ({ ...c, bindings: c.bindings.some((x) => x.id === b.id) ? c.bindings.map((x) => (x.id === b.id ? b : x)) : [...c.bindings, b] }))
    setEditorOpen(false)
  }
  const remove = (id: string): void => {
    setDraft((c) => ({ ...c, bindings: c.bindings.filter((x) => x.id !== id) }))
    setEditorOpen(false)
  }
  const test = async (b: Binding): Promise<void> => {
    if (!(await ensureApproved([b.action], `Testing "${b.label}".`))) return
    if (!client.send({ type: 'test_action', action: b.action })) toast('Could not reach the service')
  }
  const pickPreset = (p: Preset): void => {
    useStore.setState({ presetsOpen: false })
    openEditor(freshBinding(draft, { action: structuredClone(p.action), label: p.name, app: p.app ?? '*' }), true)
  }

  return (
    <>
      <PageHeader
        title="Gestures and actions"
        subtitle={`${draft.bindings.filter((b) => b.enabled).length} of ${draft.bindings.length} on`}
        actions={
          <>
            <div className="relative mr-1 w-[200px]">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-3" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter" className="pl-8" aria-label="Filter bindings" />
            </div>
            <Button variant="outline" onClick={() => useStore.setState({ presetsOpen: true })}>
              <BookOpen />
              Library
            </Button>
            <Button variant="primary" onClick={() => openEditor(freshBinding(draft), true)}>
              <Plus />
              New binding
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto pb-24">
        <div className={cn(GRID, 'sticky top-0 z-10 h-8 bg-bg px-6 shadow-[0_1px_0_var(--hairline)]')}>
          <span className="label-mono">On</span>
          <span className="label-mono">When</span>
          <span className="label-mono">Do</span>
          <span />
        </div>
        {visible.length === 0 ? (
          <div className="px-2">
            {draft.bindings.length === 0 ? (
              <Empty
                title="No bindings yet."
                action={
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => useStore.setState({ presetsOpen: true })}>
                      Browse the library
                    </Button>
                    <Button variant="ghost" onClick={() => openEditor(freshBinding(draft), true)}>
                      Start from scratch
                    </Button>
                  </div>
                }
              >
                A binding connects a gesture, like a double tap on the right palm rest, to something your Mac does.
              </Empty>
            ) : (
              <Empty title={`Nothing matches "${query}".`} />
            )}
          </div>
        ) : (
          layers.map((layer) => (
            <section key={layer} aria-label={appName(layer)}>
              <div className="flex h-9 items-end px-6 pb-1.5">
                <h2 className="label-mono">{appName(layer)}</h2>
              </div>
              <ul>
                <AnimatePresence initial={false}>
                  {visible
                    .filter((b) => b.app === layer)
                    .map((b) => {
                      const cs = conflicts[b.id] ?? []
                      return (
                        <motion.li
                          key={b.id}
                          layout="position"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0, transition: { duration: 0.12 } }}
                          transition={{ duration: 0.2 }}
                          className={cn(GRID, 'group min-h-[52px] cursor-pointer px-6 py-2 shadow-[0_1px_0_var(--hairline)] hover:bg-fill')}
                          onClick={() => openEditor(b, false)}
                        >
                          <span onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={b.enabled}
                              aria-label={`${b.enabled ? 'Disable' : 'Enable'} ${b.label}`}
                              onCheckedChange={(enabled) => setDraft((c) => ({ ...c, bindings: c.bindings.map((x) => (x.id === b.id ? { ...x, enabled } : x)) }))}
                            />
                          </span>
                          <div className={cn('min-w-0', !b.enabled && 'opacity-45')}>
                            <TriggerCell b={b} config={draft} />
                          </div>
                          <div className={cn('flex min-w-0 flex-col', !b.enabled && 'opacity-45')}>
                            <span className="flex items-center gap-1.5 truncate text-[13px] text-ink">
                              {b.label || describeAction(b.action)}
                              <ApprovalBadge action={b.action} compact />
                              {isDestructive(b.action) && (
                                <Tip content="Quits the frontmost app">
                                  <TriangleAlert className="size-3 shrink-0 text-danger" />
                                </Tip>
                              )}
                            </span>
                            {cs.length > 0 ? (
                              <span className={cn('flex items-center gap-1 truncate text-[12px]', cs.some((c) => c.kind !== 'delay') ? 'text-danger' : 'text-ink-3')}>
                                {cs.some((c) => c.kind !== 'delay') ? <TriangleAlert className="size-3 shrink-0" /> : <Info className="size-3 shrink-0" />}
                                <span className="truncate">{cs[0]!.message}</span>
                              </span>
                            ) : (
                              ['keystroke', 'shell', 'applescript', 'shortcut', 'open', 'text', 'clipboard', 'macro'].includes(b.action.kind) &&
                              b.label !== describeAction(b.action) && <span className="truncate text-[12px] text-ink-3">{describeAction(b.action)}</span>
                            )}
                          </div>
                          <div className="flex justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                            <Tip content="Test this action now">
                              <Button variant="ghost" size="icon" aria-label={`Test ${b.label}`} onClick={() => void test(b)}>
                                <Play />
                              </Button>
                            </Tip>
                            <Menu>
                              <MenuTrigger asChild>
                                <Button variant="ghost" size="icon" aria-label={`More for ${b.label}`}>
                                  <MoreHorizontal />
                                </Button>
                              </MenuTrigger>
                              <MenuContent align="end">
                                <MenuItem onSelect={() => openEditor(b, false)}>Edit</MenuItem>
                                <MenuItem onSelect={() => setDraft((c) => ({ ...c, bindings: [...c.bindings, { ...structuredClone(b), id: uid('b'), enabled: false }] }))}>
                                  <Copy />
                                  Duplicate
                                </MenuItem>
                                <MenuSeparator />
                                <MenuItem destructive onSelect={() => setConfirmDelete(b)}>
                                  <Trash2 />
                                  Delete
                                </MenuItem>
                              </MenuContent>
                            </Menu>
                          </div>
                        </motion.li>
                      )
                    })}
                </AnimatePresence>
              </ul>
            </section>
          ))
        )}
      </div>

      <BindingEditor
        open={editorOpen}
        initial={editor?.binding ?? null}
        isNew={editor?.isNew ?? false}
        config={draft}
        onClose={() => setEditorOpen(false)}
        onSave={save}
        onDelete={(id) => {
          const b = draft.bindings.find((x) => x.id === id)
          if (b) setConfirmDelete(b)
        }}
      />
      <PresetLibrary
        open={presetsOpen}
        onOpenChange={(o) => useStore.setState({ presetsOpen: o })}
        onPick={pickPreset}
        onApplyLayout={(l) => setPendingLayout(l)}
      />
      <Confirm
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete "${confirmDelete?.label ?? 'binding'}"?`}
        body="The gesture stops doing anything. You can discard before saving."
        confirmLabel="Delete binding"
        onConfirm={() => confirmDelete && remove(confirmDelete.id)}
      />
      <Confirm
        open={!!pendingLayout}
        onOpenChange={(o) => !o && setPendingLayout(null)}
        title={`Apply ${pendingLayout?.name ?? 'layout'}?`}
        body={`Its ${pendingLayout?.bindings.length ?? 0} bindings replace your current ones${pendingLayout?.zones ? ', and its zones replace yours' : ''}. Nothing is saved until you press Save.`}
        confirmLabel="Apply layout"
        onConfirm={() => {
          const l = pendingLayout
          if (!l) return
          setDraft((c) => ({ ...c, zones: l.zones ?? c.zones, bindings: structuredClone(l.bindings) }))
          useStore.setState({ presetsOpen: false })
          toast(`Applied ${l.name}`, { description: 'Review the bindings, then save.' })
        }}
      />
    </>
  )
}
