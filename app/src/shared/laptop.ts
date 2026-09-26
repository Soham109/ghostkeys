import type { DeviceFamily, Rect, Surface } from './protocol'

/**
 * Physical layout of each MacBook family, in base-normalized coordinates
 * (x 0 = left edge, 1 = right edge; y 0 = hinge, 1 = front lip).
 */
export interface LaptopSpec {
  family: DeviceFamily
  widthMm: number
  depthMm: number
  pro: boolean
  keyboard: Rect
  trackpad: Rect
  grilles: [Rect, Rect] | null
  /** Width of the thumb notch in the front lip, normalized. */
  notch: number
  cornerMm: number
}

export const LAPTOPS: Record<DeviceFamily, LaptopSpec> = {
  'macbook-pro-14': {
    family: 'macbook-pro-14',
    widthMm: 312.6,
    depthMm: 221.2,
    pro: true,
    keyboard: { x: 0.105, y: 0.075, w: 0.79, h: 0.4 },
    trackpad: { x: 0.28, y: 0.594, w: 0.44, h: 0.37 },
    grilles: [
      { x: 0.026, y: 0.075, w: 0.058, h: 0.4 },
      { x: 0.916, y: 0.075, w: 0.058, h: 0.4 }
    ],
    notch: 0.085,
    cornerMm: 9
  },
  'macbook-pro-16': {
    family: 'macbook-pro-16',
    widthMm: 355.7,
    depthMm: 248.1,
    pro: true,
    keyboard: { x: 0.13, y: 0.075, w: 0.74, h: 0.37 },
    trackpad: { x: 0.3, y: 0.572, w: 0.4, h: 0.39 },
    grilles: [
      { x: 0.03, y: 0.075, w: 0.08, h: 0.37 },
      { x: 0.89, y: 0.075, w: 0.08, h: 0.37 }
    ],
    notch: 0.075,
    cornerMm: 10
  },
  'macbook-air-13': {
    family: 'macbook-air-13',
    widthMm: 304.1,
    depthMm: 215,
    pro: false,
    keyboard: { x: 0.05, y: 0.075, w: 0.9, h: 0.4 },
    trackpad: { x: 0.3, y: 0.59, w: 0.4, h: 0.37 },
    grilles: null,
    notch: 0.085,
    cornerMm: 8
  },
  'macbook-air-15': {
    family: 'macbook-air-15',
    widthMm: 340.4,
    depthMm: 237.6,
    pro: false,
    keyboard: { x: 0.095, y: 0.075, w: 0.81, h: 0.37 },
    trackpad: { x: 0.29, y: 0.575, w: 0.42, h: 0.385 },
    grilles: null,
    notch: 0.08,
    cornerMm: 9
  }
}

export const rectsOverlap = (a: Rect, b: Rect, eps = 0.0005): boolean =>
  a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps

/** Physical size of a surface in millimetres (lid: display back; edges: case thickness x depth). */
export function surfaceMm(spec: LaptopSpec, surface: string): { w: number; h: number } {
  switch (surface) {
    case 'lid':
      return { w: spec.widthMm, h: spec.depthMm * 0.98 }
    case 'edge-left':
    case 'edge-right':
      return { w: 15.5, h: spec.depthMm }
    case 'front':
      return { w: spec.widthMm, h: 15.5 }
    default:
      return { w: spec.widthMm, h: spec.depthMm }
  }
}

/** Areas no zone may cover, per surface: keys are keys, and the trackpad is the trackpad. */
export function obstacles(spec: LaptopSpec, surface: Surface): Rect[] {
  return surface === 'base' ? [spec.keyboard, spec.trackpad] : []
}
