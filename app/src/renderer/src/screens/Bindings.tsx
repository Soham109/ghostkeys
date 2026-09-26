import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { GESTURE_LABEL, MODIFIER_GLYPH, ZONELESS_GESTURES, CAMERA_GESTURES, type Binding, type Config, type GestureKind } from '@shared/protocol'
import { comboText, describeAction, sortModifiers, type Preset } from '@shared/actions'
import type { LibraryLayout } from '@shared/library'
import { useStore, zoneNumber } from '@/lib/store'
import { client } from '@/lib/client'
import { appName } from '@/lib/apps'
import { conflictsFor, triggerKey, whereText } from '@/lib/bindings'
import { ensureActionApproved } from '@/lib/approval'
import { cn, uid } from '@/lib/utils'
import { PageHeader, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Input, ProTag, Switch } from '@/components/ui/controls'
import { Confirm, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlays'
import { BindingEditor, PRO_GESTURES } from '@/components/bindings/BindingEditor'
import { PresetLibrary } from '@/components/bindings/PresetLibrary'
import { ApprovalTag } from '@/components/bindings/ApprovalBadge'
import { PRO_KINDS } from '@/components/bindings/ActionForm'

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

function indexText(b: Binding, config: Config): string {
  if (CAMERA_GESTURES.includes(b.gesture)) return 'AIR'
  if (ZONELESS_GESTURES.includes(b.gesture)) return '—'
  if (b.gesture === 'sequence') return (b.zones ?? []).map((z) => String(zoneNumber(config, z) ?? 0).padStart(2, '0')).join('→')
  const n = zoneNumber(config, b.zone)
  return n ? String(n).padStart(2, '0') : '--'
}

const GRID = 'grid grid-cols-[48px_minmax(0,1fr)_minmax(0,1fr)_120px_48px] items-center gap-4'

export function BindingsScreen(): React.JSX.Element {
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const editingBinding = useStore((s) => s.editingBinding)
  const editorSeed = useStore((s) => s.editorSeed)
  const presetsOpen = useStore((s) => s.presetsOpen)
  const [editor, setEditor] = React.useState<{ binding: Binding; isNew: boolean } | null>(null)
  const [editorOpen, setEditorOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [filterFocused, setFilterFocused] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState<Binding | null>(null)
  const [pendingLayout, setPendingLayout] = React.useState<LibraryLayout | null>(null)
  const [libraryTab, setLibraryTab] = React.useState<string | undefined>(undefined)
  const filterRef = React.useRef<HTMLInputElement>(null)

  const openEditor = React.useCallback((binding: Binding, isNew: boolean) => {
    setEditor({ binding, isNew })
    setEditorOpen(true)
  }, [])

  React.useEffect(() => {
    const f = (): void => filterRef.current?.focus()
    window.addEventListener('gk:focus-filter', f)
    return () => window.removeEventListener('gk:focus-filter', f)
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
    (b) => !q || [b.label, describeAction(b.action), GESTURE_LABEL[b.gesture], whereText(b, draft.zones), appName(b.app)].some((t) => t.toLowerCase().includes(q))
  )
  const layers = [...new Set(visible.map((b) => b.app))].sort((a, b) => (a === '*' ? -1 : b === '*' ? 1 : appName(a).localeCompare(appName(b))))
  const on = draft.bindings.filter((b) => b.enabled).length

  const save = (b: Binding): void => {
    setDraft((c) => ({ ...c, bindings: c.bindings.some((x) => x.id === b.id) ? c.bindings.map((x) => (x.id === b.id ? b : x)) : [...c.bindings, b] }))
    setEditorOpen(false)
  }
  const remove = (id: string): void => {
    setDraft((c) => ({ ...c, bindings: c.bindings.filter((x) => x.id !== id) }))
    setEditorOpen(false)
  }
  const test = async (b: Binding): Promise<void> => {
    const approved = await ensureActionApproved(b.action, `Testing "${b.label}".`)
    if (!approved) return
    if (approved !== b.action) setDraft((c) => ({ ...c, bindings: c.bindings.map((x) => (x.id === b.id ? { ...x, action: approved } : x)) }))
    if (!client.send({ type: 'test_action', action: approved })) toast('Could not reach the helper')
  }
  const pickPreset = (p: Preset): void => {
    useStore.setState({ presetsOpen: false })
    openEditor(freshBinding(draft, { action: structuredClone(p.action), label: p.name, app: p.app ?? '*' }), true)
  }

  return (
    <>
      <PageHeader
        title="Gestures and actions"
        subtitle={`${String(on).padStart(2, '0')} / ${String(draft.bindings.length).padStart(2, '0')} on`}
        actions={
          <>
            <Input
              ref={filterRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFilterFocused(true)}
              onBlur={() => setFilterFocused(false)}
              placeholder="Filter"
              aria-label="Filter bindings"
              aria-keyshortcuts="Meta+F"
              className="mr-2 transition-[width] duration-200 ease-[var(--ease-snap)]"
              style={{ width: filterFocused || query ? 240 : 160 }}
            />
            <Button
              variant="ghost"
              onClick={() => {
                setLibraryTab(undefined)
                useStore.setState({ presetsOpen: true })
              }}
            >
              Library
            </Button>
            <Button variant="primary" onClick={() => openEditor(freshBinding(draft), true)} aria-keyshortcuts="Meta+N">
              New binding
            </Button>
          </>
        }
      />

      <div className="fade-bottom min-h-0 flex-1 overflow-y-auto pb-24 shadow-[0_-1px_0_var(--hairline)]">
        <div className={cn(GRID, 'sticky top-0 z-10 h-8 bg-bg px-6 pt-2 shadow-[0_1px_0_var(--hairline)]')}>
          <span className="tag-mono text-ink-3">Zone</span>
          <span className="tag-mono text-ink-3">When</span>
          <span className="tag-mono text-ink-3">Do</span>
          <span />
          <span className="tag-mono text-right text-ink-3">On</span>
        </div>
        {visible.length === 0 ? (
          <div className="px-2">
            {draft.bindings.length === 0 ? (
              <Empty
                title="No gestures yet."
                action={
                  <Button
                    variant="text"
                    className="text-ink underline decoration-ink-3 underline-offset-2"
                    onClick={() => {
                      setLibraryTab('Ready-made layouts')
                      useStore.setState({ presetsOpen: true })
                    }}
                  >
                    Start with a ready-made layout
                  </Button>
                }
              />
            ) : (
              <Empty title={`Nothing matches “${query}”.`} />
            )}
          </div>
        ) : (
          layers.map((layer) => (
            <section key={layer} aria-label={appName(layer)}>
              <div className="flex h-10 items-end gap-2 px-6 pb-2">
                <h2 className="label-mono text-ink-2">{appName(layer)}</h2>
                {layer !== '*' && <ProTag feature="Per-app layers" />}
              </div>
              <ul>
                <AnimatePresence initial={false}>
                  {visible
                    .filter((b) => b.app === layer)
                    .map((b) => {
                      const cs = conflicts[b.id] ?? []
                      const hard = cs.find((c) => c.kind !== 'delay')
                      const note = hard ?? cs[0]
                      const keys = b.action.kind === 'keystroke' ? comboText(b.action.key, b.action.modifiers) : null
                      const mods = sortModifiers(b.modifiers).map((m) => MODIFIER_GLYPH[m]).join('')
                      const pro = PRO_GESTURES.includes(b.gesture) || PRO_KINDS.includes(b.action.kind)
                      return (
                        <motion.li
                          key={b.id}
                          layout="position"
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0, transition: { duration: 0.12 } }}
                          transition={{ duration: 0.2 }}
                          className={cn(GRID, 'group h-12 cursor-default px-6 shadow-[0_1px_0_var(--hairline)] hover:bg-fill')}
                          onClick={() => openEditor(b, false)}
                        >
                          <span className="num text-[11px] tracking-[0.04em] text-ink-3">{indexText(b, draft)}</span>
                          <div className="min-w-0">
                            <p className={cn('flex items-center gap-2 truncate text-[13px] leading-[18px]', b.enabled ? 'text-ink' : 'text-ink-2')}>
                              {GESTURE_LABEL[b.gesture]}
                              {pro && <ProTag />}
                            </p>
                            <p className="truncate text-[12px] leading-4 text-ink-3">
                              {whereText(b, draft.zones)}
                              {mods && ` · ${mods}`}
                            </p>
                          </div>
                          <div className="min-w-0">
                            <p className={cn('flex items-center gap-2 truncate text-[13px] leading-[18px]', b.enabled ? 'text-ink' : 'text-ink-2')}>
                              <span className="truncate">{b.label || describeAction(b.action)}</span>
                              <ApprovalTag action={b.action} />
                            </p>
                            <p className="truncate text-[12px] leading-4 text-ink-3">{note ? note.message : keys ? '' : b.label !== describeAction(b.action) ? describeAction(b.action) : ''}</p>
                          </div>
                          <div className="flex items-center justify-end gap-3" onClick={(e) => e.stopPropagation()}>
                            {keys && <span className="num text-[11px] tracking-[0.04em] text-ink-2">{keys}</span>}
                            <span className="flex gap-3 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
                              <Button variant="text" size="sm" aria-label={`Test ${b.label}`} onClick={() => void test(b)}>
                                Test
                              </Button>
                              <Menu>
                                <MenuTrigger asChild>
                                  <Button variant="text" size="sm" aria-label={`More for ${b.label}`}>
                                    &middot;&middot;&middot;
                                  </Button>
                                </MenuTrigger>
                                <MenuContent align="end">
                                  <MenuItem onSelect={() => openEditor(b, false)}>Edit</MenuItem>
                                  <MenuItem onSelect={() => setDraft((c) => ({ ...c, bindings: [...c.bindings, { ...structuredClone(b), id: uid('b'), enabled: false }] }))}>
                                    Duplicate
                                  </MenuItem>
                                  <MenuSeparator />
                                  <MenuItem onSelect={() => setConfirmDelete(b)}>Delete</MenuItem>
                                </MenuContent>
                              </Menu>
                            </span>
                          </div>
                          <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                            <Switch
                              checked={b.enabled}
                              aria-label={`${b.enabled ? 'Turn off' : 'Turn on'} ${b.label}`}
                              onCheckedChange={(enabled) => setDraft((c) => ({ ...c, bindings: c.bindings.map((x) => (x.id === b.id ? { ...x, enabled } : x)) }))}
                            />
                          </span>
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
        initialTab={libraryTab}
        onOpenChange={(o) => useStore.setState({ presetsOpen: o })}
        onPick={pickPreset}
        onApplyLayout={(l) => setPendingLayout(l)}
      />
      <Confirm
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete “${confirmDelete?.label ?? 'binding'}”?`}
        body="The gesture stops doing anything. Nothing is saved until you press Save."
        confirmLabel="Delete binding"
        destructive
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
