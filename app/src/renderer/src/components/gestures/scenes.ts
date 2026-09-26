// Timelines for every gesture demo. A scene is a pure function of time: frame(t) returns where the hands
// are, which pose they hold, and what the laptop does. The renderer (GestureDemo) only draws frames.
import type { DeviceFamily, Modifier, Zone } from '@shared/protocol'
import { keyboardKeys, layoutFor, toSvg, type Layout } from '../laptop/geometry'
import { normalizeRect } from '../laptop/LaptopMap'
import type { HandState } from './Hand'
import type { Pose } from './hands'

export type DemoId =
  | 'tap'
  | 'double'
  | 'triple'
  | 'rhythm'
  | 'sequence'
  | 'modifier_tap'
  | 'knock_knuckle'
  | 'rub'
  | 'rub_left'
  | 'rub_right'
  | 'finger_slide_left'
  | 'finger_slide_right'
  | 'finger_slide_up'
  | 'finger_slide_down'
  | 'hover_level'
  | 'push'
  | 'pull'
  | 'sweep_left'
  | 'sweep_right'
  | 'wave_toward'
  | 'wave_away'
  | 'wave_sweep'
  | 'lid_nudge'
  | 'cover'
  | 'cover_hold'
  | 'tilt_left'
  | 'tilt_right'
  | 'air_tap'
  | 'pinch_hold'
  | 'pinch_drag_left'
  | 'pinch_drag_right'
  | 'pinch_drag_up'
  | 'pinch_drag_down'
  | 'palm_swipe_left'
  | 'palm_swipe_right'
  | 'circle_cw'
  | 'circle_ccw'
  | 'two_hand_zoom'
  | 'point'

export type View = 'top' | 'side' | 'front'

export interface Ring {
  x: number
  y: number
  /** seconds since the touch */
  age: number
  r: number
}

export interface Frame {
  hands: HandState[]
  rings: Ring[]
  /** svg path strings for motion trails, with opacity */
  trails: { d: string; o: number }[]
  /** top view: zones to emphasize */
  focus: string[]
  /** top view: a key cap that is held, with 0..1 press */
  key?: { x: number; y: number; w: number; h: number; v: number }
  /** side view: lid pushed back by this many degrees */
  lid?: number
  /** front view: whole laptop rolled (degrees) */
  roll?: number
  /** front view: screen dimmed 0..1 (light sensor covered) */
  dim?: number
  /** front view: hold progress 0..1 around the light sensor */
  hold?: number
  /** side view: hover height meter 0..1 */
  level?: number
  /** front view: a value dial 0..1 */
  dial?: number
  /** front view: a point on screen (cursor or zoom frame) */
  cursor?: { x: number; y: number }
  zoom?: number
  /** front view: camera is watching */
  camera?: boolean
  /** side view: pilot tone arcs from the speaker */
  sonar?: number
}

export interface Scene {
  view: View
  duration: number
  /** the time shown when motion is reduced */
  still: number
  viewBox: [number, number, number, number]
  layout?: Layout
  frame: (t: number) => Frame
}

// ---------------------------------------------------------------- easing and tracks

const ease = (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
/** Piecewise track: [time, value] keys, eased between. */
function track(t: number, keys: [number, number][]): number {
  if (t <= keys[0]![0]) return keys[0]![1]
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!
    const [t0, v0] = keys[i - 1]!
    if (t <= t1) return v0 + (v1 - v0) * ease((t - t0) / Math.max(1e-6, t1 - t0))
  }
  return keys[keys.length - 1]![1]
}
/** 1 = hovering, 0 = touching, with a quick press at each tap time. */
function tapLift(t: number, taps: number[], base = 1): number {
  let v = base
  for (const tt of taps) {
    const d = t - tt
    if (d > -0.12 && d < 0.26) v = Math.min(v, d < 0 ? ease(-d / 0.12) * base : d < 0.04 ? 0 : ease((d - 0.04) / 0.22) * base)
  }
  return v
}
function ringsAt(t: number, taps: number[], x: number, y: number, r: number): Ring[] {
  return taps.filter((tt) => t >= tt && t < tt + 0.7).map((tt) => ({ x, y, age: t - tt, r }))
}
const poses = (p: Pose): HandState['poses'] => ({ [p]: 1 })
const mix = (a: Pose, b: Pose, w: number): HandState['poses'] => ({ [a]: 1 - w, [b]: w })

// ---------------------------------------------------------------- top view helpers

function zonePoint(layout: Layout, zones: Zone[], id: string | undefined, fx = 0.5, fy = 0.5): { x: number; y: number } {
  const z = zones.find((q) => q.id === id) ?? zones[0]
  if (!z) return { x: layout.surfaces.base.x + layout.surfaces.base.w / 2, y: layout.surfaces.base.y + layout.surfaces.base.h * 0.7 }
  const r = toSvg(layout, z.surface, normalizeRect(z.surface, z.rect))
  return { x: r.x + r.w * fx, y: r.y + r.h * fy }
}
function zoneRect(layout: Layout, zones: Zone[], id: string | undefined) {
  const z = zones.find((q) => q.id === id) ?? zones[0]
  return z ? toSvg(layout, z.surface, normalizeRect(z.surface, z.rect)) : layout.surfaces.base
}

// Hands in the top view are drawn a little under life size so the laptop stays readable.
const TOP_SCALE = 2.25

/** A 232:148 window over the case, placed so the target sits a little above centre and the hand has room below. */
function topViewBox(layout: Layout, focusY?: number): [number, number, number, number] {
  const b = layout.surfaces.base
  const w = b.w + 120
  const h = w / 1.5676
  const fy = focusY ?? b.y + b.h * 0.55
  const y = Math.min(Math.max(fy - h * 0.42, b.y - 50), b.y + b.h + 120 - h * 0.5)
  return [b.x - 60, y, w, h]
}

/** Right hand reaches in from the lower right, taps, and leaves. */
function approach(t: number, start: number, end: number, p: { x: number; y: number }): { x: number; y: number; a: number } {
  const a = track(t, [
    [start - 0.35, 0],
    [start, 1],
    [end, 1],
    [end + 0.35, 0]
  ])
  return { x: p.x + (1 - a) * 90, y: p.y + (1 - a) * 160, a }
}

// ---------------------------------------------------------------- scene builders

export interface SceneInput {
  family: DeviceFamily
  zones: Zone[]
  zone?: string | null
  /** sequence: both zones in order */
  pair?: [string, string] | null
  modifiers?: Modifier[]
}

function defaultZone(zones: Zone[], want: string[]): string | undefined {
  for (const w of want) if (zones.some((z) => z.id === w)) return w
  return zones.find((z) => z.surface === 'base')?.id ?? zones[0]?.id
}

export function buildScene(id: DemoId, input: SceneInput): Scene {
  const layout = layoutFor(input.family)
  const zones = input.zones
  const vbAt = (p: { y: number }): [number, number, number, number] => topViewBox(layout, p.y)
  const R = 58 // ring radius in top-view units

  const tapScene = (taps: number[], duration: number, pose: Pose = 'point', zoneId?: string): Scene => {
    const zid = zoneId ?? input.zone ?? defaultZone(zones, ['right-palm'])
    const p = zonePoint(layout, zones, zid ?? undefined, 0.52, 0.45)
    const first = taps[0]!
    const last = taps[taps.length - 1]!
    return {
      view: 'top',
      duration,
      still: first + 0.02,
      viewBox: vbAt(p),
      layout,
      frame: (t) => {
        const ap = approach(t, first - 0.25, last + 0.3, p)
        const lift = Math.max(tapLift(t, taps, 1), 1 - ap.a)
        return {
          hands: [{ x: ap.x, y: ap.y, scale: TOP_SCALE, poses: poses(pose), lift, opacity: Math.min(1, ap.a * 1.4), rot: -8 }],
          rings: ringsAt(t, taps, p.x, p.y, R),
          trails: [],
          focus: zid ? [zid] : []
        }
      }
    }
  }

  const slideScene = (zoneId: string | undefined, from: [number, number], to: [number, number], wobble = 0): Scene => {
    const zid = zoneId ?? input.zone ?? defaultZone(zones, ['right-grille', 'right-palm'])
    const r = zoneRect(layout, zones, zid)
    const P = (f: [number, number]): { x: number; y: number } => ({ x: r.x + r.w * f[0], y: r.y + r.h * f[1] })
    const a = P(from)
    const b = P(to)
    return {
      view: 'top',
      duration: 2.2,
      still: 1.0,
      viewBox: vbAt({ y: (a.y + b.y) / 2 }),
      layout,
      frame: (t) => {
        const ap = approach(t, 0.55, 1.55, a)
        const k = track(t, [
          [0.6, 0],
          [1.45, 1]
        ])
        const wob = wobble ? Math.sin(t * 22) * wobble * (t > 0.6 && t < 1.45 ? 1 : 0) : 0
        const x = a.x + (b.x - a.x) * k + (ap.a < 1 ? ap.x - a.x : 0)
        const y = a.y + (b.y - a.y) * k + wob + (ap.a < 1 ? ap.y - a.y : 0)
        const touching = t > 0.58 && t < 1.5
        const trail =
          t > 0.6
            ? [{ d: `M ${a.x} ${a.y} L ${a.x + (b.x - a.x) * k} ${a.y + (b.y - a.y) * k}`, o: t < 1.5 ? 1 : Math.max(0, 1 - (t - 1.5) * 2) }]
            : []
        return {
          hands: [{ x, y, scale: TOP_SCALE, poses: poses('point'), lift: touching ? 0 : Math.max(0.6, 1 - ap.a), opacity: Math.min(1, ap.a * 1.4), rot: -8 }],
          rings: ringsAt(t, [0.6], a.x, a.y, R * 0.8),
          trails: trail,
          focus: zid ? [zid] : []
        }
      }
    }
  }

  const hoverSweep = (dir: -1 | 1, pose: Pose = 'flat'): Scene => {
    const b = layout.surfaces.base
    const kb = toSvg(layout, 'base', layout.spec.keyboard)
    const y = kb.y + kb.h * 0.55
    const x0 = dir < 0 ? b.x + b.w * 0.85 : b.x + b.w * 0.15
    const x1 = dir < 0 ? b.x + b.w * 0.15 : b.x + b.w * 0.85
    return {
      view: 'top',
      duration: 2.0,
      still: 0.9,
      viewBox: vbAt({ y }),
      layout,
      frame: (t) => {
        const k = track(t, [
          [0.3, 0],
          [1.3, 1]
        ])
        const o = track(t, [
          [0.05, 0],
          [0.3, 1],
          [1.3, 1],
          [1.6, 0]
        ])
        return {
          hands: [{ x: x0 + (x1 - x0) * k, y, scale: TOP_SCALE, poses: poses(pose), lift: 1, opacity: o, rot: dir * 18 }],
          rings: [],
          trails: [{ d: `M ${x0} ${y + 120} L ${x0 + (x1 - x0) * k} ${y + 120}`, o: o * 0.6 }],
          focus: []
        }
      }
    }
  }

  // ---- side view (hover, push, pull, waves, lid nudge)
  const SIDE_VB: [number, number, number, number] = [0, 0, 400, 240]
  const sideHand = (x: number, y: number, extra: Partial<HandState> = {}): HandState => ({ x, y, scale: 0.9, poses: poses('side'), lift: 1, ...extra })
  const sideScene = (duration: number, still: number, f: (t: number) => Frame): Scene => ({ view: 'side', duration, still, viewBox: SIDE_VB, frame: f })

  // ---- front view (cover, tilt, camera)
  const FRONT_VB: [number, number, number, number] = [0, 0, 400, 260]
  const SENSOR = { x: 212, y: 38 }
  const frontScene = (duration: number, still: number, f: (t: number) => Frame): Scene => ({ view: 'front', duration, still, viewBox: FRONT_VB, frame: f })
  const pinchHand = (x: number, y: number, closed: number, extra: Partial<HandState> = {}): HandState => ({
    x,
    y,
    scale: 0.8,
    mirror: true,
    rot: 0,
    poses: mix('pinchOpen', 'pinch', closed),
    lift: 1,
    ...extra
  })
  const pinchDrag = (dx: number, dy: number): Scene =>
    frontScene(2.2, 0.9, (t) => {
      const c = track(t, [
        [0.3, 0],
        [0.45, 1],
        [1.25, 1],
        [1.4, 0]
      ])
      const k = track(t, [
        [0.5, 0],
        [1.2, 1]
      ])
      const x = 250 + dx * k
      const y = 110 + dy * k
      return {
        hands: [pinchHand(x, y, c, { opacity: track(t, [[0, 0], [0.2, 1], [1.8, 1], [2.1, 0]]) })],
        rings: ringsAt(t, [0.45], 250, 110, 20),
        trails: t > 0.5 ? [{ d: `M 250 110 L ${x} ${y}`, o: t < 1.4 ? 1 : Math.max(0, 1 - (t - 1.4) * 2) }] : [],
        focus: [],
        camera: true
      }
    })

  const b = layout.surfaces.base
  switch (id) {
    case 'tap':
      return tapScene([0.8], 1.9)
    case 'double':
      return tapScene([0.7, 0.92], 2.0)
    case 'triple':
      return tapScene([0.65, 0.85, 1.05], 2.1)
    case 'rhythm':
      return tapScene([0.55, 1.2, 1.42], 2.5)
    case 'knock_knuckle':
      return tapScene([0.7, 0.94], 2.0, 'knuckle')
    case 'sequence': {
      const [za, zb] = input.pair ?? [defaultZone(zones, ['left-palm'])!, defaultZone(zones, ['right-palm'])!]
      const pa = zonePoint(layout, zones, za, 0.5, 0.45)
      const pb = zonePoint(layout, zones, zb, 0.5, 0.45)
      return {
        view: 'top',
        duration: 2.4,
        still: 0.62,
        viewBox: vbAt({ y: (pa.y + pb.y) / 2 }),
        layout,
        frame: (t) => {
          const k = track(t, [
            [0.72, 0],
            [1.05, 1]
          ])
          const ap = approach(t, 0.35, 1.4, pa)
          const x = pa.x + (pb.x - pa.x) * k + (ap.a < 1 ? ap.x - pa.x : 0)
          const y = pa.y + (pb.y - pa.y) * k - Math.sin(k * Math.PI) * 60 + (ap.a < 1 ? ap.y - pa.y : 0)
          return {
            hands: [{ x, y, scale: TOP_SCALE, poses: poses('point'), lift: Math.max(tapLift(t, [0.6, 1.15]), 1 - ap.a), opacity: Math.min(1, ap.a * 1.4), rot: -8 }],
            rings: [...ringsAt(t, [0.6], pa.x, pa.y, R), ...ringsAt(t, [1.15], pb.x, pb.y, R)],
            trails: [],
            focus: [za, zb]
          }
        }
      }
    }
    case 'modifier_tap': {
      const scene = tapScene([1.0], 2.2)
      const { keys } = keyboardKeys(toSvg(layout, 'base', layout.spec.keyboard))
      // Row order in keyboardKeys: fn row (13 keys after Touch ID is removed), then 14, 14, 13, 12 (shift row starts at index 54).
      const mod = input.modifiers?.[0] ?? 'shift'
      const idx = mod === 'shift' ? 54 : mod === 'command' ? 69 : mod === 'option' ? 68 : mod === 'control' ? 67 : 66
      const kc = keys[Math.min(idx, keys.length - 1)]!
      const pz = zonePoint(layout, zones, input.zone ?? defaultZone(zones, ['right-palm']), 0.52, 0.45)
      return {
        ...scene,
        viewBox: vbAt({ y: (kc.y + pz.y) / 2 + 60 }),
        frame: (t) => {
          const f = scene.frame(t)
          const v = track(t, [
            [0.2, 0],
            [0.35, 1],
            [1.45, 1],
            [1.6, 0]
          ])
          const a = track(t, [
            [0, 0],
            [0.25, 1],
            [1.55, 1],
            [1.9, 0]
          ])
          return {
            ...f,
            key: { ...kc, v },
            hands: [
              { x: kc.x + kc.w * 0.5 - (1 - a) * 80, y: kc.y + kc.h * 0.5 + (1 - a) * 160, scale: TOP_SCALE, mirror: true, poses: poses('point'), lift: 1 - v, opacity: a, rot: 10 },
              ...f.hands
            ]
          }
        }
      }
    }
    case 'rub':
      return slideScene(defaultZone(zones, input.zone ? [input.zone] : ['right-grille', 'right-palm']), [0.5, 0.35], [0.5, 0.6], 10)
    case 'rub_left':
      return slideScene(input.zone ?? defaultZone(zones, ['right-palm']), [0.75, 0.5], [0.25, 0.5])
    case 'rub_right':
      return slideScene(input.zone ?? defaultZone(zones, ['right-palm']), [0.25, 0.5], [0.75, 0.5])
    case 'finger_slide_up':
      return slideScene(defaultZone(zones, ['right-grille', 'right-palm']), [0.5, 0.85], [0.5, 0.15])
    case 'finger_slide_down':
      return slideScene(defaultZone(zones, ['right-grille', 'right-palm']), [0.5, 0.15], [0.5, 0.85])
    case 'finger_slide_left':
      return slideScene(defaultZone(zones, ['top-strip', 'right-palm']), [0.8, 0.5], [0.2, 0.5])
    case 'finger_slide_right':
      return slideScene(defaultZone(zones, ['top-strip', 'right-palm']), [0.2, 0.5], [0.8, 0.5])
    case 'sweep_left':
    case 'wave_sweep':
      return hoverSweep(-1)
    case 'sweep_right':
      return hoverSweep(1)
    case 'palm_swipe_left':
    case 'palm_swipe_right': {
      const dir = id === 'palm_swipe_left' ? -1 : 1
      return frontScene(2.0, 0.9, (t) => {
        const k = track(t, [
          [0.35, 0],
          [1.25, 1]
        ])
        const o = track(t, [
          [0.05, 0],
          [0.35, 1],
          [1.25, 1],
          [1.6, 0]
        ])
        const x0 = dir < 0 ? 290 : 110
        const x1 = dir < 0 ? 110 : 290
        return {
          hands: [{ x: x0 + (x1 - x0) * k, y: 70, scale: 0.9, poses: poses('flat'), lift: 1, opacity: o, rot: dir * -10 }],
          rings: [],
          trails: [{ d: `M ${x0} 190 L ${x0 + (x1 - x0) * k} 190`, o: o * 0.6 }],
          focus: [],
          camera: true
        }
      })
    }
    case 'hover_level':
      return sideScene(3.2, 1.2, (t) => {
        const h = 0.5 + 0.42 * Math.sin((t / 3.2) * Math.PI * 2)
        return { hands: [sideHand(262, 170 - h * 80)], rings: [], trails: [], focus: [], level: h, sonar: t }
      })
    case 'push':
    case 'wave_toward':
    case 'pull':
    case 'wave_away': {
      const toward = id === 'push' || id === 'wave_toward'
      const quick = id.startsWith('wave')
      const dur = quick ? 1.6 : 2.2
      return sideScene(dur, dur * 0.45, (t) => {
        const k = track(t, [
          [0.25, 0],
          [quick ? 0.7 : 1.3, 1]
        ])
        const x = toward ? 170 + k * 100 : 270 - k * 100
        const o = track(t, [
          [0, 0],
          [0.2, 1],
          [dur - 0.4, 1],
          [dur - 0.1, 0]
        ])
        return {
          hands: [sideHand(x, 128, { opacity: o })],
          rings: [],
          trails: [{ d: `M ${toward ? 170 : 270} 150 L ${x} 150`, o: o * 0.6 }],
          focus: [],
          sonar: t
        }
      })
    }
    case 'lid_nudge':
      return sideScene(2.4, 1.0, (t) => {
        const push = track(t, [
          [0.6, 0],
          [0.95, 1],
          [1.25, 1],
          [1.6, 0]
        ])
        const lid = push * 9
        // Fingertip on the top edge of the lid: follow the lid as it tips back.
        const ang = ((110 + lid) * Math.PI) / 180
        const tipX = 300 - Math.cos(ang) * 150
        const tipY = 196 - Math.sin(ang) * 150
        const ap = track(t, [
          [0.1, 0],
          [0.55, 1],
          [1.7, 1],
          [2.1, 0]
        ])
        return {
          hands: [sideHand(tipX - (1 - ap) * 60, tipY + 4 - (1 - ap) * 20, { rot: -12, lift: push > 0 ? 0 : 1, opacity: ap })],
          rings: ringsAt(t, [0.62], tipX, tipY, 18),
          trails: [],
          focus: [],
          lid
        }
      })
    case 'cover':
    case 'cover_hold': {
      const hold = id === 'cover_hold'
      const dur = hold ? 3.0 : 2.0
      const off = hold ? 1.9 : 0.95
      return frontScene(dur, 0.8, (t) => {
        const k = track(t, [
          [0.2, 0],
          [0.6, 1],
          [off, 1],
          [off + 0.4, 0]
        ])
        // Palm down over the sensor, fingers pointing down the screen.
        return {
          hands: [{ x: SENSOR.x - 4, y: SENSOR.y - 36 + (1 - k) * 150, scale: 0.85, rot: 0, poses: poses('flat'), lift: 1 - k * 0.6, opacity: Math.min(1, k * 2) }],
          rings: ringsAt(t, [0.6], SENSOR.x, SENSOR.y, 18),
          trails: [],
          focus: [],
          dim: k,
          hold: hold ? track(t, [
            [0.6, 0],
            [1.8, 1],
            [1.9, 1],
            [2.0, 0]
          ]) : undefined
        }
      })
    }
    case 'tilt_left':
    case 'tilt_right': {
      const dir = id === 'tilt_left' ? -1 : 1
      return frontScene(2.2, 0.95, (t) => {
        const roll =
          dir *
          track(t, [
            [0.4, 0],
            [0.85, 9],
            [1.25, 9],
            [1.7, 0]
          ])
        return {
          hands: [
            { x: 64, y: 199, scale: 0.62, rot: 90, poses: poses('flat'), lift: 0 },
            { x: 336, y: 199, scale: 0.62, rot: -90, mirror: true, poses: poses('flat'), lift: 0 }
          ],
          rings: [],
          trails: [],
          focus: [],
          roll
        }
      })
    }
    case 'air_tap':
      return frontScene(1.8, 0.62, (t) => {
        const c = track(t, [
          [0.45, 0],
          [0.6, 1],
          [0.8, 1],
          [0.95, 0]
        ])
        return { hands: [pinchHand(250, 110, c)], rings: ringsAt(t, [0.6], 250, 110, 20), trails: [], focus: [], camera: true }
      })
    case 'pinch_hold':
      return frontScene(3.0, 1.2, (t) => {
        const c = track(t, [
          [0.3, 0],
          [0.45, 1],
          [2.3, 1],
          [2.45, 0]
        ])
        const v = track(t, [
          [0.5, 0.35],
          [1.3, 0.85],
          [2.2, 0.35]
        ])
        return {
          hands: [pinchHand(250, 170 - v * 110, c)],
          rings: ringsAt(t, [0.45], 250, 170 - 0.35 * 110, 20),
          trails: [],
          focus: [],
          dial: v,
          camera: true
        }
      })
    case 'pinch_drag_left':
      return pinchDrag(-110, 0)
    case 'pinch_drag_right':
      return pinchDrag(60, 0)
    case 'pinch_drag_up':
      return pinchDrag(0, -60)
    case 'pinch_drag_down':
      return pinchDrag(0, 60)
    case 'circle_cw':
    case 'circle_ccw': {
      const dir = id === 'circle_cw' ? 1 : -1
      return frontScene(2.4, 0.9, (t) => {
        const k = track(t, [
          [0.3, 0],
          [1.9, 1]
        ])
        const ang = -Math.PI / 2 + dir * k * Math.PI * 2
        const cx = 200
        const cy = 108
        const r = 44
        const x = cx + Math.cos(ang) * r
        const y = cy + Math.sin(ang) * r
        const end = -Math.PI / 2 + dir * k * Math.PI * 2
        const large = k > 0.5 ? 1 : 0
        const sweep = dir > 0 ? 1 : 0
        const arc = k > 0.01 ? `M ${cx} ${cy - r} A ${r} ${r} 0 ${large} ${sweep} ${cx + Math.cos(end) * r} ${cy + Math.sin(end) * r}` : ''
        const ticks = Math.floor(k * 12)
        const o = track(t, [
          [0, 0],
          [0.2, 1],
          [2.0, 1],
          [2.3, 0]
        ])
        return {
          hands: [{ x, y, scale: 0.9, poses: poses('point'), lift: 1, opacity: o, rot: -6 }],
          rings: Array.from({ length: ticks }, (_, i) => {
            const at = 0.3 + ((i + 1) / 12) * 1.6
            const a = -Math.PI / 2 + dir * ((i + 1) / 12) * Math.PI * 2
            return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, age: t - at, r: 6 }
          }).filter((q) => q.age < 0.5),
          trails: arc ? [{ d: arc, o }] : [],
          focus: [],
          camera: true
        }
      })
    }
    case 'two_hand_zoom':
      return frontScene(2.6, 1.2, (t) => {
        const c = track(t, [
          [0.3, 0],
          [0.45, 1],
          [1.9, 1],
          [2.05, 0]
        ])
        const s = track(t, [
          [0.5, 0],
          [1.6, 1]
        ])
        const dx = 30 + s * 60
        return {
          hands: [pinchHand(200 + dx, 112, c), { ...pinchHand(200 - dx, 112, c), mirror: false }],
          rings: [],
          trails: [],
          focus: [],
          zoom: s,
          camera: true
        }
      })
    case 'point':
      return frontScene(2.6, 1.0, (t) => {
        const x = 200 + Math.sin((t / 2.6) * Math.PI * 2) * 70
        const y = 104 + Math.sin((t / 2.6) * Math.PI * 4) * 28
        return { hands: [{ x, y: y + 34, scale: 0.9, poses: poses('point'), lift: 1, rot: -4 }], rings: [], trails: [], focus: [], cursor: { x, y: y - 10 }, camera: true }
      })
  }
  void b
  return tapScene([0.8], 1.9)
}
