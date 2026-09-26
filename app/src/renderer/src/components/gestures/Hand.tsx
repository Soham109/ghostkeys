import * as React from 'react'
import { HANDS, type Pose } from './hands'

export interface HandState {
  x: number
  y: number
  /** degrees */
  rot?: number
  scale?: number
  /** Mirror for a left hand. */
  mirror?: boolean
  /** 0 = touching the surface, 1 = lifted. Drives the shadow offset and a slight scale-up. */
  lift?: number
  /** Cross-fade between poses: the weight of each pose in [0, 1]. */
  poses: Partial<Record<Pose, number>>
  opacity?: number
}

/** One line-art hand. Strokes stay a hairline at any size (non-scaling stroke). */
export function Hand({ s, shadow = true }: { s: HandState; shadow?: boolean }): React.JSX.Element {
  const id = React.useId().replace(/:/g, '')
  const lift = s.lift ?? 0
  const sc = (s.scale ?? 1) * (1 + lift * 0.045)
  const t = `translate(${s.x} ${s.y}) rotate(${s.rot ?? 0}) scale(${s.mirror ? -sc : sc} ${sc})`
  const entries = Object.entries(s.poses).filter(([, w]) => (w ?? 0) > 0.001) as [Pose, number][]
  return (
    <g transform={t} opacity={s.opacity ?? 1} pointerEvents="none" mask={`url(#hf${id})`}>
      <defs>
        {/* The arm fades out instead of ending in a cut. */}
        <linearGradient id={`hg${id}`} x1="0" y1="96" x2="0" y2="150" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" />
          <stop offset="1" stopColor="black" />
        </linearGradient>
        <mask id={`hf${id}`} maskUnits="userSpaceOnUse" x={-300} y={-300} width={600} height={500}>
          <rect x={-300} y={-300} width={600} height={500} fill={`url(#hg${id})`} />
        </mask>
      </defs>
      {shadow &&
        entries.map(([p, w]) => (
          <path
            key={`sh-${p}`}
            d={HANDS[p].outline}
            transform={`translate(${2 + lift * 7} ${3 + lift * 12})`}
            fill="var(--ink)"
            fillOpacity={0.05 * w * (1 - lift * 0.4)}
            stroke="none"
          />
        ))}
      {entries.map(([p, w]) => (
        <g key={p} opacity={w}>
          <path d={HANDS[p].outline} fill="var(--bg)" stroke="var(--ink)" strokeWidth={1.1} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {HANDS[p].details.map((d, i) => (
            <path key={i} d={d} fill="none" stroke="var(--ink)" strokeOpacity={0.7} strokeWidth={0.9} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          {HANDS[p].faint?.map((d, i) => (
            <path key={`f${i}`} d={d} fill="none" stroke="var(--ink)" strokeOpacity={0.22} strokeWidth={0.8} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
        </g>
      ))}
    </g>
  )
}

/** Screenshot-only sheet with every pose large, for judging the drawing. */
export function HandSheet(): React.JSX.Element {
  const poses: Pose[] = ['point', 'knuckle', 'flat', 'pinchOpen', 'pinch', 'side']
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg">
      <svg viewBox="0 0 1200 640" className="h-full w-full">
        {poses.map((p, i) => (
          <g key={p}>
            <Hand s={{ x: i < 3 ? 110 + i * 200 : 820 + (i - 3) * 330, y: i < 3 ? 160 : 300, scale: 2, poses: { [p]: 1 }, lift: 0 }} />
            <text x={i < 3 ? 90 + i * 200 : 560 + (i - 3) * 330} y={600} fill="var(--ink-3)" fontSize={16} fontFamily="Geist Mono">
              {p}
            </text>
          </g>
        ))}
      </svg>
    </div>
  )
}
