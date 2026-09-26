import * as React from 'react'
import { useReducedMotion } from 'motion/react'
import { client } from '@/lib/client'
import { useStore, zoneNumber } from '@/lib/store'
import { REJECT_LABEL, type RejectReason } from '@shared/protocol'
import { cn } from '@/lib/utils'

interface Sample {
  t: number
  v: number
}

/**
 * A live acceleration trace: magnitude of the motion sensor minus 1 g, scrolling right to left.
 * Taps are redrawn in --signal with their zone index; ignored bumps get a grey tick below the line.
 * It shows Ghostkeys listening when nothing happens, and why typing does not count.
 */
export function Seismograph({
  seconds = 4,
  height = 40,
  labelRejected = false,
  className
}: {
  seconds?: number
  height?: number
  /** Print the reason (TYPING, TRACKPAD) above each ignored tick. */
  labelRejected?: boolean
  className?: string
}): React.JSX.Element {
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const reduce = useReducedMotion()
  const theme = useStore((s) => s.resolvedTheme)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const samples: Sample[] = []
    const taps: { t: number; idx: number | null; wall: number }[] = []
    const rejects: { t: number; reason: RejectReason; wall: number }[] = []
    let latest = 0
    let wallAtLatest = performance.now()
    const unsub = client.subscribe(['imu', 'taps'])
    const offs = [
      client.on('imu', (m) => {
        const [x, y, z] = m.a
        samples.push({ t: m.t, v: Math.sqrt(x * x + y * y + z * z) - 1 })
        latest = m.t
        wallAtLatest = performance.now()
        const cutoff = m.t - seconds * 1000 - 200
        while (samples.length && samples[0]!.t < cutoff) samples.shift()
      }),
      client.on('tap', (m) => {
        taps.push({ t: m.t, idx: zoneNumber(useStore.getState().config, m.zone), wall: performance.now() })
        if (taps.length > 40) taps.shift()
      }),
      client.on('rejected', (m) => {
        rejects.push({ t: m.t, reason: m.reason, wall: performance.now() })
        if (rejects.length > 80) rejects.shift()
      })
    ]
    const css = getComputedStyle(document.documentElement)
    const ink3 = css.getPropertyValue('--ink-3').trim()
    const line = css.getPropertyValue('--line').trim()
    const signal = css.getPropertyValue('--signal').trim()
    const mono = '10px "Geist Mono", ui-monospace, monospace'

    let raf = 0
    let last = 0
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      if (reduce && now - last < 250) return
      last = now
      const dpr = devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Scroll smoothly between sensor frames.
      const head = latest + Math.min(80, now - wallAtLatest)
      const span = seconds * 1000
      const mid = labelRejected ? h * 0.58 : h * 0.62
      let peak = 0.04
      for (const s of samples) peak = Math.max(peak, Math.abs(s.v))
      const scale = (mid - 12) / peak
      const X = (t: number): number => w - ((head - t) / span) * w
      const Y = (v: number): number => mid - Math.max(-mid + 12, Math.min(mid - 2, v * scale))

      // baseline across the full width, even before data arrives
      ctx.strokeStyle = line
      ctx.globalAlpha = 0.6
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, Math.round(mid) + 0.5)
      ctx.lineTo(w, Math.round(mid) + 0.5)
      ctx.stroke()
      ctx.globalAlpha = 1

      // trace
      ctx.strokeStyle = ink3
      ctx.lineWidth = 1
      ctx.beginPath()
      samples.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(s.v)) : ctx.moveTo(X(s.t), Y(s.v))))
      ctx.stroke()

      // taps: the spike redrawn in signal, with the zone index above it for 1.1 s
      ctx.font = mono
      for (const tap of taps) {
        const x = X(tap.t)
        if (x < -20 || x > w + 20) continue
        ctx.strokeStyle = signal
        ctx.lineWidth = 1.25
        ctx.beginPath()
        let started = false
        for (const s of samples) {
          if (s.t < tap.t - 30 || s.t > tap.t + 140) continue
          if (!started) {
            ctx.moveTo(X(s.t), Y(s.v))
            started = true
          } else ctx.lineTo(X(s.t), Y(s.v))
        }
        ctx.stroke()
        const age = now - tap.wall
        if (age < 1100 && tap.idx) {
          ctx.fillStyle = signal
          ctx.globalAlpha = age > 820 ? (1100 - age) / 280 : 1
          ctx.fillText(String(tap.idx).padStart(2, '0'), x - 6, 10)
          ctx.globalAlpha = 1
        }
      }

      // ignored bumps: a grey tick below the line
      for (const r of rejects) {
        const x = X(r.t)
        if (x < 0 || x > w) continue
        ctx.strokeStyle = ink3
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(Math.round(x) + 0.5, h - 9)
        ctx.lineTo(Math.round(x) + 0.5, h - 3)
        ctx.stroke()
        if (labelRejected && now - r.wall < 1600) {
          ctx.fillStyle = ink3
          ctx.globalAlpha = Math.max(0, 1 - (now - r.wall) / 1600)
          ctx.fillText(REJECT_LABEL[r.reason].toUpperCase(), x + 4, h - 12)
          ctx.globalAlpha = 1
        }
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      offs.forEach((o) => o())
      unsub()
    }
  }, [seconds, labelRejected, reduce, theme])

  return <canvas ref={canvasRef} className={cn('block w-full', className)} style={{ height }} role="img" aria-label="Live motion sensor trace" />
}
