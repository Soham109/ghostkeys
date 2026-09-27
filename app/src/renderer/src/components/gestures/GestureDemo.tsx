import * as React from 'react'
import { useReducedMotion } from 'motion/react'
import type { DeviceFamily, Modifier, Zone } from '@shared/protocol'
import { defaultZones } from '@shared/defaults'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Chassis, normalizeRect } from '../laptop/LaptopMap'
import { toSvg } from '../laptop/geometry'
import { Hand } from './Hand'
import { buildScene, type DemoId, type Frame, type Scene } from './scenes'

export type { DemoId }

/** Advances time for a scene while it is on screen; frozen on its key frame under reduced motion. */
function useSceneTime(scene: Scene, ref: React.RefObject<HTMLElement | null>, paused: boolean): number {
  const reduce = useReducedMotion()
  const [t, setT] = React.useState(scene.still)
  const [visible, setVisible] = React.useState(true)
  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: '80px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  React.useEffect(() => {
    if (reduce || paused || !visible) {
      if (reduce) setT(scene.still)
      return
    }
    let raf = 0
    const start = performance.now()
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop)
      // A short rest after each loop so the eye can reset.
      const period = scene.duration + 0.5
      const tt = ((now - start) / 1000) % period
      setT(Math.min(tt, scene.duration))
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [scene, reduce, paused, visible])
  return reduce ? scene.still : t
}

function Rings({ f }: { f: Frame }): React.JSX.Element {
  return (
    <g pointerEvents="none">
      {f.rings.map((r, i) => {
        const k = Math.min(1, r.age / 0.64)
        const e = 1 - Math.pow(1 - k, 3)
        return (
          <g key={i}>
            <circle cx={r.x} cy={r.y} r={r.r * (0.12 + 0.88 * e)} fill="none" stroke="var(--signal)" strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={1 - k} />
            {r.age > 0.09 && (
              <circle
                cx={r.x}
                cy={r.y}
                r={r.r * (0.12 + 0.88 * (1 - Math.pow(1 - Math.min(1, (r.age - 0.09) / 0.64), 3)))}
                fill="none"
                stroke="var(--signal)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                opacity={0.7 * (1 - Math.min(1, (r.age - 0.09) / 0.64))}
              />
            )}
            <circle cx={r.x} cy={r.y} r={r.r * 0.07} fill="var(--signal)" opacity={r.age < 0.55 ? 1 : Math.max(0, 1 - (r.age - 0.55) / 0.15)} />
          </g>
        )
      })}
    </g>
  )
}

function Trails({ f }: { f: Frame }): React.JSX.Element {
  return (
    <g pointerEvents="none">
      {f.trails.map((tr, i) => (
        <path key={i} d={tr.d} fill="none" stroke="var(--signal)" strokeWidth={1.25} strokeLinecap="round" vectorEffect="non-scaling-stroke" opacity={tr.o * 0.85} />
      ))}
    </g>
  )
}

function TopView({ scene, f, zones }: { scene: Scene; f: Frame; zones: Zone[] }): React.JSX.Element {
  const layout = scene.layout!
  return (
    <>
      <Chassis layout={layout} pxUnit={1e4} drawIn={false} />
      {zones.map((z) => {
        const r = toSvg(layout, z.surface, normalizeRect(z.surface, z.rect))
        const on = f.focus.includes(z.id)
        return (
          <rect
            key={z.id}
            x={r.x}
            y={r.y}
            width={r.w}
            height={r.h}
            rx={10}
            fill={on ? 'var(--zone-fill)' : 'none'}
            stroke={on ? 'var(--ink-2)' : 'var(--ink-3)'}
            strokeOpacity={on ? 1 : 0.35}
            strokeDasharray={on ? undefined : '4 4'}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
      {f.key && (
        <rect
          x={f.key.x}
          y={f.key.y}
          width={f.key.w}
          height={f.key.h}
          rx={2.4}
          fill="var(--ink)"
          fillOpacity={0.14 * f.key.v}
          stroke="var(--ink)"
          strokeOpacity={0.3 + 0.7 * f.key.v}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <Trails f={f} />
      <Rings f={f} />
      {f.hands.map((h, i) => (
        <Hand key={i} s={h} />
      ))}
    </>
  )
}

function SideView({ f }: { f: Frame }): React.JSX.Element {
  const lidAng = 110 + (f.lid ?? 0)
  const rad = (lidAng * Math.PI) / 180
  const tip = { x: 300 - Math.cos(rad) * 150, y: 196 - Math.sin(rad) * 150 }
  const sonar = f.sonar
  return (
    <>
      {/* desk */}
      <line x1={20} x2={380} y1={211} y2={211} stroke="var(--line)" strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
      {/* base, side profile: front lip at the left, hinge at the right */}
      <path d="M 64 196 L 302 192 C 306 192 308 195 308 198 L 308 202 C 308 205 306 207 303 207 L 66 208 C 62 208 60 206 60 202 L 60 200 C 60 198 61.6 196.2 64 196 Z" className="contour" fill="var(--bg)" />
      {/* keys, barely raised */}
      <path d="M 96 195.4 L 250 193" className="detail" strokeDasharray="7 3" />
      {/* lid */}
      <g>
        <line x1={300} y1={196} x2={tip.x} y2={tip.y} stroke="var(--line)" strokeWidth={6} strokeLinecap="round" />
        <line x1={300} y1={196} x2={tip.x} y2={tip.y} stroke="var(--bg)" strokeWidth={3.8} strokeLinecap="round" />
      </g>
      {f.level !== undefined && (
        <g>
          <line x1={30} x2={30} y1={70} y2={190} stroke="var(--hairline-strong)" strokeWidth={2} strokeLinecap="round" />
          <line x1={30} x2={30} y1={190} y2={190 - f.level * 120} stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" />
          <text x={30} y={60} textAnchor="middle" fontSize={9} fill="var(--ink-3)" fontFamily="Geist Mono" letterSpacing="0.08em">
            {Math.round(f.level * 100)}
          </text>
        </g>
      )}
      {/* the inaudible pilot tone: arcs rising from the speaker */}
      {sonar !== undefined &&
        [0, 1, 2].map((i) => {
          const k = ((sonar * 0.9 + i / 3) % 1 + 1) % 1
          return (
            <path
              key={i}
              d={`M ${232 - k * 40} ${186 - k * 26} Q 262 ${176 - k * 60} ${292 + k * 40} ${186 - k * 26}`}
              fill="none"
              stroke="var(--ink-3)"
              strokeOpacity={0.55 * (1 - k)}
              vectorEffect="non-scaling-stroke"
            />
          )
        })}
      <Trails f={f} />
      <Rings f={f} />
      {f.hands.map((h, i) => (
        <Hand key={i} s={h} />
      ))}
    </>
  )
}

function FrontView({ f }: { f: Frame }): React.JSX.Element {
  const roll = f.roll ?? 0
  return (
    <g transform={`rotate(${roll} 200 120)`}>
      <line x1={10} x2={390} y1={206} y2={206} stroke="var(--line)" strokeOpacity={roll ? 0 : 0.5} vectorEffect="non-scaling-stroke" />
      {/* lid, seen from the front */}
      <rect x={66} y={24} width={268} height={170} rx={10} className="contour" fill="var(--bg-sunken)" />
      <rect x={74} y={32} width={252} height={154} rx={4} className="detail" fill="var(--bg)" fillOpacity={1 - (f.dim ?? 0) * 0.6} />
      {/* camera housing, camera, light sensor */}
      <rect x={186} y={24} width={28} height={9} rx={4} className="detail" fill="var(--bg-sunken)" />
      <circle cx={200} cy={28.5} r={2} fill={f.camera ? 'var(--ink)' : 'none'} className="detail" />
      <circle cx={212} cy={28.5} r={1.1} fill="var(--ink-3)" />
      {/* base */}
      <path d="M 52 196 L 348 196 L 356 204 C 356 206 355 207 353 207 L 47 207 C 45 207 44 206 44 204 Z" className="contour" fill="var(--bg)" />
      {f.dial !== undefined && (
        <g>
          <circle cx={112} cy={108} r={22} fill="none" stroke="var(--hairline-strong)" strokeWidth={2} />
          <circle
            cx={112}
            cy={108}
            r={22}
            fill="none"
            stroke="var(--ink)"
            strokeWidth={2}
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - f.dial}
            transform="rotate(135 112 108)"
            strokeLinecap="round"
          />
          <text x={112} y={112} textAnchor="middle" fontSize={11} fill="var(--ink-2)" fontFamily="Geist Mono">
            {Math.round(f.dial * 100)}
          </text>
        </g>
      )}
      {f.zoom !== undefined && (
        <rect
          x={200 - (30 + f.zoom * 50)}
          y={108 - (18 + f.zoom * 30)}
          width={(30 + f.zoom * 50) * 2}
          height={(18 + f.zoom * 30) * 2}
          rx={3}
          fill="none"
          stroke="var(--ink-3)"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {f.cursor && <circle cx={f.cursor.x} cy={f.cursor.y} r={3} fill="var(--ink)" />}
      <Trails f={f} />
      <Rings f={f} />
      {f.hands.map((h, i) => (
        <Hand key={i} s={h} />
      ))}
      {f.hold !== undefined && f.hold > 0 && (
        <circle
          cx={212}
          cy={30}
          r={16}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.25}
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - f.hold}
          transform="rotate(-90 212 30)"
        />
      )}
    </g>
  )
}

export interface GestureDemoProps {
  gesture: DemoId
  zone?: string | null
  pair?: [string, string] | null
  modifiers?: Modifier[]
  family?: DeviceFamily
  zones?: Zone[]
  paused?: boolean
  className?: string
  /** Accessible description. Defaults to the gesture id. */
  label?: string
  /** Freeze on this time (seconds). */
  at?: number
}

/** A looping, hand-drawn demonstration of one gesture on a small drawing of this Mac. */
export function GestureDemo({ gesture, zone, pair, modifiers, family, zones, paused, className, label, at }: GestureDemoProps): React.JSX.Element {
  const hello = useStore((s) => s.hello)
  const configZones = useStore((s) => s.config?.zones)
  const fam = family ?? hello?.device.family ?? 'macbook-pro-14'
  const zs = zones ?? configZones ?? defaultZones(fam)
  const scene = React.useMemo(
    () => buildScene(gesture, { family: fam, zones: zs, zone, pair, modifiers }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gesture, fam, zs, zone, pair?.[0], pair?.[1], modifiers?.join()]
  )
  const ref = React.useRef<HTMLDivElement>(null)
  const live = useSceneTime(scene, ref, !!paused || at !== undefined)
  const f = scene.frame(at ?? live)
  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)} role="img" aria-label={label ?? `How to do ${gesture.replace(/_/g, ' ')}`}>
      <svg viewBox={scene.viewBox.join(' ')} className="laptop-map block h-full w-full" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {scene.view === 'top' && <TopView scene={scene} f={f} zones={zs} />}
        {scene.view === 'side' && <SideView f={f} />}
        {scene.view === 'front' && <FrontView f={f} />}
      </svg>
    </div>
  )
}
