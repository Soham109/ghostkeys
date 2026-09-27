import * as React from 'react'
import { toast } from 'sonner'
import {
  CAMERA_GESTURES,
  GESTURE_HINT,
  SOUND_GESTURES,
  SONAR_GESTURES,
  SONAR_AIR_GESTURES,
  SLIDER_GESTURES,
  ZONELESS_GESTURES,
  AIR_ZONE,
  type Action,
  type Binding,
  type Config,
  type GestureKind
} from '@shared/protocol'
import { defaultAction, describeAction, isDestructive } from '@shared/actions'
import { riskyParts } from '@shared/approval'
import { client } from '@/lib/client'
import { useStore } from '@/lib/store'
import { conflictsFor } from '@/lib/bindings'
import { ensureActionApproved } from '@/lib/approval'
import { Button } from '../ui/button'
import { Input, ProTag, Segmented, SectionLabel, ZoneIndex } from '../ui/controls'
import { Confirm, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Sheet } from '../ui/overlays'
import { ActionFields, KindSelect } from './ActionForm'
import { AppPicker } from './AppPicker'
import { ModifierChips } from './KeystrokeRecorder'
import { ApprovalNote } from './ApprovalBadge'
import { findCommand } from './IntegrationFields'
import { GesturePicker, demoFor } from '../gestures/GesturePicker'
import { GestureDemo } from '../gestures/GestureDemo'
import { SessionNote } from '../SessionNeed'

export const PRO_GESTURES: GestureKind[] = ['sequence', 'rhythm', 'lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right', ...SOUND_GESTURES, ...SONAR_GESTURES, ...CAMERA_GESTURES]

function Row({ label, children, align = 'center' }: { label: string; children: React.ReactNode; align?: 'center' | 'start' }): React.JSX.Element {
  return (
    <div className={`grid grid-cols-[96px_1fr] gap-4 ${align === 'start' ? 'items-start' : 'items-center'}`}>
      <span className={`text-[13px] text-ink-2 ${align === 'start' ? 'pt-1.5' : ''}`}>{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function ZoneSelect({ config, value, onChange, label }: { config: Config; value: string | null; onChange: (id: string) => void; label: string }): React.JSX.Element {
  return (
    <Select value={value ?? undefined} onValueChange={onChange}>
      <SelectTrigger aria-label={label}>
        <SelectValue placeholder="Pick a zone" />
      </SelectTrigger>
      <SelectContent>
        {config.zones.map((z, i) => (
          <SelectItem key={z.id} value={z.id}>
            <span className="flex items-center gap-2">
              <ZoneIndex n={i + 1} />
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
  const [pending, setPending] = React.useState<{ next: Action; why: string } | null>(null)
  const hello = useStore((s) => s.hello)
  const catalog = useStore((s) => s.catalog)

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
  const applyAction = (action: Action): void => patch({ action, ...(labelTouched ? {} : { label: describeAction(action) }) })
  const destructiveWhy = (a: Action): string | null => {
    if (isDestructive(a)) return 'A stray tap would quit the app in front of you. Apps may ask to save first, but not all do.'
    if (a.kind === 'integration' && findCommand(catalog, a)?.destructive) return 'This command can lose work in the app. Consider a double tap or holding a modifier.'
    return null
  }
  const setAction = (action: Action): void => {
    const why = destructiveWhy(action)
    if (why && !destructiveWhy(b.action)) setPending({ next: action, why })
    else applyAction(action)
  }
  const setGesture = (g: GestureKind): void => {
    const slider = SLIDER_GESTURES.includes(g) ? (b.slider ?? { mode: 'relative' as const, stepMm: 15, inverse: null }) : null
    if (SONAR_AIR_GESTURES.includes(g)) return patch({ gesture: g, zone: AIR_ZONE, zones: null, knob: null, slider })
    if (g.startsWith('finger_slide')) {
      const grille = config.zones.find((z) => z.id === 'right-grille')?.id ?? config.zones.find((z) => z.id.includes('grille'))?.id ?? config.zones[0]?.id ?? null
      return patch({ gesture: g, zone: b.zone && b.zone !== AIR_ZONE ? b.zone : grille, zones: null, knob: null, slider })
    }
    if (CAMERA_GESTURES.includes(g)) patch({ gesture: g, zone: AIR_ZONE, zones: null, knob: g === 'pinch_hold' ? (b.knob ?? { axis: 'y', stepPx: 24 }) : null })
    else if (ZONELESS_GESTURES.includes(g)) patch({ gesture: g, zone: null, zones: null, knob: null })
    else if (g === 'sequence') patch({ gesture: g, zone: null, zones: [b.zone ?? config.zones[0]?.id ?? '', config.zones[1]?.id ?? ''], knob: null })
    else patch({ gesture: g, zone: (b.zone === AIR_ZONE ? null : b.zone) ?? b.zones?.[0] ?? config.zones[0]?.id ?? null, zones: null, knob: null })
  }

  const preview = { ...config, bindings: isNew ? [...config.bindings, b] : config.bindings.map((x) => (x.id === b.id ? b : x)) }
  const conflicts = conflictsFor(preview)[b.id] ?? []
  const valid =
    (ZONELESS_GESTURES.includes(b.gesture) ||
      (b.gesture === 'sequence' ? (b.zones?.length ?? 0) === 2 && b.zones!.every(Boolean) && b.zones![0] !== b.zones![1] : !!b.zone)) &&
    !(b.action.kind === 'macro' && b.action.steps.length === 0)

  const test = async (): Promise<void> => {
    const approved = await ensureActionApproved(b.action, 'Testing this action.')
    if (!approved) return
    if (approved !== b.action) patch({ action: approved })
    if (!client.send({ type: 'test_action', action: approved })) toast('Could not reach the helper')
  }
  const done = async (): Promise<void> => {
    const label = b.label.trim() || describeAction(b.action)
    const approved = await ensureActionApproved(b.action, `Saving "${label}".`)
    if (!approved) return
    let inverse = b.knob?.inverse ?? null
    if (inverse) {
      inverse = await ensureActionApproved(inverse, `Saving "${label}", the opposite direction.`)
      if (!inverse) return
    }
    let sInverse = b.slider?.inverse ?? null
    if (sInverse) {
      sInverse = await ensureActionApproved(sInverse, `Saving "${label}", the opposite direction.`)
      if (!sInverse) return
    }
    onSave({ ...b, action: approved, label, ...(b.knob ? { knob: { ...b.knob, inverse } } : {}), ...(b.slider ? { slider: { ...b.slider, inverse: sInverse } } : {}) })
  }
  const revoke = (): void => {
    for (const p of riskyParts(b.action)) if (p.approvedHash) client.send({ type: 'revoke_action', hash: p.approvedHash })
    const strip = (a: Action): Action =>
      a.kind === 'macro' ? { ...a, steps: a.steps.map((s) => ({ ...s, approvedHash: undefined }) as typeof s) } : ({ ...a, approvedHash: undefined } as Action)
    patch({ action: JSON.parse(JSON.stringify(strip(b.action))) as Action })
    toast('Approval revoked', { description: 'It will not run until you approve it again.' })
  }

  const sensors = hello?.sensors

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(o) => !o && onClose()}
        title={isNew ? 'New binding' : 'Edit binding'}
        footer={
          <>
            {!isNew && (
              <Button variant="text" onClick={() => onDelete(b.id)}>
                Delete
              </Button>
            )}
            <div className="ml-auto flex items-center gap-5">
              <Button variant="text" onClick={() => void test()}>
                Test
              </Button>
              <Button variant="primary" disabled={!valid} onClick={() => void done()}>
                {isNew ? 'Add binding' : 'Done'}
              </Button>
            </div>
          </>
        }
      >
        <div className="flex flex-col px-6 pb-10">
          <SectionLabel>When</SectionLabel>
          <div className="flex flex-col gap-3 pt-1 pb-6 shadow-[0_1px_0_var(--hairline)]">
            <Row label="Gesture">
              <GesturePicker value={b.gesture} onChange={setGesture} sound={!!sensors?.sound} camera={!!sensors?.camera} pro={PRO_GESTURES} zone={b.zone} />
              <p className="mt-1.5 text-[12px] text-ink-3">{GESTURE_HINT[b.gesture]}</p>
            </Row>
            <div className="pl-[112px]">
              <SessionNote gesture={b.gesture} />
            </div>
            <div className="pl-[112px]">
              <GestureDemo
                {...demoFor(b)}
                className="aspect-[1.5676] w-full rounded-[6px] bg-sunken shadow-[inset_0_0_0_1px_var(--hairline)]"
                label={`How to do it: ${GESTURE_HINT[b.gesture]}`}
              />
            </div>

            {b.gesture === 'sequence' ? (
              <>
                <Row label="First">
                  <ZoneSelect config={config} label="First zone" value={b.zones?.[0] ?? null} onChange={(id) => patch({ zones: [id, b.zones?.[1] ?? ''] })} />
                </Row>
                <Row label="Then">
                  <ZoneSelect config={config} label="Second zone" value={b.zones?.[1] || null} onChange={(id) => patch({ zones: [b.zones?.[0] ?? '', id] })} />
                </Row>
              </>
            ) : !ZONELESS_GESTURES.includes(b.gesture) ? (
              <Row label="Zone">
                <ZoneSelect config={config} label="Zone" value={b.zone} onChange={(id) => patch({ zone: id })} />
              </Row>
            ) : null}

            {SLIDER_GESTURES.includes(b.gesture) && (
              <>
                <Row label="Slider">
                  <div className="flex items-center gap-3">
                    <Segmented
                      aria-label="Slider mode"
                      value={b.slider?.mode ?? 'relative'}
                      onValueChange={(mode) => patch({ slider: { stepMm: 15, ...b.slider, mode } })}
                      options={[
                        { value: 'relative', label: 'Like a knob' },
                        { value: 'absolute', label: 'Follows my hand' }
                      ]}
                    />
                    <label className="flex h-7 items-center gap-1 rounded-[6px] bg-fill px-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
                      <span className="tag-mono text-ink-3">Step</span>
                      <input
                        type="number"
                        min={2}
                        max={80}
                        value={b.slider?.stepMm ?? 15}
                        aria-label="Movement per step, millimetres"
                        onChange={(e) => patch({ slider: { mode: 'relative', ...b.slider, stepMm: Math.max(2, Number(e.target.value) || 15) } })}
                        className="num w-9 bg-transparent text-right text-[12px] text-ink outline-none"
                      />
                      <span className="tag-mono text-ink-3">mm</span>
                    </label>
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-3">
                    {b.slider?.mode === 'absolute'
                      ? 'The output follows your hand from where it started; moving back undoes the steps.'
                      : 'Each step of movement up runs the action below; each step down runs the opposite.'}
                  </p>
                </Row>
                <Row label="Opposite" align="start">
                  <div className="flex flex-col gap-3">
                    <KindSelect
                      allowMacro={false}
                      value={b.slider?.inverse?.kind ?? 'volume'}
                      onChange={(k) => patch({ slider: { mode: 'relative', stepMm: 15, ...b.slider, inverse: defaultAction(k) } })}
                    />
                    {b.slider?.inverse && <ActionFields compact action={b.slider.inverse} onChange={(a) => patch({ slider: { mode: 'relative', stepMm: 15, ...b.slider, inverse: a } })} />}
                  </div>
                </Row>
              </>
            )}

            {b.gesture === 'pinch_hold' && (
              <>
                <Row label="Knob">
                  <div className="flex items-center gap-3">
                    <Segmented
                      aria-label="Knob direction"
                      value={b.knob?.axis ?? 'y'}
                      onValueChange={(axis) => patch({ knob: { stepPx: 24, ...b.knob, axis } })}
                      options={[
                        { value: 'y', label: 'Up and down' },
                        { value: 'x', label: 'Left and right' }
                      ]}
                    />
                    <label className="flex h-7 items-center gap-1 rounded-[6px] bg-fill px-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
                      <span className="tag-mono text-ink-3">Step</span>
                      <input
                        type="number"
                        min={4}
                        max={200}
                        value={b.knob?.stepPx ?? 24}
                        aria-label="Hand movement per step, camera pixels"
                        onChange={(e) => patch({ knob: { axis: 'y', ...b.knob, stepPx: Math.max(4, Number(e.target.value) || 24) } })}
                        className="num w-9 bg-transparent text-right text-[12px] text-ink outline-none"
                      />
                      <span className="tag-mono text-ink-3">px</span>
                    </label>
                  </div>
                  <p className="mt-1.5 text-[12px] text-ink-3">Each step runs the action below once; moving the other way runs the opposite action.</p>
                </Row>
                <Row label="Opposite" align="start">
                  <div className="flex flex-col gap-3">
                    <KindSelect
                      allowMacro={false}
                      value={b.knob?.inverse?.kind ?? 'volume'}
                      onChange={(k) => patch({ knob: { axis: 'y', stepPx: 24, ...b.knob, inverse: defaultAction(k) } })}
                    />
                    {b.knob?.inverse && <ActionFields compact action={b.knob.inverse} onChange={(a) => patch({ knob: { axis: 'y', stepPx: 24, ...b.knob, inverse: a } })} />}
                  </div>
                </Row>
              </>
            )}

            <Row label="While holding">
              <ModifierChips label="Modifier keys held" value={b.modifiers} onChange={(modifiers) => patch({ modifiers })} />
            </Row>

            <Row label="In">
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <AppPicker value={b.app} onChange={(app) => patch({ app })} />
                </div>
                {b.app !== '*' && <ProTag feature="Per-app layers" />}
              </div>
            </Row>
            {conflicts.length > 0 && (
              <ul className="flex flex-col gap-1 pl-[112px]">
                {conflicts.map((c, i) => (
                  <li key={i} className="text-[12px] leading-relaxed text-ink-2">
                    {c.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <SectionLabel className="mt-4">Do</SectionLabel>
          <div className="flex flex-col gap-4 pt-1">
            <Row label="Action">
              <KindSelect value={b.action.kind} onChange={(k) => setAction(defaultAction(k))} />
            </Row>
            <div className={b.action.kind === 'macro' ? '' : 'pl-[112px]'}>
              <ActionFields action={b.action} onChange={setAction} />
            </div>
            <div className="pl-[112px]">
              <ApprovalNote action={b.action} onRevoke={revoke} />
            </div>
            {destructiveWhy(b.action) && <p className="pl-[112px] text-[12px] leading-relaxed text-ink-2">{destructiveWhy(b.action)}</p>}
            <Row label="Name">
              <Input
                value={b.label}
                placeholder={describeAction(b.action)}
                onChange={(e) => {
                  setLabelTouched(true)
                  patch({ label: e.target.value })
                }}
              />
              <p className="mt-1.5 text-[12px] text-ink-3">Shown at the top of the screen when it runs.</p>
            </Row>
          </div>
        </div>
      </Sheet>
      <Confirm
        open={!!pending}
        onOpenChange={(o) => !o && setPending(null)}
        title="Bind a gesture to something that can lose work?"
        body={pending?.why ?? ''}
        confirmLabel="Use it anyway"
        destructive
        onConfirm={() => {
          if (pending) applyAction(pending.next)
          setPending(null)
        }}
      />
    </>
  )
}
