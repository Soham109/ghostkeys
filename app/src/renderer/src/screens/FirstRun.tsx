import * as React from 'react'
import { create } from 'zustand'
import { motion } from 'motion/react'
import type { Binding, RejectedMsg } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { explain } from '@/lib/why'
import { Button } from '@/components/ui/button'
import { usePractice } from './Practice'

const TARGET = 10
const NEG_SECONDS = 15

/** Onboarding, step 4: teach the two palm rests, quickly, without leaving the tour. */
export const useQuickCal = create<{
  phase: 'intro' | 'capture' | 'typing' | 'training' | 'done'
  zones: string[]
  index: number
  counts: Record<string, number>
  secondsLeft: number
  overall: number | null
}>()(() => ({ phase: 'intro', zones: [], index: 0, counts: {}, secondsLeft: NEG_SECONDS, overall: null }))

export function quickZones(): string[] {
  const zs = useStore.getState().config?.zones ?? []
  const want = zs.filter((z) => z.enabled !== false && (z.id === 'left-palm' || z.id === 'right-palm')).map((z) => z.id)
  return want.length ? want : zs.filter((z) => z.enabled !== false).slice(0, 2).map((z) => z.id)
}

export function QuickCalibrate({ onDone }: { onDone: () => void }): React.JSX.Element {
  const { phase, zones, index, counts, secondsLeft, overall } = useQuickCal()
  const config = useStore((s) => s.config)
  const name = (id?: string): string => config?.zones.find((z) => z.id === id)?.name ?? id ?? ''
  const current = zones[index]

  React.useEffect(() => {
    const off = client.on('calibration', (m) => {
      const st = useQuickCal.getState()
      if (m.phase === 'capturing' && st.phase === 'capture') {
        const counts = { ...st.counts, [m.zone]: m.count }
        useQuickCal.setState({ counts })
        if (m.zone === st.zones[st.index] && m.count >= TARGET) {
          const ni = st.index + 1
          setTimeout(() => {
            if (ni < st.zones.length) {
              client.send({ type: 'calibration_zone', zone: st.zones[ni]! })
              useQuickCal.setState({ index: ni })
            } else {
              client.send({ type: 'calibration_negatives', seconds: NEG_SECONDS })
              useQuickCal.setState({ phase: 'typing', secondsLeft: NEG_SECONDS })
            }
          }, 500)
        }
      } else if (m.phase === 'negatives' && st.phase === 'typing') {
        useQuickCal.setState({ secondsLeft: m.secondsLeft })
        if (m.secondsLeft <= 0) {
          client.send({ type: 'calibration_finish' })
          useQuickCal.setState({ phase: 'training' })
        }
      } else if (m.phase === 'done' && st.phase === 'training') {
        useQuickCal.setState({ phase: 'done', overall: m.overall })
      }
    })
    return off
  }, [])

  const start = (): void => {
    const zs = quickZones()
    client.send({ type: 'calibration_start', zones: zs, target: TARGET })
    client.send({ type: 'calibration_zone', zone: zs[0]! })
    useQuickCal.setState({ phase: 'capture', zones: zs, index: 0, counts: {} })
  }

  const count = current ? (counts[current] ?? 0) : 0
  return (
    <>
      <h1 className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]">
        {phase === 'intro'
          ? 'Teach it your palm rests'
          : phase === 'capture'
            ? `Tap the ${name(current).toLowerCase()} lightly, about once a second`
            : phase === 'typing'
              ? `Now type anything for ${NEG_SECONDS} seconds`
              : phase === 'training'
                ? 'Learning your taps'
                : 'Your palm rests are ready'}
      </h1>
      <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.55] text-ink-2">
        {phase === 'intro'
          ? `Two zones to start with: ${TARGET} light taps on each palm rest, then a few seconds of typing so Ghostkeys learns what to ignore. You can add the other zones later.`
          : phase === 'capture'
            ? 'Use a relaxed fingertip, the way you would every day. The dots fill as each tap is felt.'
            : phase === 'typing'
              ? 'Type in any app, or just in the box below. Don’t tap the palm rests.'
              : phase === 'training'
                ? 'This takes a moment and happens on your Mac.'
                : `Ghostkeys recognised ${overall !== null ? `${Math.round(overall * 100)}%` : 'most'} of your practice taps. Let’s try one for real.`}
      </p>
      {phase === 'capture' && (
        <div className="mt-6 flex items-center gap-4">
          <div className="flex gap-1" aria-hidden>
            {Array.from({ length: TARGET }, (_, i) => (
              <motion.span key={i} className="size-2 rounded-full" animate={{ backgroundColor: i < count ? 'var(--ink)' : 'var(--hairline-strong)' }} transition={{ duration: 0.16 }} />
            ))}
          </div>
          <span className="num text-[12px] text-ink-2">
            {count} of {TARGET}
          </span>
          <span className="num text-[11px] text-ink-3">
            ZONE {index + 1} OF {zones.length}
          </span>
        </div>
      )}
      {phase === 'typing' && (
        <>
          <p className="numeral mt-6 text-[44px]">{secondsLeft}</p>
          <textarea autoFocus aria-label="Type anything here" placeholder="Type anything here." className="mt-3 h-16 w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3" />
        </>
      )}
      <div className="mt-8 flex items-center gap-6">
        {phase === 'intro' && (
          <Button variant="primary" size="lg" onClick={start}>
            Start
          </Button>
        )}
        {phase === 'done' && (
          <Button variant="primary" size="lg" onClick={onDone}>
            Try it
          </Button>
        )}
        {(phase === 'capture' || phase === 'typing') && (
          <Button
            variant="text"
            onClick={() => {
              client.send({ type: 'calibration_cancel' })
              useQuickCal.setState({ phase: 'intro' })
            }}
          >
            Start over
          </Button>
        )}
      </div>
    </>
  )
}

/** Onboarding, step 5: fire the first gesture for real. */
export function FirstGesture({ onFinish }: { onFinish: (to?: 'live' | 'calibration') => void }): React.JSX.Element {
  const config = useStore((s) => s.config)
  const zone = config?.zones.find((z) => z.id === 'right-palm' && z.enabled !== false) ?? config?.zones.find((z) => z.enabled !== false)
  const [success, setSuccess] = React.useState<string | null>(null)
  const [waitedLong, setWaitedLong] = React.useState(false)
  const [lastReject, setLastReject] = React.useState<RejectedMsg | null>(null)

  // Make sure a harmless binding exists for the first try: double tap, play or pause.
  React.useEffect(() => {
    if (!config || !zone) return
    const has = config.bindings.some((b) => b.enabled && b.gesture === 'double' && b.zone === zone.id && b.modifiers.length === 0)
    if (has) return
    const b: Binding = { id: 'first', enabled: true, gesture: 'double', zone: zone.id, zones: null, modifiers: [], app: '*', action: { kind: 'media', command: 'playpause' }, label: 'Play or pause' }
    client.send({ type: 'config_set', config: { ...config, bindings: [...config.bindings.filter((x) => x.id !== 'first'), b] } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.bindings.length, zone?.id])

  React.useEffect(() => {
    if (!zone) return
    const offs = [
      client.on('gesture', (g) => {
        if (g.zone === zone.id && g.gesture === 'double') setSuccess('double')
      }),
      client.on('rejected', (r) => setLastReject(r))
    ]
    const t = setTimeout(() => setWaitedLong(true), 20000)
    return () => {
      offs.forEach((o) => o())
      clearTimeout(t)
    }
  }, [zone])

  const why = explain(lastReject, config?.settings, (id) => config?.zones.find((z) => z.id === id)?.name ?? id)
  const zname = zone?.name.toLowerCase() ?? 'palm rest'
  return (
    <>
      <h1 className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]">{success ? 'That’s it.' : `Double-tap the ${zname}`}</h1>
      <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.55] text-ink-2">
        {success
          ? `A double tap on the ${zname} now plays and pauses music. Change what it does, or add more gestures, in Gestures and actions.`
          : 'Two quick, light taps, like double-clicking. If music is open, it will play or pause.'}
      </p>
      {!success && waitedLong && (
        <div className="mt-6 max-w-[46ch]">
          <p className="text-[13px] leading-relaxed text-ink">{lastReject ? why.sentence : 'Nothing has registered yet. Try taps a little firmer, or practise in the Tap test.'}</p>
        </div>
      )}
      <div className="mt-8 flex items-center gap-6">
        {success ? (
          <Button variant="primary" size="lg" onClick={() => onFinish('live')}>
            Finish
          </Button>
        ) : (
          <>
            {waitedLong && (
              <Button
                variant="outline"
                onClick={() => {
                  usePractice.setState({ mode: 'test' })
                  onFinish('calibration')
                }}
              >
                Open the Tap test
              </Button>
            )}
            <Button variant="text" onClick={() => onFinish('live')}>
              Skip for now
            </Button>
          </>
        )}
      </div>
    </>
  )
}
