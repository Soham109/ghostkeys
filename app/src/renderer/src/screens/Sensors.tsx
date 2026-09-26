import * as React from 'react'
import uPlot from 'uplot'
import { motion } from 'motion/react'
import { REJECT_LABEL, type ImuMsg, type RejectReason } from '@shared/protocol'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/Page'
import { Segmented } from '@/components/ui/controls'

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

function Chart({
  buffer,
  pick,
  unit,
  range,
  theme,
  paused,
  showLabels,
  names
}: {
  buffer: SensorBuffer
  showLabels: boolean
  names: Record<string, string>
  pick: 'a' | 'g'
  unit: string
  range: [number, number] | null
  theme: string
  paused: boolean
}): React.JSX.Element {
  const ref = React.useRef<HTMLDivElement>(null)
  const pausedRef = React.useRef(paused)
  React.useEffect(() => {
    pausedRef.current = paused
  }, [paused])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const ink3 = cssVar('--ink-3')
    const hair = cssVar('--hairline')
    const signal = cssVar('--signal')
    const colors = [cssVar('--series-x'), cssVar('--series-y'), cssVar('--series-z')]
    const font = '10px "Geist Mono", ui-monospace, monospace'
    const markerPlugin: uPlot.Plugin = {
      hooks: {
        draw: [
          (u) => {
            const ctx = u.ctx
            const { top, height } = u.bbox
            ctx.save()
            ctx.font = `${10 * devicePixelRatio}px "Geist Mono", ui-monospace, monospace`
            let lastLabelX = -Infinity
            for (const m of buffer.markers) {
              const x = Math.round(u.valToPos(m.t, 'x', true))
              if (x < u.bbox.left || x > u.bbox.left + u.bbox.width) continue
              ctx.beginPath()
              ctx.lineWidth = devicePixelRatio
              ctx.globalAlpha = m.kind === 'tap' ? 0.7 : 1
              if (m.kind === 'tap') {
                ctx.strokeStyle = signal
                ctx.setLineDash([])
              } else {
                ctx.strokeStyle = ink3
                ctx.setLineDash([3 * devicePixelRatio, 3 * devicePixelRatio])
              }
              ctx.moveTo(x + 0.5, top)
              ctx.lineTo(x + 0.5, top + height)
              ctx.stroke()
              ctx.globalAlpha = 1
              if (showLabels) {
                const text = (m.kind === 'tap' ? (names[m.label] ?? m.label) : m.label).toUpperCase()
                const w = ctx.measureText(text).width
                if (x > lastLabelX + 8 * devicePixelRatio) {
                  ctx.fillStyle = m.kind === 'tap' ? signal : ink3
                  ctx.fillText(text, x + 4 * devicePixelRatio, top + 11 * devicePixelRatio)
                  lastLabelX = x + w + 4 * devicePixelRatio
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
      scales: {
        x: { time: false },
        y: range ? { auto: false, range } : { auto: true }
      },
      axes: [
        { show: false },
        {
          stroke: ink3,
          font,
          size: 44,
          gap: 6,
          grid: { stroke: hair, width: 1 },
          ticks: { show: false },
          values: (_u, vals) =>
            vals.map((v) => (Math.abs(v) < 1e-9 ? '0' : Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 2 : 1)))
        }
      ],
      series: [{}, ...['x', 'y', 'z'].map((label, i) => ({ label, stroke: colors[i], width: 1.25, points: { show: false } }))],
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
        if (!range) {
          let lo = Infinity
          let hi = -Infinity
          for (const arr of s) for (let i = Math.max(0, arr.length - WINDOW_S * 60); i < arr.length; i++) {
            const v = arr[i]!
            if (v < lo) lo = v
            if (v > hi) hi = v
          }
          const pad = Math.max(0.5, (hi - lo) * 0.15)
          u.setScale('y', { min: lo - pad, max: hi + pad })
        }
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
  }, [buffer, pick, range, theme, showLabels, names])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="absolute inset-0" aria-hidden />
      <span className="pointer-events-none absolute right-2 bottom-1 font-mono text-[10px] text-ink-3">{unit}</span>
    </div>
  )
}

function Legend(): React.JSX.Element {
  return (
    <span className="flex items-center gap-3 font-mono text-[11px] text-ink-3">
      {(['x', 'y', 'z'] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5">
          <span className="h-[2px] w-3 rounded-full" style={{ background: `var(--series-${k})` }} />
          {k.toUpperCase()}
        </span>
      ))}
    </span>
  )
}

function LidGauge({ angle }: { angle: number | null }): React.JSX.Element {
  const a = angle ?? 0
  const L = 96
  const hx = 24
  const hy = 104
  const rad = (Math.PI * a) / 180
  const arcR = 34
  const ax = hx + Math.cos(rad) * arcR
  const ay = hy - Math.sin(rad) * arcR
  return (
    <div className="flex items-end gap-6">
      <svg viewBox="0 0 150 116" className="h-[116px] w-[150px]" aria-hidden>
        <line x1={hx} y1={hy} x2={hx + 118} y2={hy} stroke="var(--ink-3)" strokeWidth={3} strokeLinecap="round" />
        <path d={`M ${hx + arcR} ${hy} A ${arcR} ${arcR} 0 ${a > 180 ? 1 : 0} 0 ${ax} ${ay}`} fill="none" stroke="var(--hairline-strong)" strokeDasharray="2 3" />
        <motion.line
          x1={hx}
          y1={hy}
          animate={{ x2: hx + Math.cos(rad) * L, y2: hy - Math.sin(rad) * L }}
          transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
          stroke="var(--ink)"
          strokeWidth={3}
          strokeLinecap="round"
        />
        <circle cx={hx} cy={hy} r={3} fill="var(--bg)" stroke="var(--ink-2)" />
      </svg>
      <div className="pb-1">
        <span className="num text-[28px] leading-none font-medium tracking-[-0.02em]">{angle === null ? '...' : Math.round(a)}</span>
        <span className="ml-0.5 text-[15px] text-ink-3">°</span>
      </div>
    </div>
  )
}

function LightMeter({ value }: { value: number | null }): React.JSX.Element {
  const v = value ?? 0
  const N = 28
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 items-end gap-[3px]" aria-hidden>
        {Array.from({ length: N }, (_, i) => {
          const on = i < Math.round(v * N)
          return (
            <span
              key={i}
              className={cn('w-[5px] rounded-[1px] transition-colors duration-150', on ? 'bg-ink' : 'bg-hairline-strong')}
              style={{ height: `${30 + (i / N) * 70}%` }}
            />
          )
        })}
      </div>
      <div>
        <span className="num text-[28px] leading-none font-medium tracking-[-0.02em]">{value === null ? '...' : Math.round(v * 100)}</span>
        <span className="ml-0.5 text-[15px] text-ink-3">%</span>
      </div>
    </div>
  )
}

export function SensorsScreen(): React.JSX.Element {
  const buffer = React.useMemo(() => new SensorBuffer(), [])
  const theme = useStore((s) => s.resolvedTheme)
  const rejected = useStore((s) => s.rejected)
  const status = useStore((s) => s.status)
  const hello = useStore((s) => s.hello)
  const zones = useStore((s) => s.config?.zones)
  const names = React.useMemo(() => Object.fromEntries((zones ?? []).map((z) => [z.id, z.name])), [zones])
  const [lid, setLid] = React.useState<number | null>(null)
  const [light, setLight] = React.useState<number | null>(null)
  const [recent, setRecent] = React.useState<{ id: number; reason: RejectReason; at: number }[]>([])
  const [frozen, setFrozen] = React.useState<'live' | 'frozen'>('live')
  const [rate, setRate] = React.useState(0)

  React.useEffect(() => {
    const unsub = client.subscribe(['imu', 'lid', 'light', 'taps'])
    let n = 0
    let seq = 0
    const offs = [
      client.on('imu', (m) => {
        buffer.push(m)
        n++
      }),
      client.on('lid', (m) => setLid(m.angle)),
      client.on('light', (m) => setLight(m.value)),
      client.on('tap', (m) => buffer.mark({ t: m.t / 1000, kind: 'tap', label: m.zone })),
      client.on('rejected', (m) => {
        buffer.mark({ t: m.t / 1000, kind: 'rejected', label: REJECT_LABEL[m.reason] })
        setRecent((r) => [{ id: ++seq, reason: m.reason, at: m.t }, ...r].slice(0, 6))
      })
    ]
    const timer = setInterval(() => {
      setRate(n)
      n = 0
    }, 1000)
    return () => {
      unsub()
      offs.forEach((o) => o())
      clearInterval(timer)
    }
  }, [buffer])

  const total = Object.values(rejected).reduce((s, v) => s + v, 0)

  return (
    <>
      <PageHeader
        title="Sensors"
        subtitle={`${rate} samples per second shown, ${status?.imuHz ?? '...'} Hz read`}
        actions={<Segmented aria-label="Chart" value={frozen} onValueChange={setFrozen} options={[{ value: 'live', label: 'Live' }, { value: 'frozen', label: 'Freeze' }]} />}
      />
      <div className="flex min-h-0 flex-1 flex-col shadow-[0_-1px_0_var(--hairline)]">
        <section className="flex min-h-0 flex-1 flex-col px-6 pt-4 pb-2" aria-label="Accelerometer">
          <div className="flex items-center justify-between pb-1">
            <h2 className="label-mono">Accelerometer {hello && !hello.sensors.imu && '(not found)'}</h2>
            <Legend />
          </div>
          <Chart buffer={buffer} pick="a" unit="g" range={null} theme={theme} paused={frozen === 'frozen'} showLabels names={names} />
        </section>
        <section className="flex min-h-0 flex-1 flex-col px-6 pt-3 pb-3 shadow-[0_-1px_0_var(--hairline)]" aria-label="Gyroscope">
          <div className="flex items-center justify-between pb-1">
            <h2 className="label-mono">Gyroscope {hello && !hello.sensors.gyro && '(not found)'}</h2>
            <span className="flex items-center gap-4 font-mono text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px bg-signal" />
                Tap
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-px border-l border-dashed border-ink-3" />
                Rejected
              </span>
            </span>
          </div>
          <Chart buffer={buffer} pick="g" unit="°/s" range={null} theme={theme} paused={frozen === 'frozen'} showLabels={false} names={names} />
        </section>
        <div className="grid h-[212px] shrink-0 grid-cols-3 shadow-[0_-1px_0_var(--hairline)]">
          <section className="flex flex-col justify-between px-6 py-4" aria-label="Lid angle">
            <h2 className="label-mono">Lid angle</h2>
            <LidGauge angle={lid} />
          </section>
          <section className="flex flex-col justify-between px-6 py-4 shadow-[-1px_0_0_var(--hairline)]" aria-label="Light level">
            <h2 className="label-mono">Ambient light</h2>
            <LightMeter value={light} />
          </section>
          <section className="flex min-w-0 flex-col px-6 py-4 shadow-[-1px_0_0_var(--hairline)]" aria-label="Rejected events">
            <div className="flex items-baseline justify-between">
              <h2 className="label-mono">Ignored</h2>
              <span className="num text-[11px] text-ink-3">{total} total</span>
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
              {(Object.keys(REJECT_LABEL) as RejectReason[]).map((r) => (
                <div key={r} className="flex items-baseline justify-between text-[12px]">
                  <dt className="text-ink-2">{REJECT_LABEL[r]}</dt>
                  <dd className="num text-ink">{rejected[r]}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-auto truncate text-[12px] text-ink-3">
              {recent[0] ? `Last: ${REJECT_LABEL[recent[0].reason].toLowerCase()} at ${(recent[0].at / 1000).toFixed(1)} s` : 'Nothing ignored yet.'}
            </p>
          </section>
        </div>
      </div>
    </>
  )
}
