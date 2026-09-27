import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore, zoneNumber, type FeedItem } from '@/lib/store'
import { client } from '@/lib/client'
import { appName } from '@/lib/apps'
import { bindingsForZone } from '@/lib/bindings'
import { cn } from '@/lib/utils'
import { GESTURE_LABEL, MODIFIER_GLYPH, SURFACE_LABEL, ZONELESS_GESTURES, type Config, type Zone } from '@shared/protocol'
import { describeAction, sortModifiers } from '@shared/actions'
import { PageHeader, Notice, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { ZoneIndex } from '@/components/ui/controls'
import { LaptopMap } from '@/components/laptop/LaptopMap'
import { Seismograph } from '@/components/Seismograph'
import { FeedbackActions } from '@/components/Feedback'
import { useBlockedBindings } from '@/components/SessionNeed'

export function useNow(ms: number): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

/** Everything fine fits on one mono line. */
function statusLine(s: ReturnType<typeof useStore.getState>): string {
  const parts: string[] = []
  parts.push(s.conn === 'open' ? (s.status?.paused ? 'Paused' : 'Connected') : 'Offline')
  if (s.hello) {
    const v = Object.entries(s.hello.sensors).filter(([k]) => ['imu', 'gyro', 'lid', 'light'].includes(k))
    parts.push(`${v.filter(([, on]) => on).length}/${v.length} sensors`)
  }
  if (s.status?.calibrated) parts.push('Trained')
  if (s.status) parts.push(`${s.status.imuHz} Hz`)
  return parts.join(' · ')
}

function Notices(): React.JSX.Element {
  const blocked = useBlockedBindings()
  const hello = useStore((s) => s.hello)
  const status = useStore((s) => s.status)
  const navigate = useStore((s) => s.navigate)
  const setPaused = useStore((s) => s.setPaused)
  return (
    <>
      {status?.paused && status.pausedReason === 'rate_limit' && (
        <Notice
          action={
            <Button variant="primary" size="sm" onClick={() => setPaused(false)}>
              Resume
            </Button>
          }
        >
          Ghostkeys paused itself because actions fired too fast in a row. Check your bindings, then resume.
        </Notice>
      )}
      {blocked.length > 0 && (
        <Notice
          action={
            <Button variant="text" className="text-ink underline decoration-ink-3 underline-offset-2" onClick={() => navigate('bindings')}>
              Review
            </Button>
          }
        >
          {(() => {
            const n = blocked.reduce((a, x) => a + x.bindings.length, 0)
            return `${n} ${n === 1 ? 'gesture can\u2019t' : 'gestures can\u2019t'} fire right now: ${blocked.map((x) => x.name).join(' and ')} ${blocked.length === 1 ? 'is' : 'are'} off.`
          })()}
        </Notice>
      )}
      {hello && !hello.permissions.accessibility && (
        <Notice
          action={
            <Button variant="text" className="text-ink underline decoration-ink-3 underline-offset-2" onClick={() => client.send({ type: 'request_permission', which: 'accessibility' })}>
              Allow in System Settings
            </Button>
          }
        >
          Ghostkeys can&rsquo;t press keys or move windows yet.
        </Notice>
      )}
      {status && !status.calibrated && (
        <Notice
          action={
            <Button variant="text" className="text-ink underline decoration-ink-3 underline-offset-2" onClick={() => navigate('calibration')}>
              Calibrate
            </Button>
          }
        >
          Ghostkeys hasn&rsquo;t learned how your taps feel yet.
        </Notice>
      )}
    </>
  )
}

function FeedRow({ item, config, now }: { item: FeedItem; config: Config; now: number }): React.JSX.Element {
  const g = item.gesture
  const zoneless = ZONELESS_GESTURES.includes(g.gesture)
  const fresh = now - item.at < 1100
  const idx = g.gesture === 'sequence' ? null : zoneNumber(config, g.zone)
  const seq = g.gesture === 'sequence' ? (g.zones ?? []).map((z) => String(zoneNumber(config, z) ?? 0).padStart(2, '0')).join('→') : null
  return (
    // The row grows from 0 to 32pt while it fades in, so the rows below are pushed down, never overlapped.
    <motion.li
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 32 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
      className="flex items-center gap-2.5 overflow-hidden px-4 shadow-[0_1px_0_var(--hairline)]"
      title={`${g.gesture === 'sequence' ? 'Sequence' : zoneless ? '' : (config.zones.find((z) => z.id === g.zone)?.name ?? '')}${g.app ? ` in ${appName(g.app)}` : ''}`}
    >
      {seq ? (
        <span className={cn('num w-11 shrink-0 text-[11px] tracking-[0.04em]', fresh ? 'text-signal' : 'text-ink-3')}>{seq}</span>
      ) : zoneless ? (
        <span className={cn('num w-5 shrink-0 text-[11px]', fresh ? 'text-signal' : 'text-ink-3')}>{g.zone === 'air' ? 'AIR' : '—'}</span>
      ) : (
        <ZoneIndex n={idx} lit={fresh} />
      )}
      <span className="shrink-0 text-[13px] text-ink">{GESTURE_LABEL[g.gesture] ?? g.gesture}</span>
      {g.modifiers.length > 0 && <span className="num shrink-0 text-[11px] text-ink-2">{sortModifiers(g.modifiers).map((m) => MODIFIER_GLYPH[m]).join('')}</span>}
      {item.tapType && item.tapType !== 'fingertip' && <span className="tag-mono shrink-0 text-ink-3">{item.tapType}</span>}
      <span className={cn('min-w-0 flex-1 truncate text-[13px]', item.action && !item.action.ok ? 'text-ink-3 line-through' : 'text-ink-2')}>
        {item.action ? item.action.label : ''}
      </span>
      {item.count > 1 && <span className="num shrink-0 text-[11px] text-ink-2">&times;{item.count}</span>}
      <span className="num w-7 shrink-0 text-right text-[11px] text-ink-3">{ago(now - item.at)}</span>
    </motion.li>
  )
}

function Feed({ config }: { config: Config }): React.JSX.Element {
  const feed = useStore((s) => s.feed)
  const now = useNow(1000)
  if (!feed.length) return <Empty title="Nothing yet." />
  // Group by minute with a mono divider.
  const groups: { key: string; items: FeedItem[] }[] = []
  for (const f of feed) {
    const d = new Date(f.at)
    const key = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const g = groups[groups.length - 1]
    if (g && g.key === key) g.items.push(f)
    else groups.push({ key, items: [f] })
  }
  return (
    <ul className="fade-bottom min-h-0 flex-1 overflow-y-auto pb-6">
      <AnimatePresence initial={false}>
        {groups.map((g) => (
          <React.Fragment key={g.key}>
            <li className="num flex h-7 items-end px-4 pb-1 text-[10px] tracking-[0.08em] text-ink-3 shadow-[0_1px_0_var(--hairline)]">{g.key}</li>
            {g.items.map((item) => (
              <FeedRow key={item.id} item={item} config={config} now={now} />
            ))}
          </React.Fragment>
        ))}
      </AnimatePresence>
    </ul>
  )
}

function ZoneDetail({ zone, index, config, onBack }: { zone: Zone; index: number; config: Config; onBack: () => void }): React.JSX.Element {
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
      <div className="px-4 pt-4">
        <Button variant="text" size="sm" onClick={onBack}>
          Back to recent
        </Button>
      </div>
      <div className="px-4 pt-3 pb-5">
        <div className="flex items-baseline gap-2">
          <ZoneIndex n={index} />
          <h2 className="text-[15px] font-medium">{zone.name}</h2>
        </div>
        <p className="mt-1 pl-7 text-[12px] text-ink-3">{SURFACE_LABEL[zone.surface]}</p>
      </div>
      <p className="label-mono px-4 pb-2">Bindings</p>
      {bindings.length ? (
        <ul className="shadow-[0_-1px_0_var(--hairline)]">
          {bindings.map((b) => (
            <li key={b.id} className="flex h-8 items-center gap-2.5 px-4 shadow-[0_1px_0_var(--hairline)]">
              <span className={cn('shrink-0 text-[13px]', b.enabled ? 'text-ink' : 'text-ink-3')}>{GESTURE_LABEL[b.gesture]}</span>
              {b.modifiers.length > 0 && <span className="num text-[11px] text-ink-2">{sortModifiers(b.modifiers).map((m) => MODIFIER_GLYPH[m]).join('')}</span>}
              <span className={cn('min-w-0 flex-1 truncate text-[13px]', b.enabled ? 'text-ink-2' : 'text-ink-3')}>{b.label || describeAction(b.action)}</span>
              {b.app !== '*' && <span className="shrink-0 text-[11px] text-ink-3">{appName(b.app)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <Empty title="Nothing is bound here yet." />
      )}
      <div className="px-4 pt-5">
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
  const line = useStore(statusLine)
  const tapsSeen = useStore((s) => s.tapsSeen)
  const [selected, setSelected] = React.useState<string | null>(null)

  React.useEffect(() => client.subscribe(['taps']), [])

  const zones = config?.zones ?? []
  const selectedIndex = zones.findIndex((z) => z.id === selected)
  const selectedZone = zones[selectedIndex]

  return (
    <>
      <PageHeader title="Live" subtitle={line} />
      <Notices />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(60% 55% at 50% 45%, var(--light-behind), transparent 70%)' }} />
          <div className="relative min-h-0 flex-1 px-8 pt-6 pb-2">
            {hello && config ? (
              <LaptopMap
                family={hello.device.family}
                zones={zones}
                mode="live"
                listenTaps
                selectedId={selected}
                onSelect={(id) => setSelected(id)}
                describe={(z) => {
                  const n = bindingsForZone(config, z.id).length
                  return `${n} ${n === 1 ? 'gesture' : 'gestures'}`
                }}
              />
            ) : null}
          </div>
          <div className="relative h-12 px-8">
            <AnimatePresence>
              {tapsSeen === 0 && (
                <motion.p
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.28 }}
                  className="absolute inset-x-0 top-0 text-center text-[13px] text-ink-2"
                >
                  Tap anywhere on your MacBook.
                </motion.p>
              )}
            </AnimatePresence>
          </div>
          <div className="relative px-8 pb-6">
            <Seismograph height={40} />
          </div>
        </div>
        <aside className="flex w-[320px] shrink-0 flex-col shadow-[-1px_0_0_var(--hairline)]">
          <AnimatePresence mode="wait" initial={false}>
            {selectedZone && config ? (
              <ZoneDetail key="detail" zone={selectedZone} index={selectedIndex + 1} config={config} onBack={() => setSelected(null)} />
            ) : (
              <motion.div
                key="feed"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <p className="label-mono px-4 pt-6 pb-2">Recent gestures</p>
                {config && <Feed config={config} />}
                <div className="flex h-11 shrink-0 items-center px-4 shadow-[0_-1px_0_var(--hairline)]">
                  <FeedbackActions />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </aside>
      </div>
    </>
  )
}
