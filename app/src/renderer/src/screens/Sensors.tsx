import * as React from 'react'
import uPlot from 'uplot'
import { motion } from 'motion/react'
import { REJECT_LABEL, type AirMsg, type ImuMsg, type RejectReason } from '@shared/protocol'
import { useStore, zoneNumber } from '@/lib/store'
import { client } from '@/lib/client'
import { PageHeader } from '@/components/Page'
import { Segmented } from '@/components/ui/controls'
import { Button } from '@/components/ui/button'

const WINDOW_S = 8
const CAP = 60 * 12

interface Marker {
  t: number
  kind: 'tap' | 'rejected'
  label: string
}

/** Rolling sample buffers shared by both charts, fed straight from the socket (no React state at 60 Hz). */
class SensorBuffer {
  t: number[] = []
  a: [number[], number[], number[]] = [[], [], []]
  g: [number[], number[], number[]] = [[], [], []]
  markers: Marker[] = []
  latest = 0

  push(m: ImuMsg): void {
    this.t.push(m.t / 1000)
    for (let i = 0; i < 3; i++) {
      this.a[i]!.push(m.a[i]!)
      this.g[i]!.push(m.g[i]!)
    }
    this.latest = m.t / 1000
    if (this.t.length > CAP) {
      const n = this.t.length - CAP
      this.t.splice(0, n)
      this.a.forEach((s) => s.splice(0, n))
      this.g.forEach((s) => s.splice(0, n))
    }
  }
  mark(m: Marker): void {
    this.markers.push(m)
    const cutoff = this.latest - WINDOW_S - 1
    this.markers = this.markers.filter((x) => x.t >= cutoff)
  }
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function Chart({ buffer, pick, unit, theme, paused, showLabels }: { buffer: SensorBuffer; pick: 'a' | 'g'; unit: string; theme: string; paused: boolean; showLabels: boolean }): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const pausedRef = React.useRef(paused)
  React.useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ink = cssVar('--ink')
    const ink2 = cssVar('--ink-2')
    const ink3 = cssVar('--ink-3')
    const hair = cssVar('--hairline')
    const line = cssVar('--line')
    const signal = cssVar('--signal')
    const font = '10px "Geist Mono", ui-monospace, monospace'
    const markerPlugin: uPlot.Plugin = {
      hooks: {
        drawAxes: [
          (u) => {
            // A baseline across the whole plot, so a filling buffer never looks broken.
            const ctx = u.ctx
            const y = Math.round(u.valToPos(pick === 'a' ? -1 : 0, 'y', true)) + 0.5
            if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) return
            ctx.save()
            ctx.strokeStyle = line
            ctx.lineWidth = devicePixelRatio
            ctx.beginPath()
            ctx.moveTo(u.bbox.left, y)
            ctx.lineTo(u.bbox.left + u.bbox.width, y)
            ctx.stroke()
            ctx.restore()
          }
        ],
        draw: [
          (u) => {
            const ctx = u.ctx
            const dpr = devicePixelRatio
            const { top, height } = u.bbox
            ctx.save()
            ctx.font = `${10 * dpr}px "Geist Mono", ui-monospace, monospace`
            const rowsEnd = [-Infinity, -Infinity]
            for (const m of buffer.markers) {
              const x = Math.round(u.valToPos(m.t, 'x', true))
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue
              ctx.beginPath()
              ctx.lineWidth = dpr
              ctx.strokeStyle = m.kind === 'tap' ? signal : ink3
              ctx.setLineDash(m.kind === 'tap' ? [] : [3 * dpr, 3 * dpr])
              ctx.globalAlpha = m.kind === 'tap' ? 0.8 : 0.7
              ctx.moveTo(x + 0.5, top + (m.kind === 'tap' && showLabels ? 26 * dpr : 0))
              ctx.lineTo(x + 0.5, top + height)
              ctx.stroke()
              ctx.globalAlpha = 1
              if (showLabels && m.kind === 'tap') {
                // Zone index; stagger onto a second row when labels are closer than 40pt.
                const w = ctx.measureText(m.label).width
                const row = x - 2 * dpr > rowsEnd[0]! ? 0 : x - 2 * dpr > rowsEnd[1]! ? 1 : -1
                if (row >= 0) {
                  ctx.fillStyle = signal
                  ctx.fillText(m.label, x - w / 2, top + (row === 0 ? 10 : 22) * dpr)
                  rowsEnd[row] = x + Math.max(w, 40 * dpr)
                }
              }
            }
            ctx.restore()
          }
        ]
      }
    }
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      pxAlign: false,
      cursor: { show: false },
      legend: { show: false },
      select: { show: false, left: 0, top: 0, width: 0, height: 0 },
      scales: { x: { time: false }, y: { auto: true } },
      axes: [
        { show: false },
        {
          stroke: ink3,
          font,
          size: 44,
          gap: 6,
          grid: { stroke: hair, width: 1 },
          ticks: { show: false },
          values: (_u, vals) => vals.map((v) => (Math.abs(v) < 1e-9 ? '0' : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)))
        }
      ],
      series: [
        {},
        { label: 'x', stroke: ink, width: 1, points: { show: false } },
        { label: 'y', stroke: ink2, width: 1, points: { show: false } },
        { label: 'z', stroke: ink3, width: 1, dash: [2, 2], points: { show: false } }
      ],
      plugins: [markerPlugin]
    }
    const u = new uPlot(opts, [[], [], [], []], el)
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      if (pausedRef.current || !buffer.t.length) return
      const s = buffer[pick]
      u.batch(() => {
        u.setData([buffer.t, s[0], s[1], s[2]] as uPlot.AlignedData, false)
        u.setScale('x', { min: buffer.latest - WINDOW_S, max: buffer.latest })
        let lo = Infinity
        let hi = -Infinity
        for (const arr of s)
          for (let i = Math.max(0, arr.length - WINDOW_S * 60); i < arr.length; i++) {
            const v = arr[i]!
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
        const pad = Math.max(0.5, (hi - lo) * 0.15)
        u.setScale('y', { min: lo - pad, max: hi + pad })
      })
    }
    raf = requestAnimationFrame(tick)
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      u.destroy()
    }
  }, [buffer, pick, theme, showLabels])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="absolute inset-0" aria-hidden />
      <span className="num pointer-events-none absolute right-2 bottom-1 text-[10px] text-ink-3">{unit}</span>
    </div>
  )
}

function Legend(): React.JSX.Element {
  const styles: Record<string, string> = { x: 'bg-ink', y: 'bg-ink-2', z: 'border-t border-dashed border-ink-3 bg-transparent' }
  return (
    <span className="num flex items-center gap-3 text-[11px] text-ink-3">
      {(['x', 'y', 'z'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className={`h-px w-3 ${styles[k]}`} />
          {k.toUpperCase()}
        </span>
      ))}
    </span>
  )
}

function Panel({ label, value, unit, children, className }: { label: string; value?: React.ReactNode; unit?: string; children?: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <section className={`flex min-w-0 flex-col px-6 pt-4 pb-5 shadow-[-1px_0_0_var(--hairline)] first:shadow-none ${className ?? ''}`} aria-label={label}>
      <h2 className="label-mono">{label}</h2>
      {value !== undefined && (
        <p className="mt-4 flex items-baseline gap-1">
          <span className="numeral text-[28px]">{value}</span>
          {unit && <span className="num text-[13px] text-ink-3">{unit}</span>}
        </p>
      )}
      {children}
    </section>
  )
}

function LidGauge({ angle }: { angle: number | null }): React.JSX.Element {
  const a = angle ?? 0
  const L = 84
  const hx = 12
  const hy = 58
  const rad = (Math.PI * Math.min(180, a)) / 180
  return (
    <svg viewBox="0 0 140 64" className="mt-3 h-16 w-[140px]" aria-hidden>
      <line x1={hx} y1={hy} x2={hx + 120} y2={hy} stroke="var(--line)" strokeWidth={1.25} strokeLinecap="round" />
      <motion.line
        x1={hx}
        y1={hy}
        animate={{ x2: hx + Math.cos(rad) * L * 0.62, y2: hy - Math.sin(rad) * L * 0.62 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        stroke="var(--ink)"
        strokeWidth={1.25}
        strokeLinecap="round"
      />
      <circle cx={hx} cy={hy} r={2.5} fill="var(--bg)" stroke="var(--ink-2)" />
    </svg>
  )
}

/** One horizontal scale with a tick at the current level. */
function Scale({ value, marks }: { value: number; marks?: { at: number; label: string }[] }): React.JSX.Element {
  return (
    <div className="relative mt-4 h-5">
      <div className="absolute top-2 right-0 left-0 h-px bg-line" />
      {marks?.map((m) => (
        <div key={m.label} className="absolute top-0 flex flex-col items-center" style={{ left: `${Math.min(100, m.at * 100)}%` }}>
          <span className="h-2 w-px bg-ink-3" />
          <span className="tag-mono mt-1 -translate-x-1/2 whitespace-nowrap text-ink-3">{m.label}</span>
        </div>
      ))}
      <motion.div className="absolute top-0.5 h-3 w-px bg-ink" animate={{ left: `${Math.min(100, Math.max(0, value * 100))}%` }} transition={{ type: 'spring', stiffness: 300, damping: 30 }} />
    </div>
  )
}

function AirPanel(): React.JSX.Element {
  const session = useStore((s) => s.sessions.air)
  const [air, setAir] = React.useState<AirMsg | null>(null)
  const [label, setLabel] = React.useState<string | null>(null)
  React.useEffect(() => {
    const unsub = client.subscribe(['air'])
    const offs = [
      client.on('air', (m) => setAir(m.phase === 'ended' ? null : m)),
      client.on('gesture', (g) => {
        if (g.zone === 'air') setLabel(g.gesture.replace(/_/g, ' '))
      })
    ]
    return () => {
      unsub()
      offs.forEach((o) => o())
    }
  }, [])
  React.useEffect(() => {
    if (!label) return
    const t = setTimeout(() => setLabel(null), 1100)
    return () => clearTimeout(t)
  }, [label])
  const active = !!session?.active
  return (
    <Panel label="Hand, camera">
      <div className="relative mt-4 aspect-[4/3] w-full max-w-[140px] rounded-[4px] shadow-[inset_0_0_0_1px_var(--line)]">
        {air?.x !== undefined && air.y !== undefined && (
          <motion.span className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" animate={{ left: `${air.x * 100}%`, top: `${air.y * 100}%` }} transition={{ duration: 0.05 }} />
        )}
        <span className="tag-mono absolute bottom-1.5 left-2 text-ink-3">{label ?? (air ? air.gesture.replace(/_/g, ' ') : active ? 'Watching' : 'Off')}</span>
      </div>
      <div className="mt-3">
        <Button variant="text" size="sm" onClick={() => client.send({ type: active ? 'air_session_stop' : 'air_session_start' })}>
          {active ? `Stop camera, ${Math.round(session!.secondsLeft)}s left` : 'Start a camera session'}
        </Button>
      </div>
    </Panel>
  )
}

export function SensorsScreen(): React.JSX.Element {
  const buffer = React.useMemo(() => new SensorBuffer(), [])
  const theme = useStore((s) => s.resolvedTheme)
  const rejected = useStore((s) => s.rejected)
  const lastRejected = useStore((s) => s.lastRejected)
  const status = useStore((s) => s.status)
  const hello = useStore((s) => s.hello)
  const [lid, setLid] = React.useState<number | null>(null)
  const [light, setLight] = React.useState<number | null>(null)
  const [frozen, setFrozen] = React.useState<'live' | 'frozen'>('live')
  const [rate, setRate] = React.useState(0)

  React.useEffect(() => {
    const unsub = client.subscribe(['imu', 'lid', 'light', 'taps'])
    let n = 0
    const offs = [
      client.on('imu', (m) => {
        buffer.push(m)
        n++
      }),
      client.on('lid', (m) => setLid(m.angle)),
      client.on('light', (m) => setLight(m.value)),
      client.on('tap', (m) => buffer.mark({ t: m.t / 1000, kind: 'tap', label: String(zoneNumber(useStore.getState().config, m.zone) ?? '').padStart(2, '0') })),
      client.on('rejected', (m) => buffer.mark({ t: m.t / 1000, kind: 'rejected', label: REJECT_LABEL[m.reason] }))
    ]
    const timer = setInterval(() => {
      setRate(n)
      n = 0
    }, 1000)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === ' ' && !(e.target as HTMLElement).closest('input,textarea,button,[role=dialog]')) {
        e.preventDefault()
        setFrozen((f) => (f === 'live' ? 'frozen' : 'live'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      unsub()
      offs.forEach((o) => o())
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [buffer])

  const total = Object.values(rejected).reduce((s, v) => s + v, 0)
  const det = status?.detector
  const detMax = det ? Math.max(det.thresholdMg * 1.6, det.level * 1.2, 1) : 1
  const since = lastRejected ? Math.round((Date.now() - lastRejected.at) / 1000) : null

  return (
    <>
      <PageHeader
        title="Sensors"
        subtitle={`${status?.imuHz ?? '...'} Hz · showing ${rate} fps`}
        actions={
          <span className="flex items-center gap-3">
            <span className="num text-[11px] text-ink-3">SPACE</span>
            <Segmented aria-label="Chart" value={frozen} onValueChange={setFrozen} options={[{ value: 'live', label: 'Live' }, { value: 'frozen', label: 'Freeze' }]} />
          </span>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <section className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-2" aria-label="Accelerometer">
          <div className="flex items-center justify-between pb-1">
            <h2 className="label-mono">Accelerometer {hello && !hello.sensors.imu && '(not found)'}</h2>
            <Legend />
          </div>
          <Chart buffer={buffer} pick="a" unit="g" theme={theme} paused={frozen === 'frozen'} showLabels />
        </section>
        <section className="flex min-h-0 flex-1 flex-col px-6 pt-3 pb-3 shadow-[0_-1px_0_var(--hairline)]" aria-label="Gyroscope">
          <div className="flex items-center justify-between pb-1">
            <h2 className="label-mono">Gyroscope {hello && !hello.sensors.gyro && '(not found)'}</h2>
            <span className="num flex items-center gap-4 text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px bg-signal" />
                TAP
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px border-l border-dashed border-ink-3" />
                IGNORED
              </span>
            </span>
          </div>
          <Chart buffer={buffer} pick="g" unit="°/s" theme={theme} paused={frozen === 'frozen'} showLabels={false} />
        </section>
        <div className="grid h-[216px] shrink-0 auto-cols-fr grid-flow-col shadow-[0_-1px_0_var(--hairline)]">
          <Panel label="Lid angle" value={lid === null ? '...' : Math.round(lid)} unit="°">
            <LidGauge angle={lid} />
          </Panel>
          <Panel label="Ambient light" value={light === null ? '...' : Math.round(light * 100)} unit="%">
            <Scale value={light ?? 0} />
          </Panel>
          <Panel label="Tap detector" value={det ? det.level.toFixed(1) : '...'} unit="mg">
            {det && (
              <>
                <Scale
                  value={det.level / detMax}
                  marks={[
                    { at: det.noiseFloorMg / detMax, label: 'floor' },
                    { at: det.thresholdMg / detMax, label: 'tap' }
                  ]}
                />
                <p className="num mt-6 text-[11px] text-ink-3">
                  FLOOR {det.noiseFloorMg.toFixed(1)} &middot; TAP {det.thresholdMg.toFixed(1)}
                </p>
              </>
            )}
          </Panel>
          <Panel label={`Ignored · ${total}`}>
            <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-1">
              {(Object.keys(REJECT_LABEL) as RejectReason[]).map((r) => (
                <div key={r} className="flex items-baseline justify-between text-[12px]">
                  <dt className="text-ink-2">{REJECT_LABEL[r]}</dt>
                  <dd className="num text-ink">{rejected[r]}</dd>
                </div>
              ))}
            </dl>
            {lastRejected && (
              <p className="mt-auto truncate text-[12px] text-ink-3">
                Last: {REJECT_LABEL[lastRejected.reason].toLowerCase()}, {since}s ago
              </p>
            )}
          </Panel>
          {hello?.sensors.camera && <AirPanel />}
        </div>
      </div>
    </>
  )
}
