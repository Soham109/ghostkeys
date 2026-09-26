import type { DeviceFamily, Rect, Surface } from '@shared/protocol'
import { LAPTOPS, type LaptopSpec } from '@shared/laptop'

export const MM = 3 // svg units per millimetre

export interface Layout {
  spec: LaptopSpec
  vbW: number
  vbH: number
  surfaces: Record<Surface, Rect>
  hingeY: number
  corner: number
}

/**
 * The drawing is a top-down view of the open laptop: the lid, foreshortened, above the hinge; the
 * top case below it; the two side edges and the front lip drawn as thin rails just outside the case.
 * Lid coordinates run y 0 at its far (top) edge to 1 at the hinge; edges run y 0 at the hinge to 1 at the front.
 */
export function layoutFor(family: DeviceFamily): Layout {
  const spec = LAPTOPS[family] ?? LAPTOPS['macbook-pro-14']
  const W = spec.widthMm * MM
  const D = spec.depthMm * MM
  const pad = 30
  const rail = 14
  const gap = 12
  const lidH = D * 0.34
  const baseX = pad + rail + gap
  const lidY = pad
  const hinge = 12
  const baseY = lidY + lidH + hinge
  const frontY = baseY + D + gap
  return {
    spec,
    vbW: baseX * 2 + W,
    vbH: frontY + rail + pad,
    hingeY: lidY + lidH + hinge / 2,
    corner: spec.cornerMm * MM,
    surfaces: {
      lid: { x: baseX + W * 0.012, y: lidY, w: W * 0.976, h: lidH },
      base: { x: baseX, y: baseY, w: W, h: D },
      'edge-left': { x: baseX - gap - rail, y: baseY, w: rail, h: D },
      'edge-right': { x: baseX + W + gap, y: baseY, w: rail, h: D },
      front: { x: baseX, y: frontY, w: W, h: rail }
    }
  }
}

export function toSvg(layout: Layout, surface: Surface, r: Rect): Rect {
  const s = layout.surfaces[surface]
  return { x: s.x + r.x * s.w, y: s.y + r.y * s.h, w: r.w * s.w, h: r.h * s.h }
}

export function pointToSvg(layout: Layout, surface: Surface, x: number, y: number): { x: number; y: number } {
  const s = layout.surfaces[surface]
  return { x: s.x + x * s.w, y: s.y + y * s.h }
}

/** Where the given normalized point would land on each surface, or null if it lies outside all of them. */
export function hitSurface(layout: Layout, px: number, py: number): { surface: Surface; x: number; y: number } | null {
  for (const surface of Object.keys(layout.surfaces) as Surface[]) {
    const s = layout.surfaces[surface]
    const slack = surface.startsWith('edge') || surface === 'front' ? 10 : 0
    if (px >= s.x - slack && px <= s.x + s.w + slack && py >= s.y - slack && py <= s.y + s.h + slack) {
      return { surface, x: (px - s.x) / s.w, y: (py - s.y) / s.h }
    }
  }
  return null
}

// ---------------------------------------------------------------- keyboard

export interface Key {
  x: number
  y: number
  w: number
  h: number
}

/** A Mac keyboard in units: full-height function row (M-series Pros), five rows below, 14.5 units wide. */
export function keyboardKeys(kb: Rect): { keys: Key[]; touchId: Key } {
  const FN = 0.9
  const unitW = kb.w / 14.5
  const unitH = kb.h / (5 + FN)
  const gap = Math.min(unitW, unitH) * 0.17
  const keys: Key[] = []
  const at = (x: number, y: number, w: number, h: number): Key => ({
    x: kb.x + x * unitW + gap / 2,
    y: kb.y + y * unitH + gap / 2,
    w: w * unitW - gap,
    h: h * unitH - gap
  })
  const row = (y: number, h: number, widths: number[]): void => {
    let x = 0
    for (const w of widths) {
      keys.push(at(x, y, w, h))
      x += w
    }
  }
  row(0, FN, [1.25, ...Array(12).fill(1.02), 1.01])
  const touchId = keys.pop()!
  row(FN, 1, [...Array(13).fill(1), 1.5])
  row(FN + 1, 1, [1.5, ...Array(12).fill(1), 1])
  row(FN + 2, 1, [1.8, ...Array(11).fill(1), 1.7])
  row(FN + 3, 1, [2.3, ...Array(10).fill(1), 2.2])
  row(FN + 4, 1, [1, 1, 1, 1.25, 5, 1.25, 1])
  const ax = 11.5
  keys.push(at(ax, FN + 4.5, 1, 0.5), at(ax + 1, FN + 4, 1, 0.5), at(ax + 1, FN + 4.5, 1, 0.5), at(ax + 2, FN + 4.5, 1, 0.5))
  return { keys, touchId }
}
