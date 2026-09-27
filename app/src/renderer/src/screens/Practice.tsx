import * as React from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion } from 'motion/react'
import type { NegativePhase, Posture, Zone } from '@shared/protocol'
import { REJECT_LABEL } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn, nameList } from '@/lib/utils'
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
  const known = useStore((s) => s.status?.zones)
  const { phase, prompts, index, results, waiting } = useTapTest()
  // Only zones Ghostkeys has been taught: asking for an uncalibrated zone is a guaranteed miss.
  const active = zones.filter((z) => z.enabled !== false && (!known?.length || known.includes(z.id)))
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
            <p className="mt-3 text-[12px] text-ink-3">About 16 taps across {active.length} zones. Gestures you have set up still run while you test.</p>
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
                  ? `${nameList(weak.map((w) => w.z.name))} ${weak.length === 1 ? 'needs' : 'need'} more practice.`
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
          <div className="mt-6 min-h-[120px]" aria-live="polite">
            {waiting ? (
              <p className="text-[13px] text-ink-3">Waiting for your tap.</p>
            ) : last?.kind === 'hit' ? (
              <p className="text-[20px] font-medium text-ink">Landed.</p>
            ) : last?.kind === 'wrong' ? (
              <>
                <p className="text-[15px] text-ink">Heard as the {name(last.heardAs).toLowerCase()}.</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">The two zones feel alike. Tap nearer the middle of the {name(target).toLowerCase()}. If this keeps happening, recalibrate it at the end.</p>
              </>
            ) : last ? (
              <>
                <p className="text-[15px] text-ink">Missed.</p>
                <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
                  {(last.reason ?? 'none') === 'none'
                    ? 'Ghostkeys didn’t feel a tap. Try a slightly firmer tap.'
                    : `Ghostkeys ignored it because ${MISS_WORDS[last.reason!] ?? REJECT_LABEL[last.reason as keyof typeof REJECT_LABEL]}.`}
                </p>
              </>
            ) : null}
            {last && last.kind !== 'hit' && (
              <div className="mt-4 flex items-center gap-4">
                {last.kind === 'miss' && (
                  <Button variant="primary" size="sm" disabled={last.taught} onClick={teach}>
                    {last.taught ? 'Added as training' : 'Teach it this tap'}
                  </Button>
                )}
                <Button variant={last.kind === 'miss' ? 'text' : 'primary'} size="sm" onClick={next}>
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

// ---------------------------------------------------------------- Training session (docs/review/DETECTION_AUDIT.md, 6.6)

type Stage = 'posture' | 'singles' | 'doubles' | 'negatives' | 'finishing'
interface Prompt {
  zone: string
  strength: 'soft' | 'firm'
}
const NEGATIVES: { phase: NegativePhase; seconds: number; title: string; copy: string }[] = [
  { phase: 'typing', seconds: 30, title: 'Type this sentence, or anything', copy: 'The quick brown fox jumps over the lazy dog, then keeps typing.' },
  { phase: 'trackpad', seconds: 20, title: 'Use the trackpad', copy: 'Move, click, drag, scroll and swipe, the way you normally do.' },
  { phase: 'palms', seconds: 10, title: 'Rest your palms, lift them, rest again', copy: 'Put your hands down on the palm rests as if to type, then lift them. Repeat.' },
  { phase: 'drink', seconds: 10, title: 'Pick up a drink and put it down', copy: 'Or any object near the laptop. These bumps should never count as taps.' }
]
const SINGLES_PER_ZONE = 12
const DOUBLES_PER_ZONE = 8

export const useTraining = create<{
  phase: 'intro' | 'running'
  stage: Stage
  posture: Posture
  done: Posture[]
  prompts: Prompt[]
  index: number
  showing: boolean
  doubleZones: string[]
  doubleIndex: number
  doubleCount: number
  negIndex: number
  secondsLeft: number
  base: Record<string, number>
  counts: Record<string, number>
  useDoubles: boolean
}>()(() => ({
  phase: 'intro',
  stage: 'posture',
  posture: 'desk',
  done: [],
  prompts: [],
  index: 0,
  showing: false,
  doubleZones: [],
  doubleIndex: 0,
  doubleCount: 0,
  negIndex: 0,
  secondsLeft: 0,
  base: {},
  counts: {},
  useDoubles: true
}))

const T = useTraining

function gap(): number {
  return 1500 + Math.random() * 1500
}

function showPrompt(i: number): void {
  const st = T.getState()
  const p = st.prompts[i]
  if (!p) return
  T.setState({ index: i, showing: false, base: { ...st.counts } })
  setTimeout(() => {
    if (T.getState().stage !== 'singles' || T.getState().index !== i) return
    client.send({ type: 'calibration_zone', zone: p.zone, strength: p.strength })
    T.setState({ showing: true })
  }, gap())
}

function startDoubles(): void {
  const st = T.getState()
  if (!st.doubleZones.length) return startNegatives(0)
  const zone = st.doubleZones[0]!
  T.setState({ stage: 'doubles', doubleIndex: 0, doubleCount: 0, base: { ...st.counts } })
  sendDoubles(zone)
}

function sendDoubles(zone: string): void {
  const st = T.getState()
  if (st.useDoubles) client.send({ type: 'calibration_doubles', zone, count: DOUBLES_PER_ZONE })
  else client.send({ type: 'calibration_zone', zone })
}

function nextDoubleZone(): void {
  const st = T.getState()
  const ni = st.doubleIndex + 1
  if (ni >= st.doubleZones.length) return startNegatives(0)
  T.setState({ doubleIndex: ni, doubleCount: 0, base: { ...st.counts } })
  sendDoubles(st.doubleZones[ni]!)
}

function startNegatives(i: number): void {
  const n = NEGATIVES[i]
  if (!n) {
    // One posture per calibration: the daemon tags every sample with the posture sent in calibration_start.
    client.send({ type: 'calibration_finish' })
    T.setState({ stage: 'finishing' })
    return
  }
  client.send({ type: 'calibration_negatives', seconds: n.seconds })
  T.setState({ stage: 'negatives', negIndex: i, secondsLeft: n.seconds })
}

export function TrainingSession({ zones }: { zones: Zone[] }): React.JSX.Element {
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const config = useStore((s) => s.config)
  const st = useTraining()
  const calibratedIds = useStore((s) => s.status?.zones ?? [])
  // Only zones the user has bound or already calibrated; all switched-on zones only when there are none yet.
  const on = zones.filter((z) => z.enabled !== false)
  const used = on.filter((z) => calibratedIds.includes(z.id) || (config?.bindings ?? []).some((b) => b.enabled && (b.zone === z.id || b.zones?.includes(z.id))))
  const active = used.length ? used : on
  const ids = active.map((z) => z.id)
  const name = (id?: string): string => zones.find((z) => z.id === id)?.name ?? id ?? ''
  const multi = [
    ...new Set(
      (config?.bindings ?? []).filter((b) => b.enabled && ['double', 'triple', 'rhythm'].includes(b.gesture) && b.zone && ids.includes(b.zone)).map((b) => b.zone!)
    )
  ]

  const beginPosture = (p: Posture): void => {
    client.send({ type: 'calibration_start', zones: ids, target: 120, posture: p })
    const zoneOrder = interleave(ids, SINGLES_PER_ZONE)
    const prompts = zoneOrder.map((zone, i) => ({ zone, strength: (i % 2 === 0) !== Math.random() < 0.5 ? 'soft' : 'firm' }) as Prompt)
    T.setState({ phase: 'running', stage: 'singles', posture: p, prompts, doubleZones: shuffle(multi) })
    showPrompt(0)
  }
  const cancel = (): void => {
    client.send({ type: 'calibration_cancel' })
    T.setState({ phase: 'intro', stage: 'posture', done: [] })
  }

  React.useEffect(() => {
    const offs = [
      client.on('calibration', (m) => {
        const cur = T.getState()
        if (cur.phase !== 'running') return
        if (m.phase === 'capturing') {
          const counts = { ...cur.counts, [m.zone]: m.count }
          T.setState({ counts })
          const gained = m.count - (cur.base[m.zone] ?? 0)
          if (cur.stage === 'singles' && cur.showing && m.zone === cur.prompts[cur.index]?.zone && gained >= 1) {
            T.setState({ showing: false })
            if (cur.index + 1 >= cur.prompts.length) setTimeout(startDoubles, 400)
            else showPrompt(cur.index + 1)
          } else if (cur.stage === 'doubles' && m.zone === cur.doubleZones[cur.doubleIndex]) {
            const pairs = Math.floor(gained / 2)
            T.setState({ doubleCount: Math.min(DOUBLES_PER_ZONE, pairs) })
            if (pairs >= DOUBLES_PER_ZONE) setTimeout(nextDoubleZone, 400)
          }
        } else if (m.phase === 'doubles' && cur.stage === 'doubles' && m.zone === cur.doubleZones[cur.doubleIndex]) {
          T.setState({ doubleCount: Math.min(DOUBLES_PER_ZONE, m.count) })
        } else if (m.phase === 'doubles_done' && cur.stage === 'doubles' && m.zone === cur.doubleZones[cur.doubleIndex]) {
          T.setState({ doubleCount: DOUBLES_PER_ZONE })
          setTimeout(nextDoubleZone, 400)
        } else if (m.phase === 'negatives' && cur.stage === 'negatives') {
          T.setState({ secondsLeft: m.secondsLeft })
          if (m.secondsLeft <= 0) setTimeout(() => startNegatives(cur.negIndex + 1), 300)
        } else if (m.phase === 'done') {
          T.setState({ phase: 'intro', stage: 'posture', done: [] })
          usePractice.setState({ mode: 'calibrate' })
        }
      }),
      client.on('error', (e) => {
        // Older helpers don't know calibration_doubles: fall back to plain labelled taps.
        if (/calibration_doubles/.test(e.message) && T.getState().useDoubles) {
          T.setState({ useDoubles: false })
          const cur = T.getState()
          if (cur.stage === 'doubles') sendDoubles(cur.doubleZones[cur.doubleIndex]!)
        }
      })
    ]
    return () => offs.forEach((o) => o())
  }, [])

  // overall progress across both parts of this posture
  const singles = st.prompts.length || ids.length * SINGLES_PER_ZONE
  const doublesTotal = multi.length * DOUBLES_PER_ZONE
  const negTotal = NEGATIVES.reduce((a, n) => a + n.seconds, 0)
  const units = singles + doublesTotal + negTotal / 3
  const doneUnits =
    st.stage === 'singles'
      ? st.index
      : st.stage === 'doubles'
        ? singles + st.doubleIndex * DOUBLES_PER_ZONE + st.doubleCount
        : st.stage === 'negatives'
          ? singles + doublesTotal + (NEGATIVES.slice(0, st.negIndex).reduce((a, n) => a + n.seconds, 0) + (NEGATIVES[st.negIndex]!.seconds - st.secondsLeft)) / 3
          : units
  const stages: { id: Stage; label: string }[] = [
    { id: 'singles', label: 'Taps' },
    { id: 'doubles', label: 'Double taps' },
    { id: 'negatives', label: 'Everyday use' }
  ]
  const at = stages.findIndex((x) => x.id === st.stage)
  const bar = (
    <div className="mt-8">
      <div className="flex justify-between pb-2">
        {stages.map((x, i) => (
          <span key={x.id} className={cn('text-[12px]', i === at ? 'text-ink' : i < at || at < 0 ? 'text-ink-2' : 'text-ink-3')}>
            {String(i + 1).padStart(2, '0')} {x.label}
          </span>
        ))}
      </div>
      <div className="relative h-0.5 bg-hairline">
        <motion.div className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${Math.min(1, doneUnits / units) * 100}%` }} transition={{ type: 'spring', stiffness: 300, damping: 40 }} />
      </div>
      <p className="num mt-2 text-[11px] tracking-[0.06em] text-ink-3">{st.posture === 'desk' ? 'ON A DESK' : 'ON YOUR LAP'}</p>
    </div>
  )
  const cancelBtn = (
    <div className="mt-auto pt-6">
      <Button variant="text" onClick={cancel}>
        Cancel
      </Button>
    </div>
  )

  if (st.phase === 'intro' || st.stage === 'posture')
    return (
      <Frame
        left={
          <>
            <H>Training session</H>
            <P>
              A thorough calibration in the position you really use. Zones light up in a random order, some softly and some firmly, then double taps in your own
              rhythm, then a few everyday movements Ghostkeys should ignore.
            </P>
            <p className="mt-6 text-[13px] text-ink">Where is your Mac right now?</p>
            <div className="mt-3 flex gap-3">
              <Button variant="primary" size="lg" disabled={!ids.length} onClick={() => beginPosture('desk')}>
                On a desk
              </Button>
              <Button variant="outline" size="lg" disabled={!ids.length} onClick={() => beginPosture('lap')}>
                On my lap
              </Button>
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
              {ids.length} zones, {ids.length * SINGLES_PER_ZONE} taps
              {multi.length ? `, ${multi.length * DOUBLES_PER_ZONE} double taps on ${nameList(multi.map((z) => name(z).toLowerCase()))}` : ''}, then 70 seconds of everyday use.
            </p>
          </>
        }
        right={<LaptopMap family={family} zones={zones} mode="static" mutedIds={zones.filter((z) => z.enabled === false).map((z) => z.id)} />}
      />
    )

  if (st.stage === 'finishing')
    return (
      <Frame
        left={
          <>
            <H>Learning your taps</H>
            <P>This happens on your Mac. Nothing leaves it.</P>
          </>
        }
        right={<Seismograph height={40} />}
      />
    )

  if (st.stage === 'negatives') {
    const n = NEGATIVES[st.negIndex]!
    return (
      <Frame
        left={
          <>
            <p className="label-mono">
              {st.negIndex + 1} of {NEGATIVES.length}
            </p>
            <div className="mt-2">
              <H>{n.title}</H>
            </div>
            <P>{n.copy}</P>
            <p className="numeral mt-6 text-[56px]">{st.secondsLeft}</p>
            <p className="num text-[11px] tracking-[0.06em] text-ink-3">SECONDS LEFT</p>
            {bar}
            {cancelBtn}
          </>
        }
        right={
          <>
            <p className="label-mono pb-3">What Ghostkeys is learning to ignore</p>
            <Seismograph height={160} seconds={6} labelRejected />
            {n.phase === 'typing' && (
              <textarea autoFocus aria-label="Type here" placeholder={n.copy} className="mt-8 min-h-0 flex-1 bg-transparent text-[20px] leading-[1.5] text-ink outline-none placeholder:text-ink-3" />
            )}
          </>
        }
      />
    )
  }

  if (st.stage === 'doubles') {
    const zone = st.doubleZones[st.doubleIndex]
    return (
      <Frame
        left={
          <>
            <p className="label-mono">
              Zone {st.doubleIndex + 1} of {st.doubleZones.length}
            </p>
            <div className="mt-2">
              <H>Double-tap the {name(zone).toLowerCase()} in your own rhythm</H>
            </div>
            <P>The way you would to trigger it. Pause a moment between each double tap.</P>
            <div className="mt-6 flex gap-1.5" aria-hidden>
              {Array.from({ length: DOUBLES_PER_ZONE }, (_, i) => (
                <span key={i} className={cn('size-2 rounded-full', i < st.doubleCount ? 'bg-ink' : 'bg-hairline-strong')} />
              ))}
            </div>
            <p className="num mt-2 text-[11px] text-ink-3">
              {st.doubleCount} OF {DOUBLES_PER_ZONE}
            </p>
            <div className="mt-4">
              <Button variant="text" size="sm" onClick={nextDoubleZone}>
                Skip this zone
              </Button>
            </div>
            {bar}
            {cancelBtn}
          </>
        }
        right={<LaptopMap family={family} zones={zones} mode="calibrate" focusId={zone ?? null} listenTaps tapFilter={zone ?? null} />}
      />
    )
  }

  const p = st.prompts[st.index]
  return (
    <Frame
      left={
        <>
          <p className="label-mono">
            {st.index + 1} of {st.prompts.length}
          </p>
          <AnimatePresence mode="wait">
            <motion.div key={`${st.index}-${st.showing}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              <div className="mt-2">
                <H>{st.showing && p ? `Tap the ${name(p.zone).toLowerCase()} ${p.strength === 'soft' ? 'softly' : 'firmly'}` : 'Get ready…'}</H>
              </div>
              <P>{st.showing ? (p?.strength === 'soft' ? 'A soft, relaxed tap.' : 'A clear, firm tap.') : 'The next zone lights up in a moment.'}</P>
            </motion.div>
          </AnimatePresence>
          {bar}
          {cancelBtn}
        </>
      }
      right={<LaptopMap family={family} zones={zones} mode="calibrate" focusId={st.showing && p ? p.zone : null} listenTaps tapFilter={p?.zone ?? null} />}
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

