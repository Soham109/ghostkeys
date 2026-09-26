import * as React from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import type { CalibrationMsg, Zone } from '@shared/protocol'
import { SURFACE_LABEL } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn, pct } from '@/lib/utils'
import { PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Segmented, Textarea, ZoneDot } from '@/components/ui/controls'
import { LaptopMap } from '@/components/laptop/LaptopMap'

type Step = 'pick' | 'capture' | 'negatives' | 'training' | 'results'
type Done = Extract<CalibrationMsg, { phase: 'done' }>

interface Wizard {
  step: Step
  picked: string[]
  target: number
  index: number
  counts: Record<string, number>
  negSeconds: number
  negLeft: number
  heard: { typing: number; trackpad: number }
  result: Done | null
}

const NEG_SECONDS = 45

export const useWizard = create<Wizard>()(() => ({
  step: 'pick',
  picked: [],
  target: 20,
  index: 0,
  counts: {},
  negSeconds: NEG_SECONDS,
  negLeft: NEG_SECONDS,
  heard: { typing: 0, trackpad: 0 },
  result: null
}))

const STEPS: { id: Step[]; label: string }[] = [
  { id: ['pick'], label: 'Choose zones' },
  { id: ['capture'], label: 'Tap each zone' },
  { id: ['negatives'], label: 'Type normally' },
  { id: ['training', 'results'], label: 'Results' }
]

function Stepper({ step }: { step: Step }): React.JSX.Element {
  const at = STEPS.findIndex((s) => s.id.includes(step))
  return (
    <ol className="flex items-center gap-6" aria-label="Calibration steps">
      {STEPS.map((s, i) => (
        <li key={s.label} className={cn('flex items-center gap-2 text-[12px]', i === at ? 'text-ink' : i < at ? 'text-ink-2' : 'text-ink-3')} aria-current={i === at ? 'step' : undefined}>
          <span className={cn('num inline-flex size-5 items-center justify-center rounded-full text-[11px]', i === at ? 'bg-ink text-bg' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]')}>
            {i < at ? <Check className="size-3" /> : i + 1}
          </span>
          {s.label}
        </li>
      ))}
    </ol>
  )
}

// ---------------------------------------------------------------- flow control

function beginCapture(): void {
  const { picked, target } = useWizard.getState()
  if (!picked.length) return
  client.send({ type: 'calibration_start', zones: picked, target })
  client.send({ type: 'calibration_zone', zone: picked[0]! })
  useWizard.setState({ step: 'capture', index: 0, counts: {}, result: null, heard: { typing: 0, trackpad: 0 } })
}

function advance(): void {
  const w = useWizard.getState()
  const next = w.index + 1
  if (next < w.picked.length) {
    client.send({ type: 'calibration_zone', zone: w.picked[next]! })
    useWizard.setState({ index: next })
  } else {
    client.send({ type: 'calibration_negatives', seconds: NEG_SECONDS })
    useWizard.setState({ step: 'negatives', negLeft: NEG_SECONDS, negSeconds: NEG_SECONDS })
  }
}

function cancel(): void {
  client.send({ type: 'calibration_cancel' })
  useWizard.setState({ step: 'pick', index: 0, counts: {} })
}

function useCalibrationEvents(): void {
  React.useEffect(() => {
    const offCal = client.on('calibration', (m) => {
      const w = useWizard.getState()
      if (m.phase === 'capturing') {
        useWizard.setState({ counts: { ...w.counts, [m.zone]: m.count } })
      } else if (m.phase === 'negatives') {
        useWizard.setState({ negLeft: m.secondsLeft })
        if (m.secondsLeft <= 0 && w.step === 'negatives') {
          client.send({ type: 'calibration_finish' })
          useWizard.setState({ step: 'training' })
        }
      } else if (m.phase === 'done') {
        useWizard.setState({ step: 'results', result: m })
      }
    })
    const offRej = client.on('rejected', (r) => {
      const w = useWizard.getState()
      if (w.step !== 'negatives') return
      if (r.reason === 'typing' || r.reason === 'trackpad') useWizard.setState({ heard: { ...w.heard, [r.reason]: w.heard[r.reason] + 1 } })
    })
    return () => {
      offCal()
      offRej()
    }
  }, [])

  // Auto-advance when the current zone has enough taps.
  const { step, index, picked, counts, target } = useWizard()
  const current = picked[index]
  const full = step === 'capture' && !!current && (counts[current] ?? 0) >= target
  React.useEffect(() => {
    if (!full) return
    const t = setTimeout(advance, 700)
    return () => clearTimeout(t)
  }, [full, index])
}

// ---------------------------------------------------------------- steps

function Pick({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { picked, target } = useWizard()
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const toggle = (id: string): void =>
    useWizard.setState({ picked: picked.includes(id) ? picked.filter((x) => x !== id) : zones.filter((z) => picked.includes(z.id) || z.id === id).map((z) => z.id) })

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[380px] shrink-0 flex-col px-6 pt-6">
        <h2 className="text-[20px] leading-tight font-medium tracking-[-0.015em]">Teach Ghostkeys how your taps feel.</h2>
        <p className="mt-2 max-w-[48ch] text-[13px] leading-relaxed text-ink-2">
          Every MacBook rings a little differently. You tap each zone a few times, then type normally for {NEG_SECONDS} seconds so
          Ghostkeys learns what to ignore.
        </p>
        <div className="mt-6 flex items-end justify-between pb-2">
          <span className="label-mono">Zones</span>
          <button
            className="text-[12px] text-ink-3 hover:text-ink"
            onClick={() => useWizard.setState({ picked: picked.length === zones.length ? [] : zones.map((z) => z.id) })}
          >
            {picked.length === zones.length ? 'Select none' : 'Select all'}
          </button>
        </div>
        <ul className="min-h-0 overflow-y-auto shadow-[0_-1px_0_var(--hairline)]">
          {zones.map((z) => {
            const on = picked.includes(z.id)
            return (
              <li key={z.id}>
                <button
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(z.id)}
                  className="flex h-9 w-full items-center gap-3 px-1 text-left shadow-[0_1px_0_var(--hairline)] hover:bg-fill"
                >
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-[4px] transition-colors duration-150',
                      on ? 'bg-ink text-bg' : 'shadow-[inset_0_0_0_1px_var(--hairline-strong)]'
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <ZoneDot color={z.color} />
                  <span className="flex-1 text-[13px]">{z.name}</span>
                  <span className="text-[11px] text-ink-3">{SURFACE_LABEL[z.surface]}</span>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="mt-6 flex items-center justify-between">
          <span className="text-[12px] text-ink-2">Taps per zone</span>
          <Segmented
            aria-label="Taps per zone"
            value={String(target)}
            onValueChange={(v) => useWizard.setState({ target: Number(v) })}
            options={[
              { value: '10', label: '10' },
              { value: '20', label: '20' },
              { value: '30', label: '30' }
            ]}
          />
        </div>
        <div className="mt-6 pb-6">
          <Button variant="primary" size="lg" disabled={!picked.length} onClick={beginCapture}>
            Start with {picked.length ? zones.find((z) => z.id === picked[0])?.name.toLowerCase() : 'a zone'}
          </Button>
        </div>
      </div>
      <div className="relative min-w-0 flex-1 px-8 pt-6 pb-8 shadow-[-1px_0_0_var(--hairline)]">
        <LaptopMap family={family} zones={zones} mode="live" mutedIds={zones.filter((z) => !picked.includes(z.id)).map((z) => z.id)} onSelect={(id) => id && toggle(id)} selectedId={null} />
      </div>
    </div>
  )
}

function Ring({ value, size = 132, stroke = 2, children }: { value: number; size?: number; stroke?: number; children?: React.ReactNode }): React.JSX.Element {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline-strong)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          animate={{ strokeDashoffset: c * (1 - Math.min(1, value)) }}
          transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  )
}

function Capture({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { picked, index, counts, target } = useWizard()
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const zone = zones.find((z) => z.id === picked[index])
  const count = zone ? (counts[zone.id] ?? 0) : 0
  const reduce = useReducedMotion()

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[320px] shrink-0 flex-col px-6 pt-6 pb-6">
        <AnimatePresence mode="wait">
          <motion.div
            key={zone?.id}
            initial={{ opacity: 0, y: reduce ? 0 : 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduce ? 0 : -8 }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
          >
            <p className="label-mono">
              Zone {index + 1} of {picked.length}
            </p>
            <h2 className="mt-2 text-[20px] leading-tight font-medium tracking-[-0.015em]">Tap the {zone?.name.toLowerCase()}</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">Use one fingertip. Vary the spot and strength a little, the way you would in real use.</p>
          </motion.div>
        </AnimatePresence>
        <div className="mt-8">
          <Ring value={count / target}>
            <span className="num text-[40px] leading-none font-medium">{String(count).padStart(2, '0')}</span>
            <span className="num mt-1 text-[12px] text-ink-3">of {target}</span>
          </Ring>
        </div>
        <ul className="mt-8 flex flex-col">
          {picked.map((id, i) => {
            const z = zones.find((x) => x.id === id)
            const c = counts[id] ?? 0
            return (
              <li key={id} className={cn('flex h-7 items-center gap-2.5 text-[12px]', i === index ? 'text-ink' : i < index ? 'text-ink-2' : 'text-ink-3')}>
                <ZoneDot color={z?.color ?? 'var(--ink-3)'} className={i > index ? 'opacity-40' : ''} />
                <span className="flex-1 truncate">{z?.name ?? id}</span>
                <span className="relative h-px w-16 bg-hairline-strong">
                  <motion.span className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${Math.min(1, c / target) * 100}%` }} transition={{ duration: 0.2 }} />
                </span>
                <span className="num w-10 text-right text-[11px]">
                  {c}/{target}
                </span>
              </li>
            )
          })}
        </ul>
        <div className="mt-auto flex gap-2 pt-6">
          <Button variant="ghost" className="-ml-3" onClick={cancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={advance}>
            {index + 1 < picked.length ? 'Skip this zone' : 'Continue'}
          </Button>
        </div>
      </div>
      <div className="relative min-w-0 flex-1 px-8 pt-6 pb-8 shadow-[-1px_0_0_var(--hairline)]">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(55% 50% at 50% 50%, var(--light-behind), transparent 70%)' }} />
        <LaptopMap family={family} zones={zones} mode="calibrate" focusId={zone?.id ?? null} listenTaps tapFilter={zone?.id ?? null} />
      </div>
    </div>
  )
}

function Negatives(): React.JSX.Element {
  const { negLeft, negSeconds, heard } = useWizard()
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 pt-6">
      <div className="flex max-w-[760px] gap-12">
        <div className="shrink-0">
          <Ring value={1 - negLeft / negSeconds} size={168}>
            <span className="num text-[56px] leading-none font-medium tracking-[-0.03em]">{negLeft}</span>
            <span className="mt-1 text-[12px] text-ink-3">seconds</span>
          </Ring>
        </div>
        <div className="min-w-0 flex-1 pt-2">
          <h2 className="text-[20px] leading-tight font-medium tracking-[-0.015em]">Now just type, and use your trackpad.</h2>
          <p className="mt-2 max-w-[56ch] text-[13px] leading-relaxed text-ink-2">
            Ghostkeys records how ordinary typing and clicking feel so it never mistakes them for a tap. Write anything below, scroll,
            click around. Avoid tapping the zones.
          </p>
          <Textarea autoFocus className="mt-5 min-h-28 text-[14px]" placeholder="The quick brown fox jumps over the lazy dog." aria-label="Type anything here" />
          <dl className="mt-4 flex gap-8">
            <div>
              <dt className="label-mono">Typing heard</dt>
              <dd className="num mt-1 text-[20px]">{heard.typing}</dd>
            </div>
            <div>
              <dt className="label-mono">Trackpad heard</dt>
              <dd className="num mt-1 text-[20px]">{heard.trackpad}</dd>
            </div>
          </dl>
          <div className="mt-8">
            <Button variant="ghost" className="-ml-3" onClick={cancel}>
              Cancel calibration
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Training(): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-start px-6 pt-10">
      <div className="flex gap-1.5" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-ink"
            animate={{ opacity: [0.2, 1, 0.2] }}
            transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </div>
      <h2 className="mt-5 text-[20px] font-medium tracking-[-0.015em]">Training on your taps</h2>
      <p className="mt-2 text-[13px] text-ink-2">This happens on your Mac. Nothing leaves it.</p>
    </div>
  )
}

function Results({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { result } = useWizard()
  const navigate = useStore((s) => s.navigate)
  if (!result) return <Training />
  const name = (id: string): string => (id === 'none' ? 'Ignored' : (zones.find((z) => z.id === id)?.name ?? id))
  const color = (id: string): string => zones.find((z) => z.id === id)?.color ?? 'var(--ink-3)'
  const entries = Object.entries(result.accuracy)
  const weak = entries.filter(([, a]) => a < 0.9)
  const labels = result.labels
  const rowTotals = result.confusion.map((row) => row.reduce((s, v) => s + v, 0) || 1)

  const advice = weak.map(([id]) => {
    const i = labels.indexOf(id)
    const row = result.confusion[i] ?? []
    let worst = -1
    let worstV = 0
    row.forEach((v, j) => {
      if (j !== i && v > worstV) {
        worst = j
        worstV = v
      }
    })
    const share = worst >= 0 ? worstV / rowTotals[i]! : 0
    const other = worst >= 0 ? labels[worst]! : null
    return {
      id,
      text:
        other === 'none'
          ? `${name(id)} taps are often ignored (${pct(share)}). Tap a little firmer, or raise sensitivity in Settings.`
          : other
            ? `${name(id)} is mistaken for ${name(other).toLowerCase()} ${pct(share)} of the time. Tap nearer its middle, move the two zones apart, or recalibrate with 30 taps.`
            : `${name(id)} needs more samples. Recalibrate it with 30 taps.`
    }
  })

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-10">
      <div className="flex items-end gap-10 pb-6 hairline-b">
        <div>
          <p className="label-mono">Overall accuracy</p>
          <p className="num mt-1 text-[64px] leading-[0.95] font-medium tracking-[-0.04em]">{pct(result.overall)}</p>
        </div>
        <p className="max-w-[46ch] pb-2 text-[13px] leading-relaxed text-ink-2">
          {weak.length === 0
            ? 'Every zone is reliable. Ghostkeys is ready.'
            : `${weak.length === 1 ? 'One zone needs' : `${weak.length} zones need`} attention. The rest are reliable and ready to use.`}
        </p>
        <div className="ml-auto flex gap-2 pb-2">
          {weak.length > 0 && (
            <Button
              variant="outline"
              onClick={() => useWizard.setState({ step: 'pick', picked: weak.map(([id]) => id), target: 30 })}
            >
              Recalibrate weak zones
            </Button>
          )}
          <Button variant="primary" onClick={() => navigate('live')}>
            Done
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-12 pt-6">
        <section aria-label="Accuracy per zone">
          <p className="label-mono pb-2">Per zone</p>
          <ul className="shadow-[0_-1px_0_var(--hairline)]">
            {entries.map(([id, a], i) => (
              <li key={id} className="flex h-9 items-center gap-3 shadow-[0_1px_0_var(--hairline)]">
                <ZoneDot color={color(id)} />
                <span className="w-32 truncate text-[13px]">{name(id)}</span>
                <span className="relative h-[3px] flex-1 overflow-hidden rounded-full bg-hairline">
                  <motion.span
                    className={cn('absolute inset-y-0 left-0 rounded-full', a < 0.9 ? 'bg-danger' : 'bg-ink')}
                    initial={{ width: 0 }}
                    animate={{ width: `${a * 100}%` }}
                    transition={{ duration: 0.9, delay: 0.08 * i, ease: [0.16, 1, 0.3, 1] }}
                  />
                </span>
                <span className={cn('num w-12 text-right text-[12px]', a < 0.9 ? 'text-danger' : 'text-ink-2')}>{pct(a)}</span>
              </li>
            ))}
          </ul>
          {advice.length > 0 && (
            <>
              <p className="label-mono pt-8 pb-2">Advice</p>
              <ul className="flex flex-col gap-3">
                {advice.map((a) => (
                  <li key={a.id} className="flex gap-2.5 text-[13px] leading-relaxed text-ink-2">
                    <ZoneDot color={color(a.id)} className="mt-[6px]" />
                    {a.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section aria-label="Confusion matrix">
          <p className="label-mono pb-2">What each tap was taken for</p>
          <div className="overflow-x-auto pt-2">
            <table className="table-fixed border-separate border-spacing-[2px] text-[11px]">
              <thead>
                <tr>
                  <th />
                  {labels.map((l) => (
                    <th key={l} className="relative h-24 w-8 max-w-8 min-w-8 p-0 font-normal text-ink-3">
                      <span className="absolute bottom-1 left-3.5 block w-24 origin-bottom-left -rotate-45 truncate text-left whitespace-nowrap">{name(l)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.confusion.map((row, i) => (
                  <tr key={labels[i]}>
                    <th scope="row" className="max-w-28 truncate pr-2 text-right font-normal text-ink-2">
                      {name(labels[i]!)}
                    </th>
                    {row.map((v, j) => {
                      const share = v / rowTotals[i]!
                      const diag = i === j
                      return (
                        <td
                          key={j}
                          title={`${name(labels[i]!)} taken as ${name(labels[j]!)}: ${pct(share, 1)}`}
                          className="num h-8 w-8 max-w-8 min-w-8 rounded-[3px] p-0 text-center text-[10px]"
                          style={{
                            background: diag
                              ? `color-mix(in srgb, var(--ink) ${Math.round(share * 85)}%, transparent)`
                              : share > 0
                                ? `color-mix(in srgb, var(--danger) ${Math.round(Math.min(1, share * 3) * 70)}%, transparent)`
                                : 'var(--fill)',
                            color: diag && share > 0.5 ? 'var(--bg)' : 'var(--ink-2)'
                          }}
                        >
                          {share >= 0.01 ? Math.round(share * 100) : ''}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-[52ch] text-[12px] leading-relaxed text-ink-3">
            Rows are where you tapped, columns are what Ghostkeys heard, in percent. The diagonal is right; anything else is a mix-up.
          </p>
        </section>
      </div>
    </div>
  )
}

export function CalibrationScreen(): React.JSX.Element {
  useCalibrationEvents()
  const step = useWizard((s) => s.step)
  const picked = useWizard((s) => s.picked)
  const zones = useStore((s) => s.config?.zones ?? [])

  // Default to every zone the first time.
  React.useEffect(() => {
    if (step === 'pick' && picked.length === 0 && zones.length) useWizard.setState({ picked: zones.map((z) => z.id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zones.length])

  return (
    <>
      <PageHeader title="Calibration" actions={<Stepper step={step} />} />
      <div className="flex min-h-0 flex-1 flex-col shadow-[0_-1px_0_var(--hairline)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={step === 'training' ? 'results' : step}
            className="flex min-h-0 flex-1 flex-col"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
          >
            {step === 'pick' && <Pick zones={zones} />}
            {step === 'capture' && <Capture zones={zones} />}
            {step === 'negatives' && <Negatives />}
            {(step === 'training' || step === 'results') && <Results zones={zones} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </>
  )
}
