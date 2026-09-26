import * as React from 'react'
import { Reorder, useDragControls } from 'motion/react'
import { GripVertical, Play, Plus, TriangleAlert, X } from 'lucide-react'
import {
  APP_OPS,
  MACRO_MAX_STEPS,
  MACRO_MAX_TOTAL_MS,
  SYSTEM_OPS,
  WINDOW_OPS,
  type Action,
  type ActionKind,
  type MacroStep,
  type SimpleAction,
  type WindowOp
} from '@shared/protocol'
import { ACTION_KIND_LABEL, APP_LABEL, SYSTEM_LABEL, WINDOW_LABEL, defaultAction } from '@shared/actions'
import { client } from '@/lib/client'
import { ensureApproved } from '@/lib/approval'
import { ApprovalBadge } from './ApprovalBadge'
import { cn, uid } from '@/lib/utils'
import { Button } from '../ui/button'
import { Input, Segmented, Slider, Textarea, Tip } from '../ui/controls'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/overlays'
import { KeystrokeRecorder } from './KeystrokeRecorder'

export const KIND_GROUPS: { label: string; kinds: ActionKind[] }[] = [
  { label: 'Keys and text', kinds: ['keystroke', 'text', 'clipboard'] },
  { label: 'Media', kinds: ['media', 'volume', 'mute', 'brightness'] },
  { label: 'Windows and apps', kinds: ['window', 'app', 'open'] },
  { label: 'System', kinds: ['system', 'shortcut'] },
  { label: 'Scripts', kinds: ['shell', 'applescript'] },
  { label: 'Several steps', kinds: ['macro'] }
]

export function KindSelect({
  value,
  onChange,
  allowMacro = true,
  className
}: {
  value: ActionKind
  onChange: (k: ActionKind) => void
  allowMacro?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ActionKind)}>
      <SelectTrigger className={className} aria-label="Action type">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {KIND_GROUPS.filter((g) => allowMacro || !g.kinds.includes('macro')).map((g) => (
          <SelectGroup key={g.label}>
            <SelectLabel>{g.label}</SelectLabel>
            {g.kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {ACTION_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] text-ink-2">{label}</span>
      {children}
      {hint && <p className="text-[12px] leading-relaxed text-ink-3">{hint}</p>}
    </div>
  )
}

function WindowGlyph({ op }: { op: WindowOp }): React.JSX.Element {
  const area: Record<WindowOp, [number, number, number, number] | null> = {
    left: [0, 0, 0.5, 1],
    right: [0.5, 0, 0.5, 1],
    top: [0, 0, 1, 0.5],
    bottom: [0, 0.5, 1, 0.5],
    maximize: [0, 0, 1, 1],
    center: [0.2, 0.18, 0.6, 0.64],
    'next-display': null,
    minimize: null,
    fullscreen: [0, 0, 1, 1]
  }
  const a = area[op]
  return (
    <svg viewBox="0 0 30 20" className="h-5 w-[30px]" fill="none">
      <rect x={0.5} y={0.5} width={29} height={19} rx={2.5} stroke="currentColor" strokeOpacity={0.5} />
      {a && <rect x={1.5 + a[0] * 27} y={1.5 + a[1] * 17} width={a[2] * 27} height={a[3] * 17} rx={1.5} fill="currentColor" opacity={op === 'fullscreen' ? 0.35 : 0.8} />}
      {op === 'next-display' && <path d="M10 10h10m-3-3 3 3-3 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />}
      {op === 'minimize' && <path d="M11 14h8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />}
    </svg>
  )
}

const OPEN_SUGGESTIONS = ['Safari', 'Mail', 'Notes', 'Terminal', 'https://', '~/Downloads']

/** Kind-specific fields for one action. `compact` is used inside macro steps. */
export function ActionFields({ action, onChange, compact }: { action: SimpleAction | Action; onChange: (a: Action) => void; compact?: boolean }): React.JSX.Element | null {
  switch (action.kind) {
    case 'keystroke':
      return <KeystrokeRecorder value={action} onChange={(v) => onChange({ kind: 'keystroke', ...v })} />
    case 'volume':
    case 'brightness': {
      const max = action.kind === 'volume' ? 25 : 8
      return (
        <Field label={action.kind === 'volume' ? 'Change volume by' : 'Change brightness by'}>
          <div className="flex items-center gap-4">
            <Slider
              min={-max}
              max={max}
              step={1}
              value={[action.step]}
              onValueChange={([v]) => onChange({ ...action, step: v === 0 ? (action.step > 0 ? -1 : 1) : (v ?? 1) })}
              aria-label="Step"
            />
            <span className="num w-14 shrink-0 text-right text-[13px]">
              {action.step > 0 ? '+' : ''}
              {action.step}
              {action.kind === 'volume' ? '%' : ''}
            </span>
          </div>
        </Field>
      )
    }
    case 'mute':
      return compact ? null : <p className="text-[12px] text-ink-3">Mutes the current output, or unmutes it if already muted.</p>
    case 'media':
      return (
        <Segmented
          aria-label="Media command"
          value={action.command}
          onValueChange={(command) => onChange({ kind: 'media', command })}
          options={[
            { value: 'playpause', label: 'Play or pause' },
            { value: 'previous', label: 'Previous' },
            { value: 'next', label: 'Next' }
          ]}
        />
      )
    case 'open':
      return (
        <Field label="App, file or link" hint={compact ? undefined : 'An app name like Safari, a path like ~/Downloads, or a URL.'}>
          <Input value={action.target} placeholder="Safari" onChange={(e) => onChange({ kind: 'open', target: e.target.value })} />
          {!compact && (
            <div className="flex flex-wrap gap-1">
              {OPEN_SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => onChange({ kind: 'open', target: s })}
                  className="h-6 rounded-[5px] px-2 text-[12px] text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline)] hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </Field>
      )
    case 'shell':
      return (
        <Field label="Command">
          <div className="flex gap-2 text-[12px] leading-relaxed text-ink-2">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" />
            <p>Runs as you through zsh, stops after 10 seconds, and never gets administrator rights. Only use commands you understand.</p>
          </div>
          <Textarea
            value={action.command}
            spellCheck={false}
            placeholder="open -a Safari https://example.com"
            className="min-h-20 font-mono text-[12px]"
            onChange={(e) => onChange({ kind: 'shell', command: e.target.value })}
          />
        </Field>
      )
    case 'applescript':
      return (
        <Field label="Script">
          <Textarea
            value={action.source}
            spellCheck={false}
            className="min-h-32 font-mono text-[12px] leading-relaxed"
            onChange={(e) => onChange({ kind: 'applescript', source: e.target.value })}
          />
        </Field>
      )
    case 'shortcut':
      return (
        <Field label="Shortcut name" hint={compact ? undefined : 'Exactly as it appears in the Shortcuts app.'}>
          <Input value={action.name} placeholder="Start focus session" onChange={(e) => onChange({ kind: 'shortcut', name: e.target.value })} />
        </Field>
      )
    case 'text':
    case 'clipboard':
      return (
        <Field label={action.kind === 'text' ? 'Text to type' : 'Text to copy'} hint={compact ? undefined : action.kind === 'text' ? 'Typed into whatever has focus.' : 'Placed on the clipboard, ready to paste.'}>
          <Textarea value={action.text} className={compact ? 'min-h-14' : undefined} onChange={(e) => onChange({ kind: action.kind, text: e.target.value })} />
        </Field>
      )
    case 'window':
      return (
        <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Window arrangement">
          {WINDOW_OPS.map((op) => (
            <button
              key={op}
              type="button"
              role="radio"
              aria-checked={action.op === op}
              onClick={() => onChange({ kind: 'window', op })}
              className={cn(
                'flex h-[52px] flex-col items-center justify-center gap-1 rounded-[6px] text-[11px] transition-colors duration-150',
                action.op === op ? 'bg-fill-active text-ink' : 'text-ink-3 hover:bg-fill-hover hover:text-ink-2'
              )}
            >
              <WindowGlyph op={op} />
              {WINDOW_LABEL[op]}
            </button>
          ))}
        </div>
      )
    case 'app':
      return (
        <Select value={action.op} onValueChange={(v) => onChange({ kind: 'app', op: v as (typeof APP_OPS)[number] })}>
          <SelectTrigger aria-label="App command">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_OPS.map((op) => (
              <SelectItem key={op} value={op}>
                {APP_LABEL[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'system':
      return (
        <Select value={action.op} onValueChange={(v) => onChange({ kind: 'system', op: v as (typeof SYSTEM_OPS)[number] })}>
          <SelectTrigger aria-label="System command">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYSTEM_OPS.map((op) => (
              <SelectItem key={op} value={op}>
                {SYSTEM_LABEL[op]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
    case 'macro':
      return <MacroBuilder steps={action.steps} onChange={(steps) => onChange({ kind: 'macro', steps })} />
  }
}

// ---------------------------------------------------------------- macro builder

interface Row {
  uid: string
  step: MacroStep
}

function StepRow({
  row,
  index,
  onChange,
  onRemove
}: {
  row: Row
  index: number
  onChange: (s: MacroStep) => void
  onRemove: () => void
}): React.JSX.Element {
  const controls = useDragControls()
  const { delayMs, ...action } = row.step
  return (
    <Reorder.Item
      value={row}
      dragListener={false}
      dragControls={controls}
      className="relative bg-bg shadow-[0_1px_0_var(--hairline)]"
      whileDrag={{ scale: 1.01, boxShadow: 'var(--pop-shadow)', zIndex: 5 }}
      transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
    >
      <div className="flex items-center gap-2 py-2 pr-1">
        <button
          type="button"
          aria-label={`Drag to reorder step ${index + 1}`}
          onPointerDown={(e) => controls.start(e)}
          className="flex h-7 w-5 cursor-grab touch-none items-center justify-center text-ink-3 hover:text-ink-2 active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" />
        </button>
        <span className="num w-5 text-[12px] text-ink-3">{String(index + 1).padStart(2, '0')}</span>
        <ApprovalBadge action={action as SimpleAction} compact />
        <KindSelect
          className="h-7 flex-1"
          allowMacro={false}
          value={action.kind}
          onChange={(k) => onChange({ ...(defaultAction(k) as SimpleAction), delayMs })}
        />
        <Tip content="Wait this long before the step runs">
          <label className="flex h-7 items-center gap-1 rounded-[6px] bg-fill px-2 shadow-[inset_0_0_0_1px_var(--hairline)]">
            <span className="text-[11px] text-ink-3">wait</span>
            <input
              type="number"
              min={0}
              max={10000}
              step={10}
              value={delayMs ?? 0}
              aria-label={`Delay before step ${index + 1}, milliseconds`}
              onChange={(e) => onChange({ ...action, delayMs: Math.max(0, Math.min(10000, Number(e.target.value) || 0)) } as MacroStep)}
              className="num w-11 bg-transparent text-right text-[12px] text-ink outline-none"
            />
            <span className="text-[11px] text-ink-3">ms</span>
          </label>
        </Tip>
        <Tip content="Run just this step">
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Test step ${index + 1}`}
            onClick={async () => {
              if (await ensureApproved([action as SimpleAction], `Testing step ${index + 1}.`)) client.send({ type: 'test_action', action: action as SimpleAction })
            }}
          >
            <Play />
          </Button>
        </Tip>
        <Button variant="ghost" size="icon" aria-label={`Remove step ${index + 1}`} onClick={onRemove}>
          <X />
        </Button>
      </div>
      {action.kind !== 'mute' && (
        <div className="pb-3 pl-14">
          <ActionFields compact action={action as SimpleAction} onChange={(a) => onChange({ ...(a as SimpleAction), delayMs } as MacroStep)} />
        </div>
      )}
    </Reorder.Item>
  )
}

export function MacroBuilder({ steps, onChange }: { steps: MacroStep[]; onChange: (s: MacroStep[]) => void }): React.JSX.Element {
  // Stable row ids so reordering animates; kept in step with `steps` by position.
  const idsRef = React.useRef<string[]>([])
  const ids = idsRef.current
  while (ids.length < steps.length) ids.push(uid('step'))
  ids.length = steps.length
  const rows: Row[] = steps.map((step, i) => ({ uid: ids[i]!, step }))
  const total = steps.reduce((s, x) => s + (x.delayMs ?? 0), 0)
  const full = steps.length >= MACRO_MAX_STEPS

  const add = (a: SimpleAction): void => {
    ids.push(uid('step'))
    onChange([...steps, { ...a, delayMs: steps.length ? 50 : 0 }])
  }

  return (
    <div className="flex flex-col">
      {rows.length > 0 ? (
        <Reorder.Group
          axis="y"
          values={rows}
          onReorder={(next: Row[]) => {
            idsRef.current = next.map((r) => r.uid)
            onChange(next.map((r) => r.step))
          }}
          className="shadow-[0_-1px_0_var(--hairline)]"
        >
          {rows.map((row, i) => (
            <StepRow
              key={row.uid}
              row={row}
              index={i}
              onChange={(s) => onChange(steps.map((x, j) => (j === i ? s : x)))}
              onRemove={() => {
                ids.splice(i, 1)
                onChange(steps.filter((_, j) => j !== i))
              }}
            />
          ))}
        </Reorder.Group>
      ) : (
        <p className="py-3 text-[12px] leading-relaxed text-ink-3">
          A macro runs its steps in order and stops at the first one that fails. Add a step to begin.
        </p>
      )}
      <div className="flex items-center justify-between pt-3">
        <Menu>
          <MenuTrigger asChild>
            <Button variant="outline" size="md" disabled={full}>
              <Plus />
              Add step
            </Button>
          </MenuTrigger>
          <MenuContent align="start" className="max-h-80 overflow-y-auto">
            {KIND_GROUPS.filter((g) => !g.kinds.includes('macro')).map((g, gi) => (
              <React.Fragment key={g.label}>
                {gi > 0 && <MenuSeparator />}
                <MenuLabel>{g.label}</MenuLabel>
                {g.kinds.map((k) => (
                  <MenuItem key={k} onSelect={() => add(defaultAction(k) as SimpleAction)}>
                    {ACTION_KIND_LABEL[k]}
                  </MenuItem>
                ))}
              </React.Fragment>
            ))}
          </MenuContent>
        </Menu>
        <span className={cn('num text-[11px]', total > MACRO_MAX_TOTAL_MS ? 'text-danger' : 'text-ink-3')}>
          {steps.length}/{MACRO_MAX_STEPS} steps, {(total / 1000).toFixed(2)}/{MACRO_MAX_TOTAL_MS / 1000} s
        </span>
      </div>
    </div>
  )
}

