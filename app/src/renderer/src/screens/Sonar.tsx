import * as React from 'react'
import { create } from 'zustand'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { GestureKind, SonarDebugMsg, SonarSide } from '@shared/protocol'
import { GESTURE_LABEL } from '@shared/protocol'
import { toSvg, layoutFor } from '@/components/laptop/geometry'
import { Chassis } from '@/components/laptop/LaptopMap'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/controls'
import { SessionNote } from '@/components/SessionNeed'

type Side = 'left' | 'right'

/** The latest sonar_debug frame and the last sonar gesture, shared by the full view and the compact panel. */
export const useSonarLive = create<{ frame: SonarDebugMsg | null; gesture: { name: string; side?: Side; at: number } | null; hover: Record<Side, number | null> }>()(() => ({
  frame: null,
  gesture: null,
  hover: { left: null, right: null }
}))

export function useSonarFeed(): void {
  React.useEffect(() => {
    const unsub = client.subscribe(['debug', 'air'])
    const offs = [
      client.on('sonar_debug', (m) => useSonarLive.setState({ frame: m })),
      client.on('air', (m) => {
        if (m.gesture !== 'hover_level') return
        const side = (m.side ?? 'left') as Side
        useSonarLive.setState((s) => ({ hover: { ...s.hover, [side]: m.phase === 'ended' ? null : (m.value ?? 0) } }))
      }),
      client.on('gesture', (g) => {
        const sonar = ['push', 'pull', 'sweep_left', 'sweep_right', 'hover_level'].includes(g.gesture) || g.gesture.startsWith('finger_slide')
        if (sonar) useSonarLive.setState({ gesture: { name: g.gesture, side: (g as { side?: Side }).side, at: Date.now() } })
      })
    ]
    return () => {
      unsub()
      offs.forEach((o) => o())
    }
  }, [])
}

/** Plain words for how well one speaker's tone is heard. */
export function quality(s: SonarSide | undefined): { word: string; level: number } {
  if (!s || !s.pilotPresent) return { word: 'Not hearing the tones', level: 0 }
  if (s.snrDb >= 45) return { word: 'Strong', level: 1 }
  if (s.snrDb >= 32) return { word: 'Good', level: 0.7 }
  return { word: 'Weak: move closer', level: 0.4 }
}

export function gateChips(f: SonarDebugMsg | null): string[] {
  if (!f) return ['Waiting for the tones']
  const g = f.gates
  const out: string[] = []
  if (!g.tonesPlaying) out.push('Waiting for the tones')
  else if (!g.warmedUp) out.push('Warming up')
  if (g.suppressedByDaemon) out.push('Paused while typing or moving')
  if (g.interference) out.push('Noise too loud')
  if (g.toneProblem) out.push(g.toneProblem)
  if (g.hover) out.push('Hand hovering')
  if (g.slide) out.push('Finger sliding')
  if (!out.length) out.push('Listening')
  return out
}

/** Map a dBc sideband level (-70 quiet .. -10 loud) to 0..1. */
const side01 = (dbc: number): number => Math.max(0, Math.min(1, (dbc + 70) / 60))

function Speaker({ s, side, x, y, hover, lit, reduce }: { s?: SonarSide; side: Side; x: number; y: number; hover: number | null; lit: boolean; reduce: boolean }): React.JSX.Element {
  const q = quality(s)
  const t = Date.now() / 1000
  const move = s ? Math.max(0, Math.min(1, Math.abs(s.pathDeltaMm) / 40)) : 0
  const low = s ? side01(s.sidebandLowDbc) : 0
  const high = s ? side01(s.sidebandHighDbc) : 0
  // hand height above this speaker: from the tracker's total path (mm), or the hover level when a hover is on
  const h = hover !== null ? (hover + 1) / 2 : s ? Math.max(0, Math.min(1, 0.5 + s.pathTotalMm / 300)) : 0.5
  return (
    <g>
      {/* field arcs */}
      {q.level > 0 &&
        [0, 1, 2, 3].map((i) => {
          const k = reduce ? i / 4 : ((t * 0.7 + i / 4) % 1 + 1) % 1
          const r = 20 + k * 150
          return <circle key={i} cx={x} cy={y} r={r} fill="none" stroke="var(--ink-3)" strokeOpacity={(1 - k) * 0.45 * q.level * (0.6 + move * 0.6)} vectorEffect="non-scaling-stroke" />
        })}
      <circle cx={x} cy={y} r={7} fill={lit ? 'var(--signal)' : q.level ? 'var(--ink)' : 'none'} stroke="var(--ink-2)" vectorEffect="non-scaling-stroke" />
      {/* hand height above the speaker */}
      <g transform={`translate(${side === 'left' ? x - 70 : x + 58} ${y - 210})`}>
        <line x1={6} x2={6} y1={0} y2={180} stroke="var(--line)" vectorEffect="non-scaling-stroke" />
        <motion.rect x={0} width={12} height={4} rx={2} fill="var(--ink)" animate={{ y: 180 - h * 180 - 2 }} transition={{ type: 'spring', stiffness: 260, damping: 30 }} />
      </g>
      {/* Doppler sidebands around the pilot */}
      <g transform={`translate(${x - 36} ${y + 40})`}>
        {[
          { v: low, dx: 0 },
          { v: q.level, dx: 30, pilot: true },
          { v: high, dx: 60 }
        ].map((b, i) => (
          <motion.rect
            key={i}
            x={b.dx}
            width={12}
            rx={2}
            fill={b.pilot ? 'var(--ink-3)' : 'var(--ink)'}
            animate={{ y: 60 - Math.max(3, b.v * 60), height: Math.max(3, b.v * 60) }}
            transition={{ duration: 0.1 }}
          />
        ))}
      </g>
    </g>
  )
}

function Field({ off }: { off?: boolean }): React.JSX.Element {
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const { frame, gesture, hover } = useSonarLive()
  const reduce = !!useReducedMotion()
  const layout = React.useMemo(() => layoutFor(family), [family])
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    if (reduce) return
    let raf = 0
    const loop = (): void => {
      raf = requestAnimationFrame(loop)
      tick((n) => (n + 1) % 1e6)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [reduce])
  const b = layout.surfaces.base
  const g = layout.spec.grilles
  const pos = (side: Side): { x: number; y: number } => {
    if (g) {
      const r = toSvg(layout, 'base', side === 'left' ? g[0] : g[1])
      return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
    }
    return { x: b.x + b.w * (side === 'left' ? 0.08 : 0.92), y: b.y + b.h * 0.04 }
  }
  const lit = gesture && Date.now() - gesture.at < 1100 ? gesture : null
  const ring = lit ? pos(lit.side ?? (lit.name.includes('left') ? 'left' : 'right')) : null
  return (
    <svg viewBox={`${b.x - 140} ${b.y - 260} ${b.w + 280} ${b.h + 380}`} className="laptop-map h-full w-full" preserveAspectRatio="xMidYMid meet" role="img" aria-label="What sonar senses above each speaker">
      <Chassis layout={layout} pxUnit={0.4} drawIn={false} />
      {!off && (['left', 'right'] as Side[]).map((side) => (
        <Speaker key={side} side={side} {...pos(side)} s={frame?.[side]} hover={hover[side]} lit={!!lit && (lit.side === side || (!lit.side && lit.name.includes(side)))} reduce={reduce} />
      ))}
      <AnimatePresence>
        {ring && (
          <motion.circle
            key={lit!.at}
            cx={ring.x}
            cy={ring.y}
            fill="none"
            stroke="var(--signal)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            initial={{ r: 15, opacity: 1 }}
            animate={{ r: 110, opacity: 0 }}
            transition={{ duration: 0.64, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
      </AnimatePresence>
    </svg>
  )
}

function SideReadout({ side }: { side: Side }): React.JSX.Element {
  const s = useSonarLive((st) => st.frame?.[side])
  const q = quality(s)
  return (
    <div className="flex flex-col gap-2">
      <p className="label-mono">{side === 'left' ? 'Left speaker' : 'Right speaker'}</p>
      <div className="flex items-center gap-3">
        <div className="flex gap-0.5" aria-hidden>
          {[0.25, 0.5, 0.75, 1].map((v) => (
            <span key={v} className={cn('h-3 w-1.5 rounded-[1px]', q.level >= v ? 'bg-ink' : 'bg-hairline-strong')} />
          ))}
        </div>
        <span className="text-[13px] text-ink">{q.word}</span>
      </div>

    </div>
  )
}

function Chips(): React.JSX.Element {
  const frame = useSonarLive((s) => s.frame)
  return (
    <div className="flex flex-wrap gap-1.5">
      {gateChips(frame).map((c) => (
        <span key={c} className="rounded-full px-2.5 py-0.5 text-[12px] text-ink-2 shadow-[inset_0_0_0_1px_var(--hairline-strong)]">
          {c}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Sonar test

const PROMPTS: { g: GestureKind | 'hover'; say: string; how: string }[] = [
  { g: 'hover', say: 'Hover over a speaker', how: 'Hold a flat hand a few centimetres above either speaker, then raise and lower it slowly.' },
  { g: 'push', say: 'Push down toward a speaker', how: 'A quick move down toward the speaker, then stop.' },
  { g: 'pull', say: 'Pull up away from a speaker', how: 'Start low over the speaker and lift your hand quickly.' },
  { g: 'sweep_left', say: 'Sweep right to left', how: 'Pass your hand across above the keyboard, right to left, without touching it.' },
  { g: 'sweep_right', say: 'Sweep left to right', how: 'Pass your hand across above the keyboard, left to right.' },
  { g: 'finger_slide_up', say: 'Slide up a grille', how: 'Touch a speaker grille and slide your fingertip toward the screen.' }
]

type TestResult = { ok: boolean; saw: string }

function SonarTest({ disabled }: { disabled?: boolean }): React.JSX.Element {
  const [i, setI] = React.useState(0)
  const [results, setResults] = React.useState<TestResult[]>([])
  const [waiting, setWaiting] = React.useState(false)
  const p = PROMPTS[i]
  React.useEffect(() => {
    if (!waiting || !p) return
    let maxSide = -99
    let maxMove = 0
    const chips = new Set<string>()
    const finish = (ok: boolean): void => {
      const saw = ok
        ? 'Recognised.'
        : `Saw ${maxMove < 5 ? 'no clear movement' : `${Math.round(maxMove)} mm of movement`}${maxSide > -45 ? ', and a Doppler lift' : ''}${chips.size ? `; ${[...chips].join(', ').toLowerCase()}` : ''}.`
      setResults((r) => [...r.slice(0, i), { ok, saw }])
      setWaiting(false)
    }
    const offs = [
      client.on('sonar_debug', (f) => {
        for (const side of ['left', 'right'] as Side[]) {
          maxSide = Math.max(maxSide, f[side].sidebandLowDbc, f[side].sidebandHighDbc)
          maxMove = Math.max(maxMove, Math.abs(f[side].pathDeltaMm))
        }
        gateChips(f)
          .filter((c) => c !== 'Listening' && c !== 'Hand hovering' && c !== 'Finger sliding')
          .forEach((c) => chips.add(c))
      }),
      client.on('gesture', (g) => {
        if (p.g !== 'hover' && g.gesture === p.g) finish(true)
      }),
      client.on('air', (m) => {
        if (p.g === 'hover' && m.gesture === 'hover_level' && Math.abs(m.value ?? 0) > 0.3) finish(true)
      })
    ]
    const t = setTimeout(() => finish(false), 7000)
    return () => {
      offs.forEach((o) => o())
      clearTimeout(t)
    }
  }, [waiting, i, p])
  const done = i >= PROMPTS.length
  const passed = results.filter((r) => r.ok).length
  return (
    <div className="flex flex-col gap-4">
      {done ? (
        <>
          <p className="text-[20px] font-medium">
            {passed} of {PROMPTS.length} recognised
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setI(0)
              setResults([])
            }}
          >
            Test again
          </Button>
        </>
      ) : (
        <>
          <p className="label-mono">
            {i + 1} of {PROMPTS.length}
          </p>
          <p className="text-[20px] leading-tight font-medium">{p!.say}</p>
          <p className="max-w-[40ch] text-[13px] leading-relaxed text-ink-2">{p!.how}</p>
          {disabled && <p className="text-[13px] text-ink">Start sonar first, then press Go.</p>}
          {results[i] && <p className={cn('text-[13px] leading-relaxed', results[i]!.ok ? 'text-ink' : 'text-ink-2')}>{results[i]!.ok ? 'Recognised.' : `Not recognised. ${results[i]!.saw}`}</p>}
          <div className="flex items-center gap-4">
            {results[i] ? (
              <Button variant="primary" onClick={() => setI(i + 1)}>
                Next
              </Button>
            ) : (
              <Button variant="primary" disabled={waiting || disabled} onClick={() => setWaiting(true)}>
                {waiting ? 'Watching…' : 'Go'}
              </Button>
            )}
            {results[i] && !results[i]!.ok && (
              <Button variant="text" onClick={() => setWaiting(true)}>
                Try again
              </Button>
            )}
          </div>
        </>
      )}
      <ol className="mt-2 shadow-[0_-1px_0_var(--hairline)]">
        {PROMPTS.map((q, k) => (
          <li key={q.say} className="flex h-8 items-center gap-3 text-[12px] shadow-[0_1px_0_var(--hairline)]">
            <span className="num w-5 text-[11px] text-ink-3">{String(k + 1).padStart(2, '0')}</span>
            <span className={cn('flex-1', k === i ? 'text-ink' : 'text-ink-2')}>{q.g === 'hover' ? 'Hover level' : GESTURE_LABEL[q.g]}</span>
            <span className="tag-mono text-ink-3">{results[k] ? (results[k]!.ok ? 'Pass' : 'Miss') : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function SonarScreen(): React.JSX.Element {
  useSonarFeed()
  const session = useStore((s) => s.sessions.sonar)
  const enabled = useStore((s) => !!s.config?.settings.sonar?.enabled)
  const [mode, setMode] = React.useState<'watch' | 'test'>('watch')
  const active = !!session?.active
  return (
    <>
      <PageHeader
        title="Sonar"
        subtitle={active ? (session!.continuous || !session!.secondsLeft ? 'listening' : `listening · ${Math.round(session!.secondsLeft)}s left`) : 'off'}
        actions={
          <>
            <Segmented
              aria-label="Mode"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: 'watch', label: 'Watch' },
                { value: 'test', label: 'Sonar test' }
              ]}
            />
            {enabled && (
              <Button variant={active ? 'outline' : 'primary'} onClick={() => client.send({ type: active ? 'sonar_session_stop' : 'sonar_session_start', ...(active ? {} : { seconds: 60 }) } as never)}>
                {active ? 'Stop sonar' : 'Start sonar'}
              </Button>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[340px] shrink-0 flex-col gap-6 overflow-y-auto px-6 pt-6 pb-6">
          {!enabled || !active ? (
            <div>
              <h2 className="text-[20px] leading-tight font-medium">See what sonar senses</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
                Your speakers play two inaudible tones and the microphone hears them bounce off your hand. Start sonar, then move a hand above a speaker.
              </p>
              <div className="mt-4">
                <SessionNote gesture="hover_level" />
              </div>
            </div>
          ) : null}
          {mode === 'test' ? (
            <SonarTest disabled={!active} />
          ) : !active ? null : (
            <>
              <SideReadout side="left" />
              <SideReadout side="right" />
              <div className="flex flex-col gap-2">
                <p className="label-mono">Right now</p>
                <Chips />
              </div>
              <LastGesture />
            </>
          )}
        </div>
        <div className="relative min-w-0 flex-1 px-6 pt-4 pb-6 shadow-[-1px_0_0_var(--hairline)]">
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(55% 50% at 50% 45%, var(--light-behind), transparent 70%)' }} />
          <div className="relative h-full">
            <Field off={!active} />
          </div>
        </div>
      </div>
    </>
  )
}

function LastGesture(): React.JSX.Element {
  const g = useSonarLive((s) => s.gesture)
  return (
    <div className="flex flex-col gap-1">
      <p className="label-mono">Last sonar gesture</p>
      <p className="text-[15px] text-ink">{g ? `${GESTURE_LABEL[g.name as GestureKind] ?? g.name}${g.side ? `, ${g.side} speaker` : ''}` : 'None yet'}</p>
    </div>
  )
}

/** Compact line for the Sensors panel. */
export function SonarQualityLine(): React.JSX.Element {
  const frame = useSonarLive((s) => s.frame)
  const l = quality(frame?.left)
  const r = quality(frame?.right)
  return <p className="tag-mono text-ink-3">{frame ? `L ${l.word} · R ${r.word}` : 'No sonar readings'}</p>
}
