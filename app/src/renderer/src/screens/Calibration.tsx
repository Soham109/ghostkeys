import * as React from 'react'
import { create } from 'zustand'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import type { CalibrationMsg, Zone } from '@shared/protocol'
import { SURFACE_LABEL } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn, pct } from '@/lib/utils'
import { PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Check, Segmented, ZoneIndex } from '@/components/ui/controls'
import { Tick } from '@/components/ui/glyphs'
import { LaptopMap } from '@/components/laptop/LaptopMap'
import { Seismograph } from '@/components/Seismograph'

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
    <ol className="flex items-center gap-5" aria-label="Calibration steps">
      {STEPS.map((s, i) => (
        <li key={s.label} className={cn('flex items-center gap-2 text-[12px]', i === at ? 'text-ink' : i < at ? 'text-ink-2' : 'text-ink-3')} aria-current={i === at ? 'step' : undefined}>
          <span className="num text-[11px]">{i < at ? <Tick className="inline size-3" /> : String(i + 1).padStart(2, '0')}</span>
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
      } else if (m.phase === 'training') {
        useWizard.setState({ step: 'training' })
      } else if (m.phase === 'cancelled') {
        if (w.step !== 'results') useWizard.setState({ step: 'pick', index: 0, counts: {} })
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

// ---------------------------------------------------------------- the shared frame

function Frame({ left, right }: { left: React.ReactNode; right: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-[360px] shrink-0 flex-col overflow-y-auto px-6 pt-6 pb-6">{left}</div>
      <div className="relative flex min-w-0 flex-1 flex-col px-8 pt-6 pb-6 shadow-[-1px_0_0_var(--hairline)]">
        <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(55% 50% at 50% 45%, var(--light-behind), transparent 70%)' }} />
        <div className="relative flex min-h-0 flex-1 flex-col">{right}</div>
      </div>
    </div>
  )
}

function Heading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="text-[20px] leading-[1.2] font-medium tracking-[-0.015em]">{children}</h2>
}
function Body({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mt-2 max-w-[48ch] text-[15px] leading-[1.55] text-ink-2">{children}</p>
}

/** A countable dial: one tick per tap, the newest flashes signal. */
function Dial({ count, target, size = 148, children }: { count: number; target: number; size?: number; children?: React.ReactNode }): React.JSX.Element {
  const r = size / 2 - 6
  const c = size / 2
  const [flash, setFlash] = React.useState<number | null>(null)
  const prev = React.useRef(count)
  React.useEffect(() => {
    if (count > prev.current) {
      setFlash(count - 1)
      const t = setTimeout(() => setFlash(null), 160)
      prev.current = count
      return () => clearTimeout(t)
    }
    prev.current = count
  }, [count])
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden>
        {Array.from({ length: target }, (_, i) => {
          const a = (i / target) * Math.PI * 2 - Math.PI / 2
          const done = i < count
          return (
            <line
              key={i}
              x1={c + Math.cos(a) * (r - 7)}
              y1={c + Math.sin(a) * (r - 7)}
              x2={c + Math.cos(a) * r}
              y2={c + Math.sin(a) * r}
              stroke={flash === i ? 'var(--signal)' : done ? 'var(--ink)' : 'var(--ink-3)'}
              strokeOpacity={done || flash === i ? 1 : 0.5}
              strokeWidth={1.25}
              strokeLinecap="round"
              style={{ transition: 'stroke 160ms var(--ease-snap)' }}
            />
          )
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  )
}

/** The number rolls: old digit up and out, new one up from below. */
function Roll({ value, className }: { value: string; className?: string }): React.JSX.Element {
  return (
    <span className={cn('relative inline-flex overflow-hidden', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: 8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
          className="inline-block"
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function useCountUp(target: number, ms = 900): number {
  const [v, setV] = React.useState(0)
  const reduce = useReducedMotion()
  React.useEffect(() => {
    if (reduce) {
      setV(target)
      return
    }
    const c = animate(0, target, { duration: ms / 1000, ease: [0.16, 1, 0.3, 1], onUpdate: setV })
    return () => c.stop()
  }, [target, ms, reduce])
  return v
}

// ---------------------------------------------------------------- steps

function Pick({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { picked, target } = useWizard()
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const toggle = (id: string): void =>
    useWizard.setState({ picked: picked.includes(id) ? picked.filter((x) => x !== id) : zones.filter((z) => picked.includes(z.id) || z.id === id).map((z) => z.id) })
  const first = zones.find((z) => z.id === picked[0])

  return (
    <Frame
      left={
        <>
          <Heading>Teach Ghostkeys how your taps feel.</Heading>
          <Body>Every MacBook rings a little differently. Tap each zone a few times, then type normally for {NEG_SECONDS} seconds.</Body>
          <div className="mt-6 flex items-end justify-between pb-2">
            <span className="label-mono">Zones</span>
            <Button variant="text" size="sm" onClick={() => useWizard.setState({ picked: picked.length === zones.length ? [] : zones.map((z) => z.id) })}>
              {picked.length === zones.length ? 'Select none' : 'Select all'}
            </Button>
          </div>
          <ul className="shadow-[0_-1px_0_var(--hairline)]">
            {zones.map((z, i) => {
              const on = picked.includes(z.id)
              return (
                <li key={z.id}>
                  <button role="checkbox" aria-checked={on} onClick={() => toggle(z.id)} className="flex h-8 w-full items-center gap-3 text-left shadow-[0_1px_0_var(--hairline)] hover:bg-fill">
                    <Check checked={on} />
                    <ZoneIndex n={i + 1} />
                    <span className={cn('flex-1 text-[13px]', on ? 'text-ink' : 'text-ink-2')}>{z.name}</span>
                    <span className="text-[12px] text-ink-3">{SURFACE_LABEL[z.surface]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="mt-6 flex items-center justify-between">
            <span className="text-[13px] text-ink-2">Taps per zone</span>
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
          <p className="num mt-2 text-right text-[11px] tracking-[0.06em] text-ink-3">
            {picked.length} &times; {target} = {picked.length * target} TAPS
          </p>
          <div className="mt-6">
            <Button variant="primary" size="lg" disabled={!picked.length} onClick={beginCapture}>
              Start with {first ? first.name.toLowerCase() : 'a zone'}
            </Button>
          </div>
        </>
      }
      right={
        <LaptopMap
          family={family}
          zones={zones}
          mode="live"
          mutedIds={zones.filter((z) => !picked.includes(z.id)).map((z) => z.id)}
          onSelect={(id) => id && toggle(id)}
          selectedId={null}
        />
      }
    />
  )
}

function Capture({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { picked, index, counts, target } = useWizard()
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const zone = zones.find((z) => z.id === picked[index])
  const zoneN = zones.findIndex((z) => z.id === picked[index]) + 1
  const count = zone ? (counts[zone.id] ?? 0) : 0
  const reduce = useReducedMotion()

  return (
    <Frame
      left={
        <>
          <AnimatePresence mode="wait">
            <motion.div
              key={zone?.id}
              initial={{ opacity: 0, y: reduce ? 0 : 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: reduce ? 0 : -8 }}
              transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
            >
              <p className="label-mono">
                Zone {String(zoneN).padStart(2, '0')} &middot; {index + 1} of {picked.length}
              </p>
              <div className="mt-2">
                <Heading>Tap the {zone?.name.toLowerCase()}</Heading>
              </div>
              <Body>Use one fingertip. Vary the spot and strength a little, the way you would in real use.</Body>
            </motion.div>
          </AnimatePresence>
          <div className="mt-8">
            <Dial count={count} target={target}>
              <Roll value={String(count).padStart(2, '0')} className="numeral text-[44px]" />
              <span className="num mt-1 text-[11px] tracking-[0.06em] text-ink-3">OF {target}</span>
            </Dial>
          </div>
          <ul className="mt-8 flex flex-col">
            {picked.map((id, i) => {
              const z = zones.find((x) => x.id === id)
              const n = zones.findIndex((x) => x.id === id) + 1
              const c = counts[id] ?? 0
              const done = c >= target
              return (
                <li key={id} className={cn('flex h-7 items-center gap-2.5 text-[13px]', i === index ? 'text-ink' : i < index ? 'text-ink-2' : 'text-ink-3')}>
                  <ZoneIndex n={n} className={i === index ? 'text-ink' : undefined} />
                  <span className="flex-1 truncate">{z?.name ?? id}</span>
                  {done ? (
                    <span className="tag-mono w-[104px] text-right text-ink-2">Done</span>
                  ) : (
                    <>
                      <span className="relative h-0.5 w-16 overflow-hidden rounded-full bg-hairline">
                        <motion.span className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${Math.min(1, c / target) * 100}%` }} transition={{ type: 'spring', stiffness: 520, damping: 38 }} />
                      </span>
                      <span className="num w-10 text-right text-[11px]">
                        {c}/{target}
                      </span>
                    </>
                  )}
                </li>
              )
            })}
          </ul>
          <div className="mt-6 flex items-center gap-5">
            <Button variant="outline" onClick={advance}>
              {index + 1 < picked.length ? 'Skip this zone' : 'Continue'}
            </Button>
            <Button variant="text" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      }
      right={<LaptopMap family={family} zones={zones} mode="calibrate" focusId={zone?.id ?? null} listenTaps cloud tapFilter={zone?.id ?? null} />}
    />
  )
}

function Negatives(): React.JSX.Element {
  const { negLeft, negSeconds, heard } = useWizard()
  return (
    <Frame
      left={
        <>
          <Heading>Now just type, and use your trackpad.</Heading>
          <Body>Type anything and use the trackpad as usual. Don&rsquo;t tap the zones.</Body>
          <div className="mt-8">
            <Dial count={negSeconds - negLeft} target={negSeconds}>
              <Roll value={String(negLeft)} className="numeral text-[44px]" />
              <span className="num mt-1 text-[11px] tracking-[0.06em] text-ink-3">SECONDS</span>
            </Dial>
          </div>
          <dl className="mt-8 grid grid-cols-2 gap-6">
            <div>
              <dt className="label-mono">Typing heard</dt>
              <dd className="numeral mt-2 text-[28px]">{heard.typing}</dd>
            </div>
            <div>
              <dt className="label-mono">Trackpad heard</dt>
              <dd className="numeral mt-2 text-[28px]">{heard.trackpad}</dd>
            </div>
          </dl>
          <div className="mt-8">
            <Button variant="text" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      }
      right={
        <>
          <p className="label-mono pb-3">What Ghostkeys is learning to ignore</p>
          <Seismograph height={180} seconds={6} labelRejected />
          <textarea
            autoFocus
            aria-label="Type anything here"
            placeholder="Type anything here."
            className="mt-8 min-h-0 flex-1 bg-transparent text-[20px] leading-[1.5] text-ink caret-ink outline-none placeholder:text-ink-3"
          />
        </>
      }
    />
  )
}

function Training(): React.JSX.Element {
  return (
    <Frame
      left={
        <>
          <div className="flex gap-1.5" aria-hidden>
            {[0, 1, 2].map((i) => (
              <motion.span key={i} className="size-1.5 rounded-full bg-ink" animate={{ opacity: [0.2, 1, 0.2] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }} />
            ))}
          </div>
          <div className="mt-5">
            <Heading>Training on your taps</Heading>
          </div>
          <Body>This happens on your Mac. Nothing leaves it.</Body>
        </>
      }
      right={<Seismograph height={40} />}
    />
  )
}

function Results({ zones }: { zones: Zone[] }): React.JSX.Element {
  const { result } = useWizard()
  const navigate = useStore((s) => s.navigate)
  const overall = useCountUp(result ? result.overall * 100 : 0)
  if (!result) return <Training />
  const idx = (id: string): string => (id === 'none' ? 'IG' : String(zones.findIndex((z) => z.id === id) + 1).padStart(2, '0'))
  const name = (id: string): string => (id === 'none' ? 'Ignored' : (zones.find((z) => z.id === id)?.name ?? id))
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
            ? `${name(id)} is heard as ${name(other).toLowerCase()} ${pct(share)} of the time. Tap nearer its middle, move the two apart, or recalibrate it with 30 taps.`
            : `${name(id)} needs more samples. Recalibrate it with 30 taps.`
    }
  })
  const ready = entries.length - weak.length
  const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
  const summary =
    weak.length === 0
      ? 'Every zone is ready.'
      : `${words[ready] ?? ready} ${ready === 1 ? 'zone is' : 'zones are'} ready. ${weak.map(([id]) => name(id)).join(' and ')} ${weak.length === 1 ? 'needs' : 'need'} another pass.`

  return (
    <Frame
      left={
        <>
          <p className="label-mono">Overall accuracy</p>
          <p className="mt-3 flex items-baseline gap-1">
            <span className="numeral text-[120px]">{Math.round(overall)}</span>
            <span className="numeral text-[28px] text-ink-3">%</span>
          </p>
          <p className="mt-4 max-w-[36ch] text-[15px] leading-[1.55] text-ink-2">{summary}</p>
          <div className="mt-6 flex items-center gap-5">
            {weak.length > 0 ? (
              <>
                <Button variant="primary" onClick={() => useWizard.setState({ step: 'pick', picked: weak.map(([id]) => id), target: 30 })}>
                  Recalibrate {weak.length === 1 ? name(weak[0]![0]).toLowerCase() : 'weak zones'}
                </Button>
                <Button variant="text" onClick={() => navigate('live')}>
                  Done
                </Button>
              </>
            ) : (
              <Button variant="primary" onClick={() => navigate('live')}>
                Done
              </Button>
            )}
          </div>
          <p className="label-mono mt-10 pb-2">Per zone</p>
          <ul className="shadow-[0_-1px_0_var(--hairline)]">
            {entries.map(([id, a], i) => (
              <li key={id} className="flex h-8 items-center gap-3 shadow-[0_1px_0_var(--hairline)]">
                <span className="num w-5 text-[11px] text-ink-3">{idx(id)}</span>
                <span className="w-32 truncate text-[13px]">{name(id)}</span>
                <span className="relative h-0.5 flex-1">
                  <span className={cn('absolute inset-0', a < 0.9 ? 'border-t border-dashed border-hairline-strong' : 'bg-hairline')} />
                  <motion.span
                    className={cn('absolute inset-y-0 left-0', a < 0.9 ? 'bg-ink-2' : 'bg-ink')}
                    initial={{ width: 0 }}
                    animate={{ width: `${a * 100}%` }}
                    transition={{ duration: 0.9, delay: 0.03 * i, ease: [0.16, 1, 0.3, 1] }}
                  />
                </span>
                {a < 0.9 && <span className="tag-mono text-ink-2">Weak</span>}
                <span className="num w-9 text-right text-[12px] text-ink">{pct(a)}</span>
              </li>
            ))}
          </ul>
        </>
      }
      right={
        <div className="flex min-h-0 flex-col overflow-y-auto">
          <p className="label-mono pb-3">What each tap was taken for</p>
          <div className="overflow-x-auto">
            <table className="border-collapse text-[11px]">
              <thead>
                <tr>
                  <th />
                  <th />
                  {labels.map((l) => (
                    <th key={l} className="num h-7 w-9 font-normal text-ink-3">
                      {idx(l)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.confusion.map((row, i) => (
                  <tr key={labels[i]}>
                    <th scope="row" className="num w-7 pr-2 text-left font-normal text-ink-3">
                      {idx(labels[i]!)}
                    </th>
                    <th scope="row" className="max-w-32 truncate pr-4 text-left text-[12px] font-normal text-ink-2">
                      {name(labels[i]!)}
                    </th>
                    {row.map((v, j) => {
                      const share = v / rowTotals[i]!
                      return (
                        <td
                          key={j}
                          title={`${name(labels[i]!)} heard as ${name(labels[j]!)}: ${pct(share, 1)}`}
                          className="num h-9 w-9 border border-hairline text-center text-[10px]"
                          style={{
                            background: `color-mix(in srgb, var(--ink) ${Math.round(share * 18 * (i === j ? 1 : 3))}%, transparent)`,
                            color: share > 0 ? `color-mix(in srgb, var(--ink) ${Math.round(40 + share * 60)}%, transparent)` : undefined
                          }}
                        >
                          {v > 0 ? Math.round(share * 100) : ''}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[12px] text-ink-3">Rows: where you tapped. Columns: what Ghostkeys heard.</p>
          {advice.length > 0 && (
            <>
              <p className="label-mono pt-10 pb-2">Advice</p>
              <ol className="shadow-[0_-1px_0_var(--hairline)]">
                {advice.map((a, i) => (
                  <li key={a.id} className="flex gap-4 py-3 shadow-[0_1px_0_var(--hairline)]">
                    <span className="num pt-0.5 text-[11px] text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                    <p className="max-w-[60ch] text-[15px] leading-[1.55] text-ink">{a.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      }
    />
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
      <div className="flex min-h-0 flex-1 flex-col">
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
