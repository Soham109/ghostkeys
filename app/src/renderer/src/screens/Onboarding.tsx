import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, Minus } from 'lucide-react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL, type Zone } from '@shared/protocol'
import { defaultZones } from '@shared/defaults'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { LaptopMap } from '@/components/laptop/LaptopMap'
import { pointToSvg } from '@/components/laptop/geometry'

const DEMO = [
  { zone: 'right-palm', gesture: 'Double tap', action: 'Play or pause', taps: 2 },
  { zone: 'right-grille', gesture: 'Tap', action: 'Volume up', taps: 1 },
  { zone: 'left-palm', gesture: 'Double tap', action: 'AutoSum in Excel', taps: 2 },
  { zone: 'top-strip', gesture: 'Triple tap', action: 'Screenshot of an area', taps: 3 }
]

/** The idea in one loop: a tap on blank aluminum, a ring, and the HUD naming what happened. */
function Explainer({ family }: { family: Parameters<typeof defaultZones>[0] }): React.JSX.Element {
  const zones = React.useMemo(() => defaultZones(family), [family])
  const demos = DEMO.filter((d) => zones.some((z) => z.id === d.zone))
  const [i, setI] = React.useState(0)
  const [beat, setBeat] = React.useState(0)
  const reduce = useReducedMotion()
  const demo = demos[i % demos.length]!
  const zone = zones.find((z) => z.id === demo.zone) as Zone

  React.useEffect(() => {
    const t = setInterval(() => {
      setI((x) => x + 1)
      setBeat((b) => b + 1)
    }, 2600)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <LaptopMap
          family={family}
          zones={zones}
          mode="static"
          focusId={zone.id}
          overlay={(layout) => {
            const c = pointToSvg(layout, zone.surface, zone.rect.x + zone.rect.w * 0.55, zone.rect.y + zone.rect.h * 0.5)
            return (
              <g key={beat} pointerEvents="none">
                {Array.from({ length: demo.taps }, (_, k) => (
                  <motion.circle
                    key={k}
                    cx={c.x}
                    cy={c.y}
                    r={26}
                    fill="none"
                    stroke="var(--signal)"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                    style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                    initial={{ scale: 0.4, opacity: 0 }}
                    animate={{ scale: reduce ? 1 : [0.4, 1.6], opacity: [1, 0] }}
                    transition={{ duration: 0.52, delay: 0.35 + k * 0.2, ease: [0.16, 1, 0.3, 1] }}
                  />
                ))}
                <motion.circle
                  cx={c.x}
                  cy={c.y}
                  r={5}
                  fill="var(--signal)"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 1, 1, 0] }}
                  transition={{ duration: 1.2, delay: 0.3, times: [0, 0.1, 0.6, 1] }}
                />
              </g>
            )
          }}
        />
      </div>
      <div className="flex h-16 items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={beat}
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0, transition: { delay: 0.5 + demo.taps * 0.2, duration: 0.2, ease: [0.2, 0, 0, 1] } }}
            exit={{ opacity: 0, transition: { duration: 0.24 } }}
            className="inline-flex h-9 items-center gap-2.5 rounded-full bg-popover pr-4 pl-3.5 text-[13px] shadow-[var(--pop-shadow)]"
          >
            <span className="size-1.5 rounded-full bg-signal" />
            <span className="font-medium">{zone.name}</span>
            <span className="h-3 w-px bg-hairline-strong" />
            <span className="text-ink-2">{demo.action}</span>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
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
      <span
        className={cn(
          'flex size-4 items-center justify-center rounded-full',
          ok ? 'bg-ink text-bg' : ok === false ? 'text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline-strong)]' : 'text-ink-3'
        )}
      >
        {ok ? <Check className="size-2.5" strokeWidth={3.5} /> : <Minus className="size-2.5" />}
      </span>
      <span className="flex-1 text-[13px]">{label}</span>
      {detail && <span className="text-[12px] text-ink-3">{detail}</span>}
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
  const TOTAL = 4

  const sensors = hello?.sensors
  const sensorRows: { label: string; key: keyof NonNullable<typeof sensors>; use: string }[] = [
    { label: 'Motion sensor', key: 'imu', use: 'Feels taps' },
    { label: 'Gyroscope', key: 'gyro', use: 'Tilts' },
    { label: 'Lid angle sensor', key: 'lid', use: 'Lid nudges' },
    { label: 'Ambient light sensor', key: 'light', use: 'Covering it' }
  ]

  const body = [
    <>
      <h1 className="text-[44px] leading-[1.02] font-medium tracking-[-0.035em]">
        Your MacBook has <span className="font-serif font-normal tracking-[-0.01em] italic">hidden</span> keys.
      </h1>
      <p className="mt-5 max-w-[42ch] text-[15px] leading-relaxed text-ink-2">
        Ghostkeys turns the palm rests, speaker grilles, edges and lid into buttons. It listens to the motion sensor already inside
        your Mac, so there is nothing to attach and nothing to charge.
      </p>
    </>,
    <>
      <h1 className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]">Checking this Mac</h1>
      <p className="mt-3 max-w-[44ch] text-[13px] leading-relaxed text-ink-2">Ghostkeys draws your exact model and uses whichever sensors it has.</p>
      <ul className="mt-6 shadow-[0_-1px_0_var(--hairline)]">
        <CheckRow label={hello ? FAMILY_LABEL[hello.device.family] : 'Looking for your Mac'} detail={hello ? `${hello.device.chip}` : undefined} ok={hello ? true : null} delay={0.05} />
        {sensorRows.map((r, i) => (
          <CheckRow key={r.key} label={r.label} detail={sensors ? (sensors[r.key] ? r.use : 'Not found') : undefined} ok={sensors ? sensors[r.key] : null} delay={0.15 + i * 0.08} />
        ))}
      </ul>
      {sensors && !sensors.imu && (
        <p className="mt-4 max-w-[44ch] text-[12px] leading-relaxed text-ink-2">
          No motion sensor was found, so taps cannot be felt. Lid and light gestures still work.
        </p>
      )}
    </>,
    <>
      <h1 className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]">Let Ghostkeys press keys for you</h1>
      <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-ink-2">
        Shortcuts, typed text and window moves need Accessibility access. macOS asks once; you can turn it off any time in System
        Settings, under Privacy and Security.
      </p>
      <div className="mt-6 flex items-center gap-3 py-3 shadow-[0_-1px_0_var(--hairline),0_1px_0_var(--hairline)]">
        <span className={cn('size-2 rounded-full', granted ? 'bg-ink' : 'shadow-[inset_0_0_0_1px_var(--ink-3)]')} />
        <span className="flex-1 text-[13px]">{granted ? 'Access granted' : asked ? 'Waiting for your answer in the macOS prompt' : 'Not granted yet'}</span>
        {!granted && (
          <Button
            variant="outline"
            onClick={() => {
              client.send({ type: 'request_permission', which: 'accessibility' })
              setAsked(true)
            }}
          >
            Open the prompt
          </Button>
        )}
      </div>
      <p className="mt-4 max-w-[46ch] text-[12px] leading-relaxed text-ink-3">
        Media keys, volume, opening apps and Shortcuts work without it.
      </p>
    </>,
    <>
      <h1 className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em]">Teach it your taps</h1>
      <p className="mt-3 max-w-[46ch] text-[13px] leading-relaxed text-ink-2">
        You tap each zone 20 times, then type normally for 45 seconds. Ghostkeys learns the difference on this Mac, and nothing leaves
        it.
      </p>
      <div className="mt-8 flex gap-2">
        <Button variant="primary" size="lg" onClick={() => finish('calibration')}>
          Start calibration
        </Button>
        <Button variant="ghost" size="lg" onClick={() => finish('live')}>
          Skip for now
        </Button>
      </div>
    </>
  ]

  return (
    <div className="flex h-full w-full flex-col bg-bg">
      <div className="drag flex h-[52px] shrink-0 items-center justify-end px-6">
        <button className="no-drag text-[12px] text-ink-3 hover:text-ink" onClick={() => finish('live')}>
          Skip introduction
        </button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(360px,440px)_1fr] gap-10 pr-10 pl-16">
        <div className="flex flex-col justify-center pb-10">
          <Logo className="mb-10 size-8 text-ink" dotClassName="text-signal fill-[var(--signal)]" />
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
            >
              {body[step]}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="relative min-h-0 py-10">
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(55% 50% at 50% 48%, var(--light-behind), transparent 72%)' }} />
          <div className="relative h-full">
            {step === 0 ? (
              <Explainer family={family} />
            ) : (
              <div className="h-full pb-16">
                <LaptopMap family={family} zones={defaultZones(family)} mode="static" showLabels={step !== 2} mutedIds={step === 2 ? defaultZones(family).map((z) => z.id) : []} />
              </div>
            )}
          </div>
        </div>
      </div>
      <footer className="flex h-16 shrink-0 items-center gap-6 px-16 shadow-[0_-1px_0_var(--hairline)]">
        <span className="num text-[11px] text-ink-3">
          {String(step + 1).padStart(2, '0')} / {String(TOTAL).padStart(2, '0')}
        </span>
        <div className="relative h-px w-40 bg-hairline-strong">
          <motion.div className="absolute inset-y-0 left-0 bg-ink" animate={{ width: `${((step + 1) / TOTAL) * 100}%` }} transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }} />
        </div>
        <div className="ml-auto flex gap-2">
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          {step < TOTAL - 1 && (
            <Button variant="primary" onClick={() => setStep(step + 1)}>
              {step === 0 ? 'Get started' : step === 2 && !granted ? 'Continue without it' : 'Continue'}
            </Button>
          )}
        </div>
      </footer>
    </div>
  )
}
