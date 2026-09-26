import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ArrowLeft, Pause, Play } from 'lucide-react'
import { useStore, type FeedItem } from '@/lib/store'
import { client } from '@/lib/client'
import { appName } from '@/lib/apps'
import { bindingsForZone, zoneById } from '@/lib/bindings'
import { relTime, cn } from '@/lib/utils'
import { GESTURE_LABEL, MODIFIER_GLYPH, SURFACE_LABEL, ZONELESS_GESTURES, type Config, type Zone } from '@shared/protocol'
import { describeAction, sortModifiers } from '@shared/actions'
import { PageHeader, Fact, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { ZoneDot } from '@/components/ui/controls'
import { LaptopMap } from '@/components/laptop/LaptopMap'

export function useNow(ms: number): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function StatusFacts(): React.JSX.Element {
  const hello = useStore((s) => s.hello)
  const status = useStore((s) => s.status)
  const conn = useStore((s) => s.conn)
  const navigate = useStore((s) => s.navigate)
  const sensors = hello ? Object.values(hello.sensors) : []
  const present = sensors.filter(Boolean).length
  const granted = !!hello?.permissions.accessibility

  return (
    <div className="grid shrink-0 grid-cols-5 gap-6 px-6 pt-1 pb-4 hairline-b">
      <Fact label="Service">{conn === 'open' ? (status?.paused ? 'Paused' : 'Connected') : 'Offline'}</Fact>
      <Fact label="Sensors">
        {hello ? (
          <>
            {present} of {sensors.length}
            {present < sensors.length && <span className="text-ink-3">present</span>}
          </>
        ) : (
          <span className="text-ink-3">Checking</span>
        )}
      </Fact>
      <Fact label="Calibration">
        {status?.calibrated ? (
          'Trained'
        ) : (
          <button className="underline decoration-ink-3 underline-offset-2 hover:decoration-ink" onClick={() => navigate('calibration')}>
            Not trained yet
          </button>
        )}
      </Fact>
      <Fact label="Accessibility">
        {granted ? (
          'Granted'
        ) : (
          <>
            <span className="text-ink-2">Not granted</span>
            <Button size="sm" variant="outline" onClick={() => client.send({ type: 'request_permission', which: 'accessibility' })}>
              Grant
            </Button>
          </>
        )}
      </Fact>
      <Fact label="Motion sensor">
        <span className="num">{status ? `${status.imuHz} Hz` : '...'}</span>
      </Fact>
    </div>
  )
}

function FeedRow({ item, zones, now }: { item: FeedItem; zones: Zone[]; now: number }): React.JSX.Element {
  const g = item.gesture
  const zoneless = ZONELESS_GESTURES.includes(g.gesture)
  const zone = zoneById(zones, g.zone)
  const seq = g.gesture === 'sequence' ? (g.zones ?? []).map((id) => zoneById(zones, id)) : null
  const title = zoneless ? GESTURE_LABEL[g.gesture] : seq ? seq.map((z) => z?.name ?? '?').join(' then ') : (zone?.name ?? g.zone)
  return (
    <motion.li
      layout="position"
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
      className="flex gap-3 px-4 py-2.5 shadow-[0_1px_0_var(--hairline)]"
    >
      <span className="mt-[5px] flex w-2 shrink-0 flex-col gap-1">
        {seq ? seq.map((z, i) => <ZoneDot key={i} color={z?.color ?? 'var(--ink-3)'} />) : <ZoneDot color={zone?.color ?? 'var(--ink-3)'} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] text-ink">{title}</span>
          <span className="shrink-0 font-mono text-[11px] text-ink-3">{relTime(now - item.at)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-ink-3">
          {!zoneless && <span>{GESTURE_LABEL[g.gesture]}</span>}
          {g.modifiers.length > 0 && <span className="font-mono">{sortModifiers(g.modifiers).map((m) => MODIFIER_GLYPH[m]).join('')}</span>}
          {!zoneless && <span aria-hidden>/</span>}
          {item.action ? (
            <span className={cn('truncate', item.action.ok ? 'text-ink-2' : 'text-danger')}>
              {item.action.label}
              {!item.action.ok && `, ${item.action.error ?? 'failed'}`}
            </span>
          ) : (
            <span className="truncate">No binding</span>
          )}
        </div>
      </div>
    </motion.li>
  )
}

function ZoneDetail({ zone, config, onBack }: { zone: Zone; config: Config; onBack: () => void }): React.JSX.Element {
  const navigate = useStore((s) => s.navigate)
  const bindings = bindingsForZone(config, zone.id)
  return (
    <motion.div
      key={zone.id}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex items-center gap-2 px-2 pt-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          Recent
        </Button>
      </div>
      <div className="px-4 pt-3 pb-4">
        <div className="flex items-center gap-2">
          <ZoneDot color={zone.color} />
          <h2 className="text-[15px] font-medium">{zone.name}</h2>
        </div>
        <p className="mt-1 text-[12px] text-ink-3">{SURFACE_LABEL[zone.surface]}</p>
      </div>
      <div className="px-4">
        <p className="label-mono pb-2">Bindings</p>
      </div>
      {bindings.length ? (
        <ul className="shadow-[0_-1px_0_var(--hairline)]">
          {bindings.map((b) => (
            <li key={b.id} className={cn('px-4 py-2.5 shadow-[0_1px_0_var(--hairline)]', !b.enabled && 'opacity-50')}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[13px]">{b.label || describeAction(b.action)}</span>
                <span className="shrink-0 text-[11px] text-ink-3">{appName(b.app)}</span>
              </div>
              <div className="mt-0.5 text-[12px] text-ink-3">
                {GESTURE_LABEL[b.gesture]}
                {b.modifiers.length > 0 && <span className="ml-1.5 font-mono">{sortModifiers(b.modifiers).map((m) => MODIFIER_GLYPH[m]).join('')}</span>}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Nothing is bound here yet.">Give this zone a job, like play and pause, or moving a window.</Empty>
      )}
      <div className="px-4 pt-4">
        <Button
          variant="outline"
          onClick={() => {
            navigate('bindings')
            useStore.setState({ editingBinding: `new:${zone.id}` })
          }}
        >
          Add a binding
        </Button>
      </div>
    </motion.div>
  )
}

export function LiveScreen(): React.JSX.Element {
  const hello = useStore((s) => s.hello)
  const config = useStore((s) => s.config)
  const feed = useStore((s) => s.feed)
  const status = useStore((s) => s.status)
  const setPaused = useStore((s) => s.setPaused)
  const [selected, setSelected] = React.useState<string | null>(null)
  const now = useNow(5000)

  React.useEffect(() => client.subscribe(['taps']), [])

  const zones = config?.zones ?? []
  const selectedZone = zones.find((z) => z.id === selected)
  const paused = !!status?.paused

  return (
    <>
      <PageHeader
        title="Live"
        actions={
          <Button variant="outline" onClick={() => setPaused(!paused)}>
            {paused ? <Play /> : <Pause />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        }
      />
      <StatusFacts />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(60% 55% at 50% 48%, var(--light-behind), transparent 70%)' }}
          />
          <div className="relative min-h-0 flex-1 px-10 pt-8 pb-4">
            {hello && config ? (
              <LaptopMap
                family={hello.device.family}
                zones={zones}
                mode="live"
                listenTaps
                selectedId={selected}
                onSelect={(id) => setSelected(id)}
              />
            ) : null}
          </div>
          <p className="relative px-6 pb-5 text-[12px] text-ink-3">
            {paused
              ? 'Paused. Taps are felt but nothing runs until you resume.'
              : 'Tap a zone on your MacBook to see it light up. Click a zone here to see what it does.'}
          </p>
        </div>
        <aside className="flex w-[300px] shrink-0 flex-col shadow-[-1px_0_0_var(--hairline)]">
          <AnimatePresence mode="wait" initial={false}>
            {selectedZone && config ? (
              <ZoneDetail key="detail" zone={selectedZone} config={config} onBack={() => setSelected(null)} />
            ) : (
              <motion.div
                key="feed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="px-4 pt-4">
                  <p className="label-mono pb-2">Recent gestures</p>
                </div>
                {feed.length ? (
                  <ul className="min-h-0 flex-1 overflow-y-auto shadow-[0_-1px_0_var(--hairline)]">
                    <AnimatePresence initial={false}>
                      {feed.map((item) => (
                        <FeedRow key={item.id} item={item} zones={zones} now={now} />
                      ))}
                    </AnimatePresence>
                  </ul>
                ) : (
                  <Empty title="Nothing yet.">Tap a palm rest or a speaker grille. Each gesture Ghostkeys recognizes shows up here.</Empty>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>
    </>
  )
}
