import * as React from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { DeviceFamily, Rect, Surface, TapMsg, Zone } from '@shared/protocol'
import { SURFACE_LABEL } from '@shared/protocol'
import { obstacles, rectsOverlap } from '@shared/laptop'
import { client } from '@/lib/client'
import { clamp, cn } from '@/lib/utils'
import { keyboardKeys, layoutFor, pointToSvg, toSvg, type Layout } from './geometry'

type Mode = 'live' | 'edit' | 'calibrate' | 'static'

export interface LaptopMapProps {
  family: DeviceFamily
  zones: Zone[]
  mode?: Mode
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  onZoneChange?: (id: string, rect: Rect) => void
  /** Calibration target: this zone is lit, the rest recede. */
  focusId?: string | null
  /** Zones drawn but dimmed (for example, not picked for calibration). */
  mutedIds?: string[]
  /** Show taps from the daemon as rings. */
  listenTaps?: boolean
  /** Only show taps for this zone (calibration). */
  tapFilter?: string | null
  showLabels?: boolean
  className?: string
  /** Extra svg content drawn above the zones, in svg units. */
  overlay?: (layout: Layout) => React.ReactNode
}

interface Ripple {
  id: number
  x: number
  y: number
  zone: string
}

let rippleSeq = 0

function useSvgScale(ref: React.RefObject<SVGSVGElement | null>, vbW: number, vbH: number): number {
  const [scale, setScale] = React.useState(0.7)
  React.useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width && r.height) setScale(Math.min(r.width / vbW, r.height / vbH))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, vbW, vbH])
  return scale
}

// ---------------------------------------------------------------- static drawing

const Chassis = React.memo(function Chassis({ layout, pxUnit }: { layout: Layout; pxUnit: number }): React.JSX.Element {
  const { spec, surfaces, corner } = layout
  const base = surfaces.base
  const lid = surfaces.lid
  const keys = React.useMemo(() => keyboardKeys(toSvg(layout, 'base', spec.keyboard)), [layout, spec.keyboard])
  const tp = toSvg(layout, 'base', spec.trackpad)
  const notchW = spec.notch * base.w
  const notchX = base.x + (base.w - notchW) / 2
  const by = base.y + base.h
  const nd = 7 // notch depth
  const baseD = [
    `M ${base.x + corner} ${base.y}`,
    `H ${base.x + base.w - corner}`,
    `Q ${base.x + base.w} ${base.y} ${base.x + base.w} ${base.y + corner}`,
    `V ${by - corner}`,
    `Q ${base.x + base.w} ${by} ${base.x + base.w - corner} ${by}`,
    `H ${notchX + notchW}`,
    `C ${notchX + notchW - 8} ${by} ${notchX + notchW - 6} ${by - nd} ${notchX + notchW - 20} ${by - nd}`,
    `H ${notchX + 20}`,
    `C ${notchX + 6} ${by - nd} ${notchX + 8} ${by} ${notchX} ${by}`,
    `H ${base.x + corner}`,
    `Q ${base.x} ${by} ${base.x} ${by - corner}`,
    `V ${base.y + corner}`,
    `Q ${base.x} ${base.y} ${base.x + corner} ${base.y}`,
    'Z'
  ].join(' ')

  const bezel = 7 * 3
  const display = { x: lid.x + bezel, y: lid.y + bezel * 0.55, w: lid.w - bezel * 2, h: lid.h - bezel * 0.9 }
  const camW = lid.w * 0.075
  const camX = lid.x + (lid.w - camW) / 2
  const labelSize = 10.5 / pxUnit
  const railLabel = (s: Surface): React.ReactNode => {
    const r = surfaces[s]
    const text = SURFACE_LABEL[s]
    if (s === 'front') {
      return (
        <text x={r.x + r.w / 2} y={r.y + r.h + labelSize * 1.6} textAnchor="middle" className="label-svg" fontSize={labelSize}>
          {text.toUpperCase()}
        </text>
      )
    }
    const x = s === 'edge-left' ? r.x - labelSize * 0.9 : r.x + r.w + labelSize * 0.9
    const y = r.y + r.h / 2
    return (
      <text x={x} y={y} textAnchor="middle" className="label-svg" fontSize={labelSize} transform={`rotate(${s === 'edge-left' ? -90 : 90} ${x} ${y})`}>
        {text.toUpperCase()}
      </text>
    )
  }

  return (
    <g className="chassis" fill="none" strokeLinejoin="round">
      <defs>
        <pattern id="grille-dots" width={4.2} height={4.2} patternUnits="userSpaceOnUse">
          <circle cx={2.1} cy={2.1} r={0.85} fill="var(--ink-3)" opacity={0.75} />
        </pattern>
        <radialGradient id="lid-glow" cx="50%" cy="0%" r="90%">
          <stop offset="0%" stopColor="var(--ink)" stopOpacity={0.05} />
          <stop offset="100%" stopColor="var(--ink)" stopOpacity={0} />
        </radialGradient>
      </defs>

      {/* lid, opened back and foreshortened */}
      <rect x={lid.x} y={lid.y} width={lid.w} height={lid.h} rx={corner * 0.9} className="stroke-strong" fill="var(--bg-sunken)" />
      <rect x={display.x} y={display.y} width={display.w} height={display.h} rx={6} className="stroke-faint" fill="url(#lid-glow)" />
      <path
        d={`M ${camX} ${display.y} h ${camW} v ${bezel * 0.35} q 0 6 -6 6 h ${-(camW - 12)} q -6 0 -6 -6 Z`}
        className="stroke-faint"
        fill="var(--bg-sunken)"
      />
      <circle cx={camX + camW / 2} cy={display.y + bezel * 0.22} r={2.4} className="stroke-faint" />
      {/* ambient light sensor, beside the camera */}
      <circle cx={camX + camW / 2 + 12} cy={display.y + bezel * 0.22} r={1.3} fill="var(--ink-3)" />

      {/* hinge */}
      <line x1={base.x + corner} x2={base.x + base.w - corner} y1={layout.hingeY} y2={layout.hingeY} className="stroke-faint" strokeDasharray="2 5" />

      {/* top case */}
      <path d={baseD} className="stroke-strong" fill="var(--bg)" />

      {spec.grilles?.map((g, i) => {
        const r = toSvg(layout, 'base', g)
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={3} fill="url(#grille-dots)" />
      })}

      <g className="stroke-keys">
        {keys.map((k, i) => (
          <rect key={i} x={k.x} y={k.y} width={k.w} height={k.h} rx={2.6} />
        ))}
      </g>

      <rect x={tp.x} y={tp.y} width={tp.w} height={tp.h} rx={10} className="stroke-faint" fill="var(--fill)" />
      <text x={tp.x + tp.w / 2} y={tp.y + tp.h / 2 + labelSize * 0.35} textAnchor="middle" className="label-svg" fontSize={labelSize}>
        TRACKPAD
      </text>

      {/* edges and the front lip, unfolded */}
      {(['edge-left', 'edge-right', 'front'] as Surface[]).map((s) => {
        const r = surfaces[s]
        return (
          <g key={s}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={Math.min(r.w, r.h) / 2} className="stroke-faint" fill="var(--fill)" />
            {railLabel(s)}
          </g>
        )
      })}
      <text x={lid.x + lid.w / 2} y={lid.y - labelSize * 0.8} textAnchor="middle" className="label-svg" fontSize={labelSize}>
        LID
      </text>
    </g>
  )
})

// ---------------------------------------------------------------- zones

const SNAP = 0.01
const EDGE_SNAP = 0.012
const MIN = 0.03

function snapRect(r: Rect, others: Rect[]): Rect {
  const snap = (v: number): number => Math.round(v / SNAP) * SNAP
  let { x, y } = r
  const { w, h } = r
  x = snap(x)
  y = snap(y)
  for (const o of others) {
    for (const [edge, target] of [
      [x, o.x + o.w],
      [x + w, o.x]
    ] as const) {
      if (Math.abs(edge - target) < EDGE_SNAP) x += target - edge
    }
    for (const [edge, target] of [
      [y, o.y + o.h],
      [y + h, o.y]
    ] as const) {
      if (Math.abs(edge - target) < EDGE_SNAP) y += target - edge
    }
  }
  return { x, y, w, h }
}

const round = (r: Rect): Rect => ({
  x: Math.round(r.x * 1000) / 1000,
  y: Math.round(r.y * 1000) / 1000,
  w: Math.round(r.w * 1000) / 1000,
  h: Math.round(r.h * 1000) / 1000
})

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

export function LaptopMap({
  family,
  zones,
  mode = 'static',
  selectedId,
  onSelect,
  onZoneChange,
  focusId,
  mutedIds,
  listenTaps,
  tapFilter,
  showLabels = true,
  className,
  overlay
}: LaptopMapProps): React.JSX.Element {
  const layout = React.useMemo(() => layoutFor(family), [family])
  const svgRef = React.useRef<SVGSVGElement>(null)
  const pxUnit = useSvgScale(svgRef, layout.vbW, layout.vbH)
  const reduce = useReducedMotion()
  const [ripples, setRipples] = React.useState<Ripple[]>([])
  const [flash, setFlash] = React.useState<Record<string, number>>({})
  const [hover, setHover] = React.useState<string | null>(null)
  const zonesRef = React.useRef(zones)
  React.useEffect(() => {
    zonesRef.current = zones
  }, [zones])

  // live taps
  React.useEffect(() => {
    if (!listenTaps) return
    return client.on('tap', (t: TapMsg) => {
      if (tapFilter && t.zone !== tapFilter) return
      const zone = zonesRef.current.find((z) => z.id === t.zone)
      if (!zone) return
      const r = zone.rect
      const inside = t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h
      const p = inside
        ? pointToSvg(layout, zone.surface, t.x, t.y)
        : pointToSvg(layout, zone.surface, r.x + r.w / 2, r.y + r.h / 2)
      const id = ++rippleSeq
      setRipples((rs) => [...rs.slice(-8), { id, x: p.x, y: p.y, zone: zone.id }])
      setFlash((f) => ({ ...f, [zone.id]: id }))
      setTimeout(() => setRipples((rs) => rs.filter((x) => x.id !== id)), 700)
    })
  }, [listenTaps, tapFilter, layout])

  // dragging
  const drag = React.useRef<{ id: string; handle: Handle; start: { x: number; y: number }; orig: Rect; surface: Surface } | null>(null)

  const svgPoint = (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return { x: p.x, y: p.y }
  }

  const tryApply = React.useCallback(
    (id: string, next: Rect): boolean => {
      const zone = zonesRef.current.find((z) => z.id === id)
      if (!zone || !onZoneChange) return false
      const others = zonesRef.current.filter((z) => z.id !== id && z.surface === zone.surface).map((z) => z.rect)
      const blocked = [...others, ...obstacles(layout.spec, zone.surface)]
      if (blocked.some((o) => rectsOverlap(next, o))) return false
      onZoneChange(id, round(next))
      return true
    },
    [layout.spec, onZoneChange]
  )

  const onPointerDown = (e: React.PointerEvent, zone: Zone, handle: Handle): void => {
    if (mode !== 'edit') return
    e.stopPropagation()
    onSelect?.(zone.id)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    drag.current = { id: zone.id, handle, start: svgPoint(e), orig: { ...zone.rect }, surface: zone.surface }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = svgPoint(e)
    const s = layout.surfaces[d.surface]
    const dx = (p.x - d.start.x) / s.w
    const dy = (p.y - d.start.y) / s.h
    const o = d.orig
    const thinX = d.surface.startsWith('edge')
    const thinY = d.surface === 'front'
    let x = o.x
    let y = o.y
    let w = o.w
    let h = o.h
    const hd = d.handle
    if (hd === 'move') {
      x = o.x + dx
      y = o.y + dy
    }
    if (hd.includes('w')) {
      x = Math.min(o.x + dx, o.x + o.w - MIN)
      w = o.x + o.w - x
    }
    if (hd.includes('e')) w = Math.max(MIN, o.w + dx)
    if (hd.includes('n')) {
      y = Math.min(o.y + dy, o.y + o.h - MIN)
      h = o.y + o.h - y
    }
    if (hd.includes('s')) h = Math.max(MIN, o.h + dy)
    if (thinX) {
      x = 0
      w = 1
    }
    if (thinY) {
      y = 0
      h = 1
    }
    w = Math.min(w, 1)
    h = Math.min(h, 1)
    x = clamp(x, 0, 1 - w)
    y = clamp(y, 0, 1 - h)
    const zone = zonesRef.current.find((z) => z.id === d.id)!
    const others = zonesRef.current.filter((z) => z.id !== d.id && z.surface === zone.surface).map((z) => z.rect)
    let next = { x, y, w, h }
    if (hd === 'move') next = snapRect(next, [...others, ...obstacles(layout.spec, zone.surface)])
    else {
      const snap = (v: number): number => Math.round(v / SNAP) * SNAP
      const x2 = snap(next.x + next.w)
      const y2 = snap(next.y + next.h)
      next = { x: snap(next.x), y: snap(next.y), w: 0, h: 0 }
      next.w = Math.max(MIN, x2 - next.x)
      next.h = Math.max(MIN, y2 - next.y)
      if (thinX) next = { ...next, x: 0, w: 1 }
      if (thinY) next = { ...next, y: 0, h: 1 }
    }
    next.x = clamp(next.x, 0, 1 - next.w)
    next.y = clamp(next.y, 0, 1 - next.h)
    tryApply(d.id, next)
  }

  const onPointerUp = (): void => {
    drag.current = null
  }

  const onKeyDown = (e: React.KeyboardEvent, zone: Zone): void => {
    if (mode !== 'edit') {
      if ((e.key === 'Enter' || e.key === ' ') && onSelect) {
        e.preventDefault()
        onSelect(zone.id)
      }
      return
    }
    const step = e.shiftKey ? 0.05 : 0.01
    const map: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const mv = map[e.key]
    if (!mv) return
    e.preventDefault()
    const r = zone.rect
    const next = e.altKey
      ? { ...r, w: clamp(r.w + mv[0], MIN, 1 - r.x), h: clamp(r.h + mv[1], MIN, 1 - r.y) }
      : { ...r, x: clamp(r.x + mv[0], 0, 1 - r.w), y: clamp(r.y + mv[1], 0, 1 - r.h) }
    tryApply(zone.id, next)
  }

  const px = (n: number): number => n / pxUnit
  const handleSize = px(8)
  const fontSize = px(11)

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${layout.vbW} ${layout.vbH}`}
      className={cn('laptop-map block h-full w-full overflow-visible', className)}
      preserveAspectRatio="xMidYMid meet"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerDown={() => mode === 'edit' && onSelect?.(null)}
      role="img"
      aria-label="Top-down drawing of your MacBook with its zones"
    >
      <Chassis layout={layout} pxUnit={pxUnit} />

      {zones.map((zone) => {
        const r = toSvg(layout, zone.surface, zone.rect)
        const selected = selectedId === zone.id
        const focused = focusId === zone.id
        const muted = (focusId && !focused) || mutedIds?.includes(zone.id)
        const interactive = mode === 'edit' || (mode === 'live' && !!onSelect)
        const isHover = hover === zone.id
        const rx = Math.min(px(5), r.w / 2, r.h / 2)
        const vertical = r.h > r.w * 1.6
        const narrow = r.w * pxUnit < 44 || r.h * pxUnit < 18
        const rail = zone.surface !== 'base' && zone.surface !== 'lid'
        const fillOpacity = focused ? 0.14 : selected ? 0.12 : isHover ? 0.1 : 0.045
        return (
          <g
            key={zone.id}
            className={cn('zone', interactive && 'cursor-pointer', mode === 'edit' && 'cursor-grab active:cursor-grabbing')}
            opacity={muted ? 0.28 : 1}
            style={{ transition: 'opacity 280ms var(--ease-snap)' }}
            onPointerEnter={() => setHover(zone.id)}
            onPointerLeave={() => setHover((h) => (h === zone.id ? null : h))}
            onPointerDown={(e) => {
              if (mode === 'edit') onPointerDown(e, zone, 'move')
              else if (onSelect) {
                e.stopPropagation()
                onSelect(zone.id)
              }
            }}
            onKeyDown={(e) => onKeyDown(e, zone)}
            tabIndex={interactive ? 0 : -1}
            role={interactive ? 'button' : undefined}
            aria-label={interactive ? `${zone.name}, ${SURFACE_LABEL[zone.surface]}` : undefined}
            aria-pressed={interactive ? selected : undefined}
          >
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={rx}
              fill={zone.color}
              fillOpacity={fillOpacity}
              stroke={selected || focused ? 'var(--ink)' : zone.color}
              strokeOpacity={selected || focused ? 0.9 : 0.5}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ transition: 'fill-opacity 160ms var(--ease-snap), stroke 160ms var(--ease-snap)' }}
            />
            <AnimatePresence>
              {flash[zone.id] && (
                <motion.rect
                  key={flash[zone.id]}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  rx={rx}
                  fill="var(--signal)"
                  initial={{ fillOpacity: reduce ? 0.2 : 0.22 }}
                  animate={{ fillOpacity: 0 }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  pointerEvents="none"
                />
              )}
            </AnimatePresence>
            {focused && !reduce && (
              <motion.rect
                x={r.x - px(4)}
                y={r.y - px(4)}
                width={r.w + px(8)}
                height={r.h + px(8)}
                rx={rx + px(4)}
                fill="none"
                stroke="var(--ink)"
                vectorEffect="non-scaling-stroke"
                initial={{ strokeOpacity: 0.5 }}
                animate={{ strokeOpacity: [0.5, 0.1, 0.5] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
                pointerEvents="none"
              />
            )}
            {showLabels && !rail && (
              <ZoneLabel r={r} name={zone.name} vertical={vertical && narrow} fontSize={fontSize} px={px} emphasized={selected || focused} />
            )}
            {mode === 'edit' && selected && (
              <Handles r={r} size={handleSize} rail={rail ? zone.surface : null} onDown={(e, h) => onPointerDown(e, zone, h)} />
            )}
          </g>
        )
      })}

      {overlay?.(layout)}

      <g pointerEvents="none">
        <AnimatePresence>
          {ripples.map((rp) => (
            <g key={rp.id}>
              <motion.circle
                cx={rp.x}
                cy={rp.y}
                r={px(26)}
                fill="none"
                stroke="var(--signal)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                initial={{ scale: 0.4, opacity: 1 }}
                animate={{ scale: reduce ? 1 : 1.6, opacity: 0 }}
                transition={{ duration: 0.52, ease: [0.16, 1, 0.3, 1] }}
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
              />
              <motion.circle
                cx={rp.x}
                cy={rp.y}
                r={px(3)}
                fill="var(--signal)"
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.6, delay: 0.1 }}
              />
            </g>
          ))}
        </AnimatePresence>
      </g>
    </svg>
  )
}

function ZoneLabel({
  r,
  name,
  vertical,
  fontSize,
  px,
  emphasized
}: {
  r: Rect
  name: string
  vertical: boolean
  fontSize: number
  px: (n: number) => number
  emphasized: boolean
}): React.JSX.Element {
  if (vertical) {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    return (
      <text
        x={cx}
        y={cy + fontSize * 0.35}
        textAnchor="middle"
        fontSize={fontSize}
        className={cn('zone-label', emphasized && 'is-emph')}
        transform={`rotate(-90 ${cx} ${cy})`}
        pointerEvents="none"
      >
        {name}
      </text>
    )
  }
  const fits = r.h > fontSize * 2
  return (
    <text
      x={r.x + px(8)}
      y={fits ? r.y + px(8) + fontSize * 0.8 : r.y + r.h / 2 + fontSize * 0.35}
      fontSize={fontSize}
      className={cn('zone-label', emphasized && 'is-emph')}
      pointerEvents="none"
    >
      {name}
    </text>
  )
}

function Handles({
  r,
  size,
  rail,
  onDown
}: {
  r: Rect
  size: number
  rail: Surface | null
  onDown: (e: React.PointerEvent, h: Handle) => void
}): React.JSX.Element {
  const pts: { h: Handle; x: number; y: number; cursor: string }[] =
    rail === 'edge-left' || rail === 'edge-right'
      ? [
          { h: 'n', x: r.x + r.w / 2, y: r.y, cursor: 'ns-resize' },
          { h: 's', x: r.x + r.w / 2, y: r.y + r.h, cursor: 'ns-resize' }
        ]
      : rail === 'front'
        ? [
            { h: 'w', x: r.x, y: r.y + r.h / 2, cursor: 'ew-resize' },
            { h: 'e', x: r.x + r.w, y: r.y + r.h / 2, cursor: 'ew-resize' }
          ]
        : [
            { h: 'nw', x: r.x, y: r.y, cursor: 'nwse-resize' },
            { h: 'ne', x: r.x + r.w, y: r.y, cursor: 'nesw-resize' },
            { h: 'sw', x: r.x, y: r.y + r.h, cursor: 'nesw-resize' },
            { h: 'se', x: r.x + r.w, y: r.y + r.h, cursor: 'nwse-resize' }
          ]
  return (
    <g>
      {pts.map((p) => (
        <rect
          key={p.h}
          x={p.x - size / 2}
          y={p.y - size / 2}
          width={size}
          height={size}
          rx={size * 0.25}
          fill="var(--bg)"
          stroke="var(--ink)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          style={{ cursor: p.cursor }}
          onPointerDown={(e) => onDown(e, p.h)}
        />
      ))}
    </g>
  )
}
