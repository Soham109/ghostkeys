import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { FAMILY_LABEL } from '@shared/protocol'
import { defaultZones } from '@shared/defaults'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { LaptopMap } from '@/components/laptop/LaptopMap'
import { GestureDemo, type DemoId } from '@/components/gestures/GestureDemo'

/** Three gestures that explain the idea: a touch on blank metal, a knock on the grille, a hand over the sensor. */
const INTRO: { id: string; gesture: DemoId; zone?: string; label: string; action: string }[] = [
  { id: 'a', gesture: 'double', zone: 'right-palm', label: 'Double tap, right palm rest', action: 'Play or pause' },
  { id: 'b', gesture: 'tap', zone: 'left-palm', label: 'Tap, left palm rest', action: 'Volume down' },
  { id: 'c', gesture: 'cover_hold', label: 'Cover the light sensor', action: 'Lock screen' }
]

const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Headline lines rise out of a mask, 80 ms apart. */
function Reveal({ lines, className }: { lines: React.ReactNode[]; className?: string }): React.JSX.Element {
  const reduce = useReducedMotion()
  return (
    <h1 className={className}>
      {lines.map((l, i) => (
        <span key={i} className="block overflow-hidden pb-[0.08em]">
          <motion.span
            className="block"
            initial={reduce ? { opacity: 0 } : { y: '110%' }}
            animate={reduce ? { opacity: 1 } : { y: 0 }}
            transition={{ duration: reduce ? 0.28 : 0.9, delay: i * 0.08, ease: EASE_OUT }}
          >
            {l}
          </motion.span>
        </span>
      ))}
    </h1>
  )
}

function CheckRow({ label, detail, ok, delay }: { label: string; detail?: string; ok: boolean | null; delay: number }): React.JSX.Element {
  return (
    <motion.li
      initial={{ opacity: 0, x: 8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay, duration: 0.28, ease: [0.2, 0, 0, 1] }}
      className="flex h-10 items-center gap-3 shadow-[0_1px_0_var(--hairline)]"
    >
      <span className="flex-1 text-[13px] text-ink">{label}</span>
      {detail && <span className="text-[12px] text-ink-3">{detail}</span>}
      <span className="num w-14 text-right text-[11px] tracking-[0.06em] text-ink-2">{ok === null ? '...' : ok ? 'OK' : 'NONE'}</span>
    </motion.li>
  )
}

export function Onboarding(): React.JSX.Element {
  const step = useStore((s) => s.onboardingStep)
  const hello = useStore((s) => s.hello)
  const finish = useStore((s) => s.finishOnboarding)
  const family = hello?.device.family ?? 'macbook-pro-14'
  const granted = !!hello?.permissions.accessibility
  const [asked, setAsked] = React.useState(false)
  const setStep = (n: number): void => useStore.setState({ onboardingStep: n })
  const zones = React.useMemo(() => defaultZones(family), [family])
  const [beat, setBeat] = React.useState(0)
  const TOTAL = 4

  React.useEffect(() => {
    if (step !== 0) return
    const t = setInterval(() => setBeat((b) => b + 1), 1400)
    return () => clearInterval(t)
  }, [step])

  const introIndex = Math.floor(beat / 2) % INTRO.length
  const intro = INTRO[introIndex]!

  const sensors = hello?.sensors
  const sensorRows: { label: string; key: keyof NonNullable<typeof sensors>; use: string }[] = [
    { label: 'Motion sensor', key: 'imu', use: 'Feels taps' },
    { label: 'Gyroscope', key: 'gyro', use: 'Tilts' },
    { label: 'Lid angle sensor', key: 'lid', use: 'Lid nudges' },
    { label: 'Ambient light sensor', key: 'light', use: 'Covering it' }
  ]

  const allow = (): void => {
    client.send({ type: 'request_permission', which: 'accessibility' })
    setAsked(true)
  }

  const body = [
    <>
      <Reveal
        className="font-display text-[44px] leading-[0.92] font-medium tracking-[-0.035em]"
        lines={[
          'Your MacBook has',
          <>
            <motion.span
              className="font-serif text-[46px] font-normal tracking-[-0.01em] italic"
              initial={{ filter: 'blur(8px)' }}
              animate={{ filter: 'blur(0px)' }}
              transition={{ delay: 0.12, duration: 0.9, ease: EASE_OUT }}
            >
              hidden
            </motion.span>{' '}
            keys.
          </>
        ]}
      />
      <p className="mt-6 max-w-[42ch] text-[15px] leading-[1.55] text-ink-2">
        Ghostkeys turns the palm rests, speaker grilles, edges and lid into buttons. It listens to the motion sensor already inside your Mac, so there is nothing
        to attach and nothing to charge.
      </p>
    </>,
    <>
      <Reveal className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]" lines={['Checking this Mac']} />
      <p className="mt-3 max-w-[44ch] text-[15px] leading-[1.55] text-ink-2">Ghostkeys draws your exact model and uses whichever sensors it has.</p>
      <ul className="mt-6 shadow-[0_-1px_0_var(--hairline)]">
        <CheckRow label={hello ? FAMILY_LABEL[hello.device.family] : 'Looking for your Mac'} detail={hello?.device.chip} ok={hello ? true : null} delay={0.05} />
        {sensorRows.map((r, i) => (
          <CheckRow key={r.key} label={r.label} detail={sensors ? (sensors[r.key] ? r.use : 'Not found') : undefined} ok={sensors ? !!sensors[r.key] : null} delay={0.13 + i * 0.08} />
        ))}
      </ul>
      {sensors && !sensors.imu && <p className="mt-4 max-w-[44ch] text-[13px] leading-relaxed text-ink-2">No motion sensor was found, so taps cannot be felt. Lid and light gestures still work.</p>}
    </>,
    <>
      <Reveal className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]" lines={['Let Ghostkeys press', 'keys for you']} />
      <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.55] text-ink-2">
        Shortcuts, typed text and window moves need Accessibility access. macOS asks once, and you can turn it off any time in System Settings.
      </p>
      <div className="mt-8 flex items-center gap-4">
        {granted ? (
          <p className="text-[15px] text-ink">Access allowed.</p>
        ) : (
          <Button variant="primary" size="lg" onClick={allow}>
            {asked ? 'Ask again' : 'Allow Accessibility'}
          </Button>
        )}
        {asked && !granted && <span className="text-[13px] text-ink-3">Answer the macOS prompt, then come back.</span>}
      </div>
      <p className="mt-6 max-w-[46ch] text-[12px] leading-relaxed text-ink-3">Media keys, volume, opening apps and Shortcuts work without it.</p>
    </>,
    <>
      <Reveal className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]" lines={['Teach it your taps']} />
      <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.55] text-ink-2">
        Tap each zone 20 times, then type normally for 45 seconds. Ghostkeys learns the difference on this Mac, and nothing leaves it.
      </p>
      <div className="mt-8 flex items-center gap-6">
        <Button variant="primary" size="lg" onClick={() => finish('calibration')}>
          Start calibration
        </Button>
        <Button variant="text" onClick={() => finish('live')}>
          Skip for now
        </Button>
      </div>
    </>
  ]

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="drag flex h-[52px] shrink-0 items-center justify-end px-12">
        <Button variant="text" size="sm" className="no-drag" onClick={() => finish('live')}>
          Skip introduction
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,440px)_1fr] gap-10 pr-12 pl-12">
        <div className="flex flex-col justify-center pb-10">
          <div className="mb-10 h-8">
            {step === 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
                <Logo className="size-8 text-ink" dotClassName="onboard-dot" />
              </motion.div>
            )}
          </div>
          <AnimatePresence mode="wait">
            <motion.div key={step} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}>
              {body[step]}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* One drawing for every step: it never remounts, only its emphasis changes. */}
        <div className="relative flex min-h-0 flex-col py-10">
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(55% 50% at 50% 48%, var(--light-behind), transparent 72%)' }} />
          <div className="relative min-h-0 flex-1" style={{ opacity: step === 2 ? 0.35 : 1, transition: 'opacity 600ms var(--ease-snap)' }}>
            {step === 0 ? (
              <AnimatePresence mode="wait">
                <motion.div
                  key={intro.id}
                  className="h-full"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
                >
                  <GestureDemo gesture={intro.gesture} zone={intro.zone} family={family} zones={zones} className="h-full w-full" label={intro.label} />
                </motion.div>
              </AnimatePresence>
            ) : (
              <LaptopMap family={family} zones={zones} mode="static" showLabels={step !== 2} />
            )}
          </div>
          <div className="relative flex h-10 items-center justify-center">
            <AnimatePresence mode="wait">
              {step === 0 && (
                <motion.p
                  key={intro.id}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0, transition: { delay: 0.2, duration: 0.2 } }}
                  exit={{ opacity: 0, transition: { duration: 0.2 } }}
                  className="num text-[11px] tracking-[0.08em] text-ink-2 uppercase"
                >
                  <span className="text-signal">{String(introIndex + 1).padStart(2, '0')}</span>
                  &nbsp;&nbsp;{intro.label}&nbsp;&nbsp;&rarr;&nbsp;&nbsp;{intro.action}
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      <footer className="flex h-16 shrink-0 items-center gap-6 px-12 shadow-[0_-1px_0_var(--hairline)]">
        <Button variant="text" className={step === 0 ? 'invisible' : undefined} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        <span className="num text-[11px] text-ink-3">
          {String(step + 1).padStart(2, '0')} / {String(TOTAL).padStart(2, '0')}
        </span>
        <div className="relative h-px w-40 bg-hairline-strong">
          <motion.div className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${((step + 1) / TOTAL) * 100}%` }} transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          {step < TOTAL - 1 &&
            (step === 2 && !granted ? (
              <Button variant="text" onClick={() => setStep(step + 1)}>
                Continue without it
              </Button>
            ) : (
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                {step === 0 ? 'Get started' : 'Continue'}
              </Button>
            ))}
        </div>
      </footer>
    </div>
  )
}
