import * as React from 'react'
import { Play, Trash2, TriangleAlert, Info } from 'lucide-react'
import { toast } from 'sonner'
import { GESTURES, GESTURE_HINT, GESTURE_LABEL, ZONELESS_GESTURES, type Action, type Binding, type Config, type GestureKind } from '@shared/protocol'
import { defaultAction, describeAction, isDestructive } from '@shared/actions'
import { client } from '@/lib/client'
import { conflictsFor } from '@/lib/bindings'
import { ensureApproved } from '@/lib/approval'
import { ApprovalNote } from './ApprovalBadge'
import { Button } from '../ui/button'
import { Input, SectionLabel, ZoneDot } from '../ui/controls'
import { Confirm, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Sheet } from '../ui/overlays'
import { ActionFields, KindSelect } from './ActionForm'
import { AppPicker } from './AppPicker'
import { ModifierChips } from './KeystrokeRecorder'

function ZoneSelect({ config, value, onChange, label }: { config: Config; value: string | null; onChange: (id: string) => void; label: string }): React.JSX.Element {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder="Pick a zone" />
      </SelectTrigger>
      <SelectContent>
        {config.zones.map((z) => (
          <SelectItem key={z.id} value={z.id}>
            <span className="flex items-center gap-2">
              <ZoneDot color={z.color} />
              {z.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function BindingEditor({
  open,
  initial,
  isNew,
  config,
  onClose,
  onSave,
  onDelete
}: {
  open: boolean
  initial: Binding | null
  isNew: boolean
  config: Config
  onClose: () => void
  onSave: (b: Binding) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  const [b, setB] = React.useState<Binding | null>(initial)
  const [labelTouched, setLabelTouched] = React.useState(false)
  const [pendingQuit, setPendingQuit] = React.useState<{ prev: Action; next: Action } | null>(null)

  React.useEffect(() => {
    setB(initial)
    setLabelTouched(!!initial && !isNew && initial.label !== describeAction(initial.action))
  }, [initial, isNew])

  if (!b)
    return (
      <Sheet open={false} onOpenChange={onClose} title="">
        {null}
      </Sheet>
    )

  const patch = (p: Partial<Binding>): void => setB((cur) => (cur ? { ...cur, ...p } : cur))
  const applyAction = (action: Action): void => {
    patch({ action, ...(labelTouched ? {} : { label: describeAction(action) }) })
  }
  const setAction = (action: Action): void => {
    if (isDestructive(action) && !isDestructive(b.action)) setPendingQuit({ prev: b.action, next: action })
    else applyAction(action)
  }
  const setGesture = (g: GestureKind): void => {
    if (ZONELESS_GESTURES.includes(g)) patch({ gesture: g, zone: null, zones: null })
    else if (g === 'sequence') patch({ gesture: g, zone: null, zones: [b.zone ?? config.zones[0]?.id ?? '', config.zones[1]?.id ?? ''] })
    else patch({ gesture: g, zone: b.zone ?? b.zones?.[0] ?? config.zones[0]?.id ?? null, zones: null })
  }

  const preview = { ...config, bindings: isNew ? [...config.bindings, b] : config.bindings.map((x) => (x.id === b.id ? b : x)) }
  const conflicts = conflictsFor(preview)[b.id] ?? []
  const valid =
    (ZONELESS_GESTURES.includes(b.gesture) ||
      (b.gesture === 'sequence' ? (b.zones?.length ?? 0) === 2 && b.zones!.every(Boolean) && b.zones![0] !== b.zones![1] : !!b.zone)) &&
    !(b.action.kind === 'macro' && b.action.steps.length === 0)

  const test = async (): Promise<void> => {
    if (!(await ensureApproved([b.action], 'Testing this action.'))) return
    if (!client.send({ type: 'test_action', action: b.action })) toast('Could not reach the service')
  }
  const done = async (): Promise<void> => {
    if (!(await ensureApproved([b.action], `Saving "${b.label.trim() || describeAction(b.action)}".`))) return
    onSave({ ...b, label: b.label.trim() || describeAction(b.action) })
  }

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={isNew ? 'New binding' : 'Edit binding'}
        footer={
          <>
            {!isNew && (
              <Button variant="danger" className="-ml-2" onClick={() => onDelete(b.id)}>
                <Trash2 />
                Delete
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button variant="outline" onClick={() => void test()}>
                <Play />
                Test
              </Button>
              <Button variant="primary" disabled={!valid} onClick={() => void done()}>
                {isNew ? 'Add binding' : 'Done'}
              </Button>
            </div>
          </>
        }
      >
        <div className="flex flex-col px-6 pb-8">
          <SectionLabel>When</SectionLabel>
          <div className="flex flex-col gap-4 pt-1 pb-6 shadow-[0_1px_0_var(--hairline)]">
            <div className="grid grid-cols-[88px_1fr] items-center gap-x-4 gap-y-3">
              <span className="text-[12px] text-ink-2">Gesture</span>
              <Select value={b.gesture} onValueChange={(v) => setGesture(v as GestureKind)}>
                <SelectTrigger aria-label="Gesture">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GESTURES.map((g) => (
                    <SelectItem key={g} value={g}>
                      {GESTURE_LABEL[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span />
              <p className="-mt-1.5 text-[12px] text-ink-3">{GESTURE_HINT[b.gesture]}</p>

              {b.gesture === 'sequence' ? (
                <>
                  <span className="text-[12px] text-ink-2">First</span>
                  <ZoneSelect config={config} label="First zone" value={b.zones?.[0] ?? null} onChange={(id) => patch({ zones: [id, b.zones?.[1] ?? ''] })} />
                  <span className="text-[12px] text-ink-2">Then</span>
                  <ZoneSelect config={config} label="Second zone" value={b.zones?.[1] || null} onChange={(id) => patch({ zones: [b.zones?.[0] ?? '', id] })} />
                </>
              ) : !ZONELESS_GESTURES.includes(b.gesture) ? (
                <>
                  <span className="text-[12px] text-ink-2">Zone</span>
                  <ZoneSelect config={config} label="Zone" value={b.zone} onChange={(id) => patch({ zone: id })} />
                </>
              ) : null}

              <span className="text-[12px] text-ink-2">Holding</span>
              <ModifierChips label="Modifier keys held" value={b.modifiers} onChange={(modifiers) => patch({ modifiers })} />

              <span className="text-[12px] text-ink-2">In</span>
              <AppPicker value={b.app} onChange={(app) => patch({ app })} />
            </div>
            {conflicts.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {conflicts.map((c, i) => (
                  <li key={i} className="flex gap-2 text-[12px] leading-relaxed text-ink-2">
                    {c.kind === 'delay' ? (
                      <Info className="mt-0.5 size-3.5 shrink-0 text-ink-3" />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
                    )}
                    {c.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <SectionLabel className="mt-4">Do</SectionLabel>
          <div className="flex flex-col gap-4 pt-1">
            <KindSelect value={b.action.kind} onChange={(k) => setAction(defaultAction(k))} />
            <ActionFields action={b.action} onChange={setAction} />
            <ApprovalNote action={b.action} />
            {isDestructive(b.action) && (
              <p className="flex gap-2 text-[12px] leading-relaxed text-ink-2">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
                Quits whichever app is in front. Apps may ask to save first, but not all do.
              </p>
            )}
            <label className="mt-2 flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-2">Name</span>
              <Input
                value={b.label}
                placeholder={describeAction(b.action)}
                onChange={(e) => {
                  setLabelTouched(true)
                  patch({ label: e.target.value })
                }}
              />
              <span className="text-[12px] text-ink-3">Shown in the HUD when it runs.</span>
            </label>
          </div>
        </div>
      </Sheet>
      <Confirm
        open={!!pendingQuit}
        onOpenChange={(o) => !o && setPendingQuit(null)}
        title="Bind a gesture to quitting apps?"
        body="A stray tap would quit the app in front of you. Apps may ask to save first, but not all do. Consider a double or triple tap, or holding a modifier."
        confirmLabel="Use quit"
        onConfirm={() => {
          if (pendingQuit) applyAction(pendingQuit.next)
          setPendingQuit(null)
        }}
      />
    </>
  )
}
