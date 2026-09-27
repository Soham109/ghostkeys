import * as React from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import type { Zone } from '@shared/protocol'
import { REJECT_LABEL } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'
import { useWizard } from './Calibration'
import { Button } from '@/components/ui/button'
import { Segmented, ZoneIndex } from '@/components/ui/controls'
import { LaptopMap } from '@/components/laptop/LaptopMap'
import { Seismograph } from '@/components/Seismograph'

export type CalMode = 'calibrate' | 'training' | 'test'
export const usePractice = create<{ mode: CalMode }>()(() => ({ mode: 'calibrate' }))

function shuffle<T>(a: T[]): T[] {
  const b = a.slice()
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[b[i], b[j]] = [b[j]!, b[i]!]
  }
  return b
}

/** Prompts that never ask for the same zone twice in a row. */
function interleave(ids: string[], perZone: number): string[] {
  for (let tries = 0; tries < 20; tries++) {
    const out = shuffle(ids.flatMap((id) => Array(perZone).fill(id) as string[]))
    if (out.every((z, i) => i === 0 || z !== out[i - 1])) return out
  }
  return shuffle(ids.flatMap((id) => Array(perZone).fill(id) as string[]))
}

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

const H = ({ children }: { children: React.ReactNode }): React.JSX.Element => <h2 className="text-[20px] leading-[1.2] font-medium tracking-[-0.015em]">{children}</h2>
const P = ({ children }: { children: React.ReactNode }): React.JSX.Element => <p className="mt-2 max-w-[48ch] text-[15px] leading-[1.55] text-ink-2">{children}</p>

// ---------------------------------------------------------------- Tap test

type Outcome = { zone: string; kind: 'hit' | 'wrong' | 'miss'; heardAs?: string; reason?: string; taught?: boolean }

const MISS_WORDS: Record<string, string> = {
  typing: 'it came right after a key press, so it looked like typing',
  trackpad: 'the trackpad was in use at the same moment',
  motion: 'the laptop was moving',
  burst: 'several bumps came at once',
  low_confidence: 'Ghostkeys wasn’t sure which zone it was',
  paused: 'Ghostkeys is paused',
  none: 'nothing was felt; try a slightly firmer tap'
}

export const useTapTest = create<{
  phase: 'intro' | 'running' | 'done'
  prompts: string[]
  index: number
  results: Outcome[]
  waiting: boolean
}>()(() => ({ phase: 'intro', prompts: [], index: 0, results: [], waiting: false }))

export function TapTest({ zones }: { zones: Zone[] }): React.JSX.Element {
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const calibrated = useStore((s) => s.status?.calibrated)
  const { phase, prompts, index, results, waiting } = useTapTest()
  const active = zones.filter((z) => z.enabled !== false)
  const target = prompts[index]
  const name = (id?: string): string => zones.find((z) => z.id === id)?.name ?? id ?? ''
  const last = results[index] ?? null
  const hits = results.filter((r) => r.kind === 'hit').length

  const start = (): void =>
    useTapTest.setState({ phase: 'running', prompts: interleave(active.map((z) => z.id), Math.max(2, Math.round(16 / Math.max(1, active.length)))), index: 0, results: [], waiting: true })

  const next = React.useCallback((): void => {
    const st = useTapTest.getState()
    if (st.index + 1 >= st.prompts.length) useTapTest.setState({ phase: 'done', waiting: false })
    else useTapTest.setState({ index: st.index + 1, waiting: true })
  }, [])

  // Listen for the answer to the current prompt.
  React.useEffect(() => {
    if (phase !== 'running' || !waiting || !target) return
    const record = (o: Outcome): void => {
      const st = useTapTest.getState()
      const r = st.results.slice()
      r[st.index] = o
      useTapTest.setState({ results: r, waiting: false })
    }
    const offs = [
      client.on('tap', (t) => record(t.zone === target ? { zone: target, kind: 'hit' } : { zone: target, kind: 'wrong', heardAs: t.zone })),
      client.on('rejected', (r) => r.reason !== 'paused' && record({ zone: target, kind: 'miss', reason: r.reason, heardAs: r.zone ?? undefined }))
    ]
    const timer = setTimeout(() => record({ zone: target, kind: 'miss', reason: 'none' }), 5000)
    return () => {
      offs.forEach((o) => o())
      clearTimeout(timer)
    }
  }, [phase, waiting, target, index])

  // Hits move on by themselves; misses wait so there is time to teach.
  React.useEffect(() => {
    if (phase !== 'running' || waiting || !last || last.kind !== 'hit') return
    const t = setTimeout(next, 700)
    return () => clearTimeout(t)
  }, [phase, waiting, last, next])

  const teach = (): void => {
    if (!last) return
    client.send({ type: 'feedback_missed', zone: last.zone })
    const r = results.slice()
    r[index] = { ...last, taught: true }
    useTapTest.setState({ results: r })
    setTimeout(next, 500)
  }

  if (phase === 'intro' || !target)
    return (
      <Frame
        left={
          <>
            <H>Tap test</H>
            <P>
              Ghostkeys lights up a zone; you tap it. You&rsquo;ll see right away whether it landed, went to the wrong zone, or was missed, and why. Misses can be
              added as training in one click.
            </P>
            {!calibrated && <p className="mt-4 text-[13px] text-ink">Calibrate first, so Ghostkeys knows your zones.</p>}
            <div className="mt-8">
              <Button variant="primary" size="lg" disabled={!active.length} onClick={start}>
                Start the test
              </Button>
            </div>
            <p className="mt-3 text-[12px] text-ink-3">About 16 taps across {active.length} zones. Nothing runs while you test.</p>
          </>
        }
        right={<LaptopMap family={family} zones={zones} mode="static" mutedIds={zones.filter((z) => z.enabled === false).map((z) => z.id)} />}
      />
    )

  if (phase === 'done') {
    const per = active.map((z) => {
      const rs = results.filter((r) => r.zone === z.id)
      return { z, n: rs.length, hit: rs.filter((r) => r.kind === 'hit').length }
    })
    const weak = per.filter((p) => p.n && p.hit / p.n < 0.75)
    return (
      <Frame
        left={
          <>
            <p className="label-mono">Score</p>
            <p className="mt-3 flex items-baseline gap-2">
              <span className="numeral text-[88px]">{hits}</span>
              <span className="numeral text-[28px] text-ink-3">of {results.length}</span>
            </p>
            <p className="mt-3 text-[15px] leading-[1.55] text-ink-2">
              {hits === results.length
                ? 'Every tap landed. Ghostkeys is ready.'
                : weak.length
                  ? `${weak.map((w) => w.z.name).join(' and ')} ${weak.length === 1 ? 'needs' : 'need'} more practice.`
                  : 'Most taps landed. A few more calibration taps will make it even steadier.'}
            </p>
            <div className="mt-6 flex items-center gap-5">
              {weak.length > 0 && (
                <Button
                  variant="primary"
                  onClick={() => {
                    usePractice.setState({ mode: 'calibrate' })
                    useWizard.setState({ step: 'pick', picked: weak.map((w) => w.z.id), target: 30 })
                  }}
                >
                  Recalibrate {weak.length === 1 ? weak[0]!.z.name.toLowerCase() : 'these zones'}
                </Button>
              )}
              <Button variant={weak.length ? 'text' : 'primary'} onClick={start}>
                Test again
              </Button>
            </div>
          </>
        }
        right={
          <ul className="max-w-[520px] shadow-[0_-1px_0_var(--hairline)]">
            {per.map(({ z, n, hit }) => (
              <li key={z.id} className="flex h-9 items-center gap-3 shadow-[0_1px_0_var(--hairline)]">
                <ZoneIndex n={zones.indexOf(z) + 1} />
                <span className="w-36 truncate text-[13px]">{z.name}</span>
                <span className="relative h-0.5 flex-1 bg-hairline">
                  <motion.span className={cn('absolute inset-y-0 left-0', n && hit / n < 0.75 ? 'bg-ink-2' : 'bg-ink')} initial={{ width: 0 }} animate={{ width: n ? `${(hit / n) * 100}%` : 0 }} transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }} />
                </span>
                <span className="num w-12 text-right text-[12px] text-ink">{n ? `${hit}/${n}` : '—'}</span>
              </li>
            ))}
          </ul>
        }
      />
    )
  }

  return (
    <Frame
      left={
        <>
          <p className="label-mono">
            {index + 1} of {prompts.length}
          </p>
          <AnimatePresence mode="wait">
            <motion.div key={index} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}>
              <div className="mt-2">
                <H>Tap the {name(target).toLowerCase()}</H>
              </div>
            </motion.div>
          </AnimatePresence>
          <div className="mt-6 min-h-[120px]">
            {waiting ? (
              <p className="text-[13px] text-ink-3">Waiting for your tap.</p>
            ) : last?.kind === 'hit' ? (
              <p className="text-[20px] font-medium text-ink">Landed.</p>
            ) : last?.kind === 'wrong' ? (
              <>
                <p className="text-[15px] text-ink">Heard as the {name(last.heardAs).toLowerCase()}.</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">The two zones feel alike. Tap nearer the middle of the {name(target).toLowerCase()}, or teach it this tap.</p>
              </>
            ) : last ? (
              <>
                <p className="text-[15px] text-ink">Missed.</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  Ghostkeys ignored it because {MISS_WORDS[last.reason ?? 'none'] ?? REJECT_LABEL[last.reason as keyof typeof REJECT_LABEL]}.
                </p>
              </>
            ) : null}
            {last && last.kind !== 'hit' && (
              <div className="mt-4 flex items-center gap-4">
                <Button variant="primary" size="sm" disabled={last.taught} onClick={teach}>
                  {last.taught ? 'Added as training' : 'Teach it this tap'}
                </Button>
                <Button variant="text" size="sm" onClick={next}>
                  Next
                </Button>
              </div>
            )}
          </div>
          <p className="mt-6 num text-[11px] tracking-[0.06em] text-ink-3">
            {hits} OF {results.filter(Boolean).length} LANDED
          </p>
          <div className="mt-2 flex gap-1" aria-hidden>
            {prompts.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full',
                  !results[i] ? (i === index ? 'bg-ink-3' : 'bg-hairline-strong') : results[i]!.kind === 'hit' ? 'bg-ink' : 'bg-transparent shadow-[inset_0_0_0_1px_var(--ink-3)]'
                )}
              />
            ))}
          </div>
          <div className="mt-auto pt-6">
            <Button variant="text" onClick={() => useTapTest.setState({ phase: 'done', waiting: false })}>
              Finish early
            </Button>
          </div>
        </>
      }
      right={
        <>
          <div className="min-h-0 flex-1">
            <LaptopMap family={family} zones={zones} mode="calibrate" focusId={target} listenTaps />
          </div>
          <Seismograph height={40} />
        </>
      }
    />
  )
}

// ---------------------------------------------------------------- Training session (draft, to be aligned with docs/review/DETECTION_AUDIT.md)

interface Round {
  id: 'desk' | 'lap' | 'typing'
  title: string
  copy: string
  perZone?: number
  seconds?: number
}

export const ROUNDS: Round[] = [
  { id: 'desk', title: 'On a desk', copy: 'Put the laptop on a table. When a zone lights up, give it one light tap. Zones come in a random order.', perZone: 6 },
  { id: 'lap', title: 'On your lap', copy: 'Now rest the laptop on your lap and do the same. Taps feel different here, so this round matters.', perZone: 4 },
  { id: 'typing', title: 'Typing', copy: 'Type and use the trackpad as you normally would. Ghostkeys learns what to ignore.', seconds: 30 }
]

export const useTraining = create<{
  phase: 'intro' | 'round-intro' | 'running' | 'finishing'
  round: number
  prompts: string[]
  index: number
  counts: Record<string, number>
  secondsLeft: number
}>()(() => ({ phase: 'intro', round: 0, prompts: [], index: 0, counts: {}, secondsLeft: 0 }))

export function TrainingSession({ zones }: { zones: Zone[] }): React.JSX.Element {
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const { phase, round, prompts, index, secondsLeft } = useTraining()
  const active = zones.filter((z) => z.enabled !== false)
  const ids = active.map((z) => z.id)
  const r = ROUNDS[round]!
  const tapRounds = ROUNDS.filter((x) => x.perZone)
  const totalTaps = tapRounds.reduce((a, x) => a + (x.perZone ?? 0) * ids.length, 0)
  const doneTaps = ROUNDS.slice(0, round).reduce((a, x) => a + (x.perZone ?? 0) * ids.length, 0) + (r.perZone ? index : 0)
  const progress = phase === 'intro' ? 0 : r.seconds ? (tapRounds.length + (1 - secondsLeft / r.seconds)) / ROUNDS.length : doneTaps / totalTaps * (tapRounds.length / ROUNDS.length)
  const target = prompts[index]
  const name = (id?: string): string => zones.find((z) => z.id === id)?.name ?? id ?? ''

  const begin = (): void => {
    client.send({ type: 'calibration_start', zones: ids, target: tapRounds.reduce((a, x) => a + (x.perZone ?? 0), 0) })
    useTraining.setState({ phase: 'round-intro', round: 0, counts: {}, index: 0 })
  }
  const startRound = (): void => {
    const rr = ROUNDS[useTraining.getState().round]!
    if (rr.seconds) {
      client.send({ type: 'calibration_negatives', seconds: rr.seconds })
      useTraining.setState({ phase: 'running', secondsLeft: rr.seconds })
    } else {
      const p = interleave(ids, rr.perZone!)
      client.send({ type: 'calibration_zone', zone: p[0]! })
      useTraining.setState({ phase: 'running', prompts: p, index: 0 })
    }
  }
  const cancel = (): void => {
    client.send({ type: 'calibration_cancel' })
    useTraining.setState({ phase: 'intro' })
  }

  React.useEffect(() => {
    const off = client.on('calibration', (m) => {
      const st = useTraining.getState()
      if (st.phase !== 'running') return
      if (m.phase === 'capturing') {
        const before = st.counts[m.zone] ?? 0
        const counts = { ...st.counts, [m.zone]: m.count }
        useTraining.setState({ counts })
        if (m.zone === st.prompts[st.index] && m.count > before) {
          const ni = st.index + 1
          if (ni >= st.prompts.length) {
            setTimeout(() => useTraining.setState({ phase: 'round-intro', round: st.round + 1, index: 0, prompts: [] }), 400)
          } else {
            useTraining.setState({ index: ni })
            setTimeout(() => client.send({ type: 'calibration_zone', zone: st.prompts[ni]! }), 250)
          }
        }
      } else if (m.phase === 'negatives') {
        useTraining.setState({ secondsLeft: m.secondsLeft })
        if (m.secondsLeft <= 0) {
          client.send({ type: 'calibration_finish' })
          useTraining.setState({ phase: 'finishing' })
        }
      } else if (m.phase === 'done') {
        useTraining.setState({ phase: 'intro' })
        usePractice.setState({ mode: 'calibrate' })
      }
    })
    return off
  }, [])

  const bar = (
    <div className="mt-8">
      <div className="flex justify-between pb-2">
        {ROUNDS.map((x, i) => (
          <span key={x.id} className={cn('text-[12px]', i === round && phase !== 'intro' ? 'text-ink' : i < round ? 'text-ink-2' : 'text-ink-3')}>
            {String(i + 1).padStart(2, '0')} {x.title}
          </span>
        ))}
      </div>
      <div className="relative h-0.5 bg-hairline">
        <motion.div className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${Math.min(1, progress) * 100}%` }} transition={{ type: 'spring', stiffness: 300, damping: 40 }} />
      </div>
    </div>
  )

  if (phase === 'intro')
    return (
      <Frame
        left={
          <>
            <H>Training session</H>
            <P>
              A longer, more thorough calibration: zones light up in a random order, first with the laptop on a desk, then on your lap, then a short typing round.
              It makes detection steadier in real use.
            </P>
            <ol className="mt-6 shadow-[0_-1px_0_var(--hairline)]">
              {ROUNDS.map((x, i) => (
                <li key={x.id} className="flex gap-4 py-3 shadow-[0_1px_0_var(--hairline)]">
                  <span className="num pt-0.5 text-[11px] text-ink-3">{String(i + 1).padStart(2, '0')}</span>
                  <div>
                    <p className="text-[13px] text-ink">{x.title}</p>
                    <p className="text-[12px] text-ink-3">{x.perZone ? `${x.perZone * ids.length} taps` : `${x.seconds} seconds`}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-8">
              <Button variant="primary" size="lg" disabled={!ids.length} onClick={begin}>
                Start training
              </Button>
            </div>
          </>
        }
        right={<LaptopMap family={family} zones={zones} mode="static" mutedIds={zones.filter((z) => z.enabled === false).map((z) => z.id)} />}
      />
    )

  if (phase === 'round-intro')
    return (
      <Frame
        left={
          <>
            <p className="label-mono">
              Round {round + 1} of {ROUNDS.length}
            </p>
            <div className="mt-2">
              <H>{r.title}</H>
            </div>
            <P>{r.copy}</P>
            <div className="mt-8 flex items-center gap-5">
              <Button variant="primary" size="lg" onClick={startRound}>
                {round === 0 ? 'Ready' : 'Next round'}
              </Button>
              <Button variant="text" onClick={cancel}>
                Cancel
              </Button>
            </div>
            {bar}
          </>
        }
        right={<LaptopMap family={family} zones={zones} mode="static" />}
      />
    )

  if (phase === 'finishing')
    return (
      <Frame
        left={
          <>
            <H>Training on your taps</H>
            <P>This happens on your Mac. Nothing leaves it.</P>
            {bar}
          </>
        }
        right={<Seismograph height={40} />}
      />
    )

  return (
    <Frame
      left={
        <>
          <p className="label-mono">
            Round {round + 1}: {r.title}
          </p>
          {r.seconds ? (
            <>
              <div className="mt-2">
                <H>Type and use the trackpad as you normally would</H>
              </div>
              <p className="numeral mt-6 text-[64px]">{secondsLeft}</p>
              <p className="num text-[11px] tracking-[0.06em] text-ink-3">SECONDS LEFT</p>
            </>
          ) : (
            <AnimatePresence mode="wait">
              <motion.div key={index} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <div className="mt-2">
                  <H>Tap the {name(target).toLowerCase()}</H>
                </div>
                <p className="num mt-3 text-[11px] tracking-[0.06em] text-ink-3">
                  {index + 1} OF {prompts.length} IN THIS ROUND
                </p>
              </motion.div>
            </AnimatePresence>
          )}
          {bar}
          <div className="mt-auto pt-6">
            <Button variant="text" onClick={cancel}>
              Cancel
            </Button>
          </div>
        </>
      }
      right={
        r.seconds ? (
          <>
            <Seismograph height={160} seconds={6} labelRejected />
            <textarea aria-label="Type anything here" placeholder="Type anything here." className="mt-8 min-h-0 flex-1 bg-transparent text-[20px] leading-[1.5] text-ink outline-none placeholder:text-ink-3" />
          </>
        ) : (
          <LaptopMap family={family} zones={zones} mode="calibrate" focusId={target ?? null} listenTaps tapFilter={target ?? null} />
        )
      }
    />
  )
}

export function ModeSwitch(): React.JSX.Element {
  const mode = usePractice((s) => s.mode)
  return (
    <Segmented<CalMode>
      aria-label="Mode"
      value={mode}
      onValueChange={(m) => usePractice.setState({ mode: m })}
      options={[
        { value: 'calibrate', label: 'Calibrate' },
        { value: 'training', label: 'Training session' },
        { value: 'test', label: 'Tap test' }
      ]}
    />
  )
}

