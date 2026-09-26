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
  /** Calibration target: drawn steady in ink, the rest recede. */
  focusId?: string | null
  /** Zones that are not included: drawn dashed. */
  mutedIds?: string[]
  /** Show taps from the daemon as rings. */
  listenTaps?: boolean
  /** Only show taps for this zone (calibration). */
  tapFilter?: string | null
  /** Keep a dot where every tap landed (calibration heatmap). */
  cloud?: boolean
  showLabels?: boolean
  /** Extra words for the accessible name of each zone, e.g. "2 gestures". */
  describe?: (zone: Zone) => string
  className?: string
  /** Extra svg content drawn above the zones, in svg units. */
  overlay?: (layout: Layout, px: (n: number) => number) => React.ReactNode
}

interface Ripple {
  id: number
  x: number
  y: number
  zone: string
}
interface Mark {
  id: number
  x: number
  y: number
  zone: string
}

let rippleSeq = 0

// The drawing draws itself once, on the very first launch (and again when re-armed, e.g. for a screenshot).
const DRAWN_KEY = 'gk.drawn'
let drawPending = (() => {
  try {
    return localStorage.getItem(DRAWN_KEY) !== '1'
  } catch {
    return false
  }
})()
export function armDrawIn(): void {
  drawPending = true
}
export function skipDrawIn(): void {
  drawPending = false
}
function takeDrawIn(): boolean {
  if (!drawPending) return false
  drawPending = false
  try {
    localStorage.setItem(DRAWN_KEY, '1')
  } catch {
    // fine: it may draw again next time
  }
  return true
}
const EASE_OUT = [0.16, 1, 0.3, 1] as const

function useSvgScale(ref: React.RefObject<SVGSVGElement | null>, vbW: number, vbH: number): number {
  const [scale, setScale] = React.useState(0.5)
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

/** Edges are thin rails: a zone there always spans the rail's thickness. Same for the front lip. */
export function normalizeRect(surface: Surface, r: Rect): Rect {
  if (surface === 'edge-left' || surface === 'edge-right') return { x: 0, w: 1, y: clamp(r.y, 0, 1), h: clamp(r.h, 0.03, 1 - clamp(r.y, 0, 1)) }
  if (surface === 'front') return { y: 0, h: 1, x: clamp(r.x, 0, 1), w: clamp(r.w, 0.03, 1 - clamp(r.x, 0, 1)) }
  return r
}

// ---------------------------------------------------------------- static drawing

export const Chassis = React.memo(function Chassis({ layout, pxUnit, drawIn }: { layout: Layout; pxUnit: number; drawIn: boolean }): React.JSX.Element {
  const { spec, surfaces, corner } = layout
  const base = surfaces.base
  const lid = surfaces.lid
  const kbRect = toSvg(layout, 'base', spec.keyboard)
  const { keys, touchId } = React.useMemo(() => keyboardKeys(kbRect), [kbRect.x, kbRect.y, kbRect.w, kbRect.h]) // eslint-disable-line react-hooks/exhaustive-deps
  const tp = toSvg(layout, 'base', spec.trackpad)
  const notchW = spec.notch * base.w
  const notchX = base.x + (base.w - notchW) / 2
  const by = base.y + base.h
  const nd = 6
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

  // Lid seen from above while open: a slight perspective, top edge 94 percent of the bottom.
  const inset = lid.w * 0.03
  const lr = corner * 0.7
  const lidD = [
    `M ${lid.x + inset + lr} ${lid.y}`,
    `H ${lid.x + lid.w - inset - lr}`,
    `Q ${lid.x + lid.w - inset} ${lid.y} ${lid.x + lid.w - inset + 1} ${lid.y + lr}`,
    `L ${lid.x + lid.w} ${lid.y + lid.h}`,
    `H ${lid.x}`,
    `L ${lid.x + inset - 1} ${lid.y + lr}`,
    `Q ${lid.x + inset} ${lid.y} ${lid.x + inset + lr} ${lid.y}`,
    'Z'
  ].join(' ')
  const b = 18
  const dInset = inset + b * 0.6
  const displayD = [
    `M ${lid.x + dInset} ${lid.y + b * 0.55}`,
    `H ${lid.x + lid.w - dInset}`,
    `L ${lid.x + lid.w - b * 0.9} ${lid.y + lid.h - 6}`,
    `H ${lid.x + b * 0.9}`,
    'Z'
  ].join(' ')
  const camW = lid.w * 0.07
  const camX = lid.x + (lid.w - camW) / 2
  const camY = lid.y + b * 0.55
  const labelSize = 10 / pxUnit
  const kbWell = { x: kbRect.x - 4, y: kbRect.y - 4, w: kbRect.w + 8, h: kbRect.h + 8 }

  const bracket = (s: Surface): React.ReactNode => {
    const r = surfaces[s]
    const text = SURFACE_LABEL[s].toUpperCase()
    if (s === 'front') {
      const d = `M ${r.x} ${r.y} V ${r.y + r.h} H ${r.x + r.w} V ${r.y}`
      return (
        <g key={s}>
          <path d={d} className="detail" />
          <text x={r.x + r.w / 2} y={r.y + r.h + labelSize * 1.7} textAnchor="middle" className="label-svg" fontSize={labelSize}>
            {text}
          </text>
        </g>
      )
    }
    const left = s === 'edge-left'
    const d = left
      ? `M ${r.x + r.w} ${r.y} H ${r.x} V ${r.y + r.h} H ${r.x + r.w}`
      : `M ${r.x} ${r.y} H ${r.x + r.w} V ${r.y + r.h} H ${r.x}`
    const words = text.split(' ')
    return (
      <g key={s}>
        <path d={d} className="detail" />
        {words.map((w, i) => (
          <text
            key={w}
            x={left ? r.x - labelSize * 0.8 : r.x + r.w + labelSize * 0.8}
            y={r.y + r.h / 2 + (i - (words.length - 1) / 2) * labelSize * 1.35}
            textAnchor={left ? 'end' : 'start'}
            className="label-svg"
            fontSize={labelSize}
          >
            {w}
          </text>
        ))}
      </g>
    )
  }

  return (
    <g className={drawIn ? 'chassis drawing' : 'chassis'}>
      <defs>
        {/* Speaker perforation on a hex offset, not a square grid. */}
        <pattern id="grille-hex" width={3.6} height={6.24} patternUnits="userSpaceOnUse">
          <circle cx={0.9} cy={1.56} r={0.6} fill="var(--ink-3)" opacity={0.45} />
          <circle cx={2.7} cy={4.68} r={0.6} fill="var(--ink-3)" opacity={0.45} />
        </pattern>
      </defs>

      <path d={lidD} className="contour draw" pathLength={1} fill="var(--bg-sunken)" />
      <path d={displayD} className="detail draw" pathLength={1} />
      <path d={`M ${camX} ${camY} h ${camW} v 5 q 0 5 -5 5 h ${-(camW - 10)} q -5 0 -5 -5 Z`} className="detail" fill="var(--bg-sunken)" />
      <circle cx={camX + camW / 2} cy={camY + 5} r={1.8} className="detail" />
      {/* ambient light sensor, beside the camera */}
      <circle cx={camX + camW / 2 + 10} cy={camY + 5} r={1.1} fill="var(--ink-3)" />
      <text x={lid.x + lid.w / 2} y={lid.y - labelSize * 0.9} textAnchor="middle" className="label-svg" fontSize={labelSize}>
        LID
      </text>

      {/* hinge: a solid line between the two barrels */}
      <line x1={base.x + corner + 12} x2={base.x + base.w - corner - 12} y1={layout.hingeY} y2={layout.hingeY} className="detail" />

      <path d={baseD} className="contour draw" pathLength={1} fill="var(--bg)" />

      {spec.grilles?.map((g, i) => {
        const r = toSvg(layout, 'base', g)
        return <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={3} fill="url(#grille-hex)" />
      })}

      <rect x={kbWell.x} y={kbWell.y} width={kbWell.w} height={kbWell.h} rx={6} className="detail" />
      <g className="keys">
        {keys.map((k, i) => (
          <rect key={i} x={k.x} y={k.y} width={k.w} height={k.h} rx={2.4} style={drawIn ? ({ '--i': i } as React.CSSProperties) : undefined} />
        ))}
        <rect x={touchId.x} y={touchId.y} width={touchId.w} height={touchId.h} rx={2.4} />
      </g>
      <circle cx={touchId.x + touchId.w / 2} cy={touchId.y + touchId.h / 2} r={Math.min(touchId.w, touchId.h) * 0.3} className="detail" />

      <rect x={tp.x} y={tp.y} width={tp.w} height={tp.h} rx={10} className="detail" />
      <text x={tp.x + tp.w / 2} y={tp.y + tp.h / 2 + labelSize * 0.35} textAnchor="middle" className="label-svg" fontSize={labelSize}>
        TRACKPAD
      </text>

      {(['edge-left', 'edge-right', 'front'] as Surface[]).map(bracket)}
    </g>
  )
})

// ---------------------------------------------------------------- zones

const SNAP = 0.01
const EDGE_SNAP = 0.012
const MIN = 0.03

type Guide = { axis: 'x' | 'y'; v: number }

function snapRect(r: Rect, others: Rect[]): { rect: Rect; guides: Guide[] } {
  const snap = (v: number): number => Math.round(v / SNAP) * SNAP
  let x = snap(r.x)
  let y = snap(r.y)
  const guides: Guide[] = []
  for (const o of others) {
    for (const [edge, target] of [
      [x, o.x + o.w],
      [x + r.w, o.x],
      [x, o.x],
      [x + r.w, o.x + o.w]
    ] as const) {
      if (Math.abs(edge - target) < EDGE_SNAP) {
        x += target - edge
        guides.push({ axis: 'x', v: target })
        break
      }
    }
    for (const [edge, target] of [
      [y, o.y + o.h],
      [y + r.h, o.y],
      [y, o.y],
      [y + r.h, o.y + o.h]
    ] as const) {
      if (Math.abs(edge - target) < EDGE_SNAP) {
        y += target - edge
        guides.push({ axis: 'y', v: target })
        break
      }
    }
  }
  return { rect: { x, y, w: r.w, h: r.h }, guides }
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
  cloud,
  showLabels = true,
  describe,
  className,
  overlay
}: LaptopMapProps): React.JSX.Element {
  const layout = React.useMemo(() => layoutFor(family), [family])
  const [drawIn] = React.useState(takeDrawIn)
  const svgRef = React.useRef<SVGSVGElement>(null)
  const pxUnit = useSvgScale(svgRef, layout.vbW, layout.vbH)
  const reduce = useReducedMotion()
  const [ripples, setRipples] = React.useState<Ripple[]>([])
  const [marks, setMarks] = React.useState<Mark[]>([])
  const [lit, setLit] = React.useState<Record<string, number>>({})
  const [hover, setHover] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const [guides, setGuides] = React.useState<Guide[]>([])
  const zonesRef = React.useRef(zones)
  React.useEffect(() => {
    zonesRef.current = zones
  }, [zones])

  const px = React.useCallback((n: number): number => n / pxUnit, [pxUnit])

  // live taps
  React.useEffect(() => {
    if (!listenTaps) return
    return client.on('tap', (t: TapMsg) => {
      if (tapFilter && t.zone !== tapFilter) return
      const zone = zonesRef.current.find((z) => z.id === t.zone)
      if (!zone) return
      const r = normalizeRect(zone.surface, zone.rect)
      const inside = t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h
      const p = inside ? pointToSvg(layout, zone.surface, t.x, t.y) : pointToSvg(layout, zone.surface, r.x + r.w / 2, r.y + r.h / 2)
      const id = ++rippleSeq
      setRipples((rs) => [...rs.slice(-6), { id, x: p.x, y: p.y, zone: zone.id }])
      setLit((f) => ({ ...f, [zone.id]: id }))
      if (cloud) setMarks((m) => [...m.slice(-400), { id, x: p.x, y: p.y, zone: zone.id }])
      setTimeout(() => setRipples((rs) => rs.filter((x) => x.id !== id)), 1500)
      setTimeout(() => setLit((f) => (f[zone.id] === id ? { ...f, [zone.id]: 0 } : f)), 160)
    })
  }, [listenTaps, tapFilter, layout, cloud])

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

  /** Other zones never overlap; the keyboard and trackpad block a zone unless it already sat on them. */
  const tryApply = React.useCallback(
    (id: string, next: Rect, orig?: Rect): boolean => {
      const zone = zonesRef.current.find((z) => z.id === id)
      if (!zone || !onZoneChange) return false
      const start = orig ?? zone.rect
      const others = zonesRef.current.filter((z) => z.id !== id && z.surface === zone.surface).map((z) => normalizeRect(z.surface, z.rect))
      const obs = obstacles(layout.spec, zone.surface).filter((o) => !rectsOverlap(start, o))
      if ([...others, ...obs].some((o) => rectsOverlap(next, o))) return false
      onZoneChange(id, round(next))
      return true
    },
    [layout.spec, onZoneChange]
  )

  const onPointerDown = (e: React.PointerEvent, zone: Zone, handle: Handle): void => {
    if (mode !== 'edit') return
    e.stopPropagation()
    onSelect?.(zone.id)
    try {
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
    } catch {
      // synthetic events have no pointer to capture
    }
    drag.current = { id: zone.id, handle, start: svgPoint(e), orig: normalizeRect(zone.surface, zone.rect), surface: zone.surface }
    setDragging(true)
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const d = drag.current
    if (!d) return
    const p = svgPoint(e)
    const s = layout.surfaces[d.surface]
    const dx = (p.x - d.start.x) / s.w
    const dy = (p.y - d.start.y) / s.h
    const o = d.orig
    let { x, y, w, h } = o
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
    w = Math.min(w, 1)
    h = Math.min(h, 1)
    x = clamp(x, 0, 1 - w)
    y = clamp(y, 0, 1 - h)
    const zone = zonesRef.current.find((z) => z.id === d.id)!
    const others = zonesRef.current.filter((z) => z.id !== d.id && z.surface === zone.surface).map((z) => normalizeRect(z.surface, z.rect))
    let next: Rect = { x, y, w, h }
    let g: Guide[] = []
    if (hd === 'move') {
      const snapped = snapRect(next, [...others, ...obstacles(layout.spec, zone.surface)])
      next = snapped.rect
      g = snapped.guides
    } else {
      const snap = (v: number): number => Math.round(v / SNAP) * SNAP
      const x2 = snap(next.x + next.w)
      const y2 = snap(next.y + next.h)
      next = { x: snap(next.x), y: snap(next.y), w: 0, h: 0 }
      next.w = Math.max(MIN, x2 - next.x)
      next.h = Math.max(MIN, y2 - next.y)
    }
    next = normalizeRect(zone.surface, next)
    next.x = clamp(next.x, 0, 1 - next.w)
    next.y = clamp(next.y, 0, 1 - next.h)
    if (tryApply(d.id, next, d.orig)) setGuides(zone.surface === 'base' ? g : [])
  }

  const onPointerUp = (): void => {
    drag.current = null
    setDragging(false)
    setGuides([])
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
    const r = normalizeRect(zone.surface, zone.rect)
    const next = e.altKey
      ? { ...r, w: clamp(r.w + mv[0], MIN, 1 - r.x), h: clamp(r.h + mv[1], MIN, 1 - r.y) }
      : { ...r, x: clamp(r.x + mv[0], 0, 1 - r.w), y: clamp(r.y + mv[1], 0, 1 - r.h) }
    tryApply(zone.id, normalizeRect(zone.surface, next))
  }

  const fs = px(10.5)
  const base = layout.surfaces.base

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${layout.vbW} ${layout.vbH}`}
      className={cn('laptop-map block h-full w-full overflow-visible', drawIn && 'drawing-in', className)}
      preserveAspectRatio="xMidYMid meet"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerDown={() => mode === 'edit' && onSelect?.(null)}
      role="group"
      aria-label="Top-down drawing of your MacBook with its zones"
    >
      <Chassis layout={layout} pxUnit={pxUnit} drawIn={drawIn} />

      {zones.map((zone, index) => {
        const nr = normalizeRect(zone.surface, zone.rect)
        const r = toSvg(layout, zone.surface, nr)
        const selected = selectedId === zone.id
        const focused = focusId === zone.id
        const off = zone.enabled === false
        const muted = !!mutedIds?.includes(zone.id) || off
        const recede = (!!focusId && !focused) || (off && !selected)
        const interactive = mode === 'edit' || !!onSelect
        const isHover = hover === zone.id
        const isLit = !!lit[zone.id]
        const rail = zone.surface !== 'base' && zone.surface !== 'lid'
        const rx = Math.min(px(4), r.w / 2, r.h / 2)
        const showName = showLabels && (selected || isHover || focused) && !rail
        const fill = selected || focused || isHover ? 'var(--zone-fill)' : 'transparent'
        const stroke = isLit ? 'var(--signal)' : selected || focused ? 'var(--ink)' : isHover ? 'var(--ink-2)' : 'var(--ink-3)'
        const idx = String(index + 1).padStart(2, '0')
        const labelX = rail ? (zone.surface === 'edge-left' ? r.x - px(22) : r.x + r.w + px(6)) : r.x + px(6)
        const labelY = rail ? r.y + px(10) : r.y + px(6) + fs * 0.8
        return (
          <g
            key={zone.id}
            className={cn('zone', mode === 'edit' && 'cursor-grab active:cursor-grabbing')}
            opacity={recede ? 0.35 : 1}
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
            aria-label={interactive ? `${zone.name}${describe ? `, ${describe(zone)}` : ''}` : undefined}
            aria-pressed={interactive ? selected : undefined}
          >
            <rect
              className="zone-body"
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={rx}
              fill={fill}
              stroke={stroke}
              strokeWidth={1}
              strokeDasharray={muted ? '3 3' : undefined}
              vectorEffect="non-scaling-stroke"
              style={{ transition: isLit ? 'stroke 160ms var(--ease-snap)' : 'stroke 900ms var(--ease-out), fill 160ms var(--ease-snap)' }}
            />
            <AnimatePresence>
              {isLit && (
                <motion.rect
                  key={lit[zone.id]}
                  x={r.x}
                  y={r.y}
                  width={r.w}
                  height={r.h}
                  rx={rx}
                  fill="var(--signal)"
                  initial={{ fillOpacity: 0.1 }}
                  animate={{ fillOpacity: 0.1 }}
                  exit={{ fillOpacity: 0, transition: { duration: 0.6, ease: EASE_OUT } }}
                  pointerEvents="none"
                />
              )}
            </AnimatePresence>
            {showLabels && (
              <text x={labelX} y={labelY} fontSize={fs} className="zone-index" pointerEvents="none" style={{ fill: isLit ? 'var(--signal)' : undefined }}>
                {idx}
              </text>
            )}
            {showName && (
              <text x={r.x + px(26)} y={labelY} fontSize={px(11.5)} className="zone-name" pointerEvents="none">
                {r.w * pxUnit > 110 ? zone.name : ''}
              </text>
            )}
            {mode === 'edit' && selected && (
              <Handles r={r} size={px(6)} rail={rail ? zone.surface : null} onDown={(e, h) => onPointerDown(e, zone, h)} />
            )}
            {mode === 'edit' && selected && dragging && (
              <rect
                x={r.x - px(3)}
                y={r.y - px(3)}
                width={r.w + px(6)}
                height={r.h + px(6)}
                rx={rx + px(3)}
                fill="none"
                stroke="var(--ink-3)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
          </g>
        )
      })}

      {/* Callout for narrow zones: the name sits outside with a leader line. */}
      {zones.map((zone) => {
        if (!showLabels) return null
        const active = hover === zone.id || selectedId === zone.id || focusId === zone.id
        const r = toSvg(layout, zone.surface, normalizeRect(zone.surface, zone.rect))
        if (!active || r.w * pxUnit > 110) return null
        const x = zone.surface === 'edge-left' || (zone.surface === 'base' && r.x < base.x + base.w / 2) ? r.x - px(12) : r.x + r.w + px(12)
        const anchor = x < r.x ? 'end' : 'start'
        const y = r.y + Math.min(r.h / 2, px(40))
        return (
          <g key={`c-${zone.id}`} pointerEvents="none">
            <line x1={anchor === 'end' ? x + px(4) : x - px(4)} x2={anchor === 'end' ? r.x : r.x + r.w} y1={y} y2={y} stroke="var(--ink-3)" vectorEffect="non-scaling-stroke" />
            <text x={x} y={y + px(3.5)} textAnchor={anchor} fontSize={px(11.5)} className="zone-name">
              {zone.name}
            </text>
          </g>
        )
      })}

      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <line key={i} x1={base.x + g.v * base.w} x2={base.x + g.v * base.w} y1={base.y} y2={base.y + base.h} stroke="var(--ink-2)" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        ) : (
          <line key={i} y1={base.y + g.v * base.h} y2={base.y + g.v * base.h} x1={base.x} x2={base.x + base.w} stroke="var(--ink-2)" vectorEffect="non-scaling-stroke" pointerEvents="none" />
        )
      )}

      {overlay?.(layout, px)}

      {/* Tap cloud: where every calibration tap actually landed. */}
      <g pointerEvents="none">
        {marks.map((m, i) => (
          <motion.circle
            key={m.id}
            cx={m.x}
            cy={m.y}
            r={px(1.5)}
            initial={{ fill: 'var(--signal)', fillOpacity: 1 }}
            animate={{ fill: 'var(--ink)', fillOpacity: 0.35 }}
            transition={{ delay: i === marks.length - 1 ? 0.6 : 0, duration: 0.4 }}
          />
        ))}
      </g>

      {/* The touch: two rings like a ripple in metal, and a held core dot. */}
      <g pointerEvents="none">
        <AnimatePresence>
          {ripples.map((rp) => (
            <g key={rp.id}>
              {!reduce &&
                [0, 1].map((k) => (
                  <motion.circle
                    key={k}
                    cx={rp.x}
                    cy={rp.y}
                    fill="none"
                    stroke="var(--signal)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    initial={{ r: px(6), opacity: k ? 0.7 : 1 }}
                    animate={{ r: px(44), opacity: 0 }}
                    transition={{ duration: 0.64, delay: k * 0.09, ease: EASE_OUT }}
                  />
                ))}
              <motion.circle
                cx={rp.x}
                cy={rp.y}
                r={px(2)}
                fill="var(--signal)"
                initial={{ opacity: 1 }}
                animate={{ opacity: [1, 1, 0] }}
                transition={{ duration: 1.38, times: [0, 0.8, 1] }}
              />
            </g>
          ))}
        </AnimatePresence>
      </g>
    </svg>
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
        <circle
          key={p.h}
          cx={p.x}
          cy={p.y}
          r={size / 2}
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
