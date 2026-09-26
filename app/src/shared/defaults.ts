import type { Config, DeviceFamily, Zone } from './protocol'
import { LAPTOPS } from './laptop'

/** Zone palette. Muted, distinct in both themes; the app accent is kept out of it on purpose. */
export const ZONE_COLORS = ['#6E9BFF', '#4FC9B0', '#B58CFF', '#FF7A93', '#8AC96B', '#5FB8E8', '#E58CD6', '#9AA7FF']

export function defaultZones(family: DeviceFamily): Zone[] {
  const spec = LAPTOPS[family]
  const tp = spec.trackpad
  const r3 = (v: number): number => Math.round(v * 1000) / 1000
  const palmW = r3(tp.x - 0.06)
  const zones: Zone[] = [
    { id: 'left-palm', name: 'Left palm rest', surface: 'base', rect: { x: 0.03, y: tp.y, w: palmW, h: r3(tp.h - 0.02) }, color: ZONE_COLORS[0]! },
    {
      id: 'right-palm',
      name: 'Right palm rest',
      surface: 'base',
      rect: { x: r3(tp.x + tp.w + 0.03), y: tp.y, w: palmW, h: r3(tp.h - 0.02) },
      color: ZONE_COLORS[1]!
    }
  ]
  if (spec.grilles) {
    const [l, r] = spec.grilles
    zones.push(
      { id: 'left-grille', name: 'Left grille', surface: 'base', rect: { ...l }, color: ZONE_COLORS[2]! },
      { id: 'right-grille', name: 'Right grille', surface: 'base', rect: { ...r }, color: ZONE_COLORS[3]! }
    )
  }
  zones.push(
    { id: 'top-strip', name: 'Top strip', surface: 'base', rect: { x: 0.2, y: 0.012, w: 0.6, h: 0.05 }, color: ZONE_COLORS[4]! },
    { id: 'left-edge', name: 'Left edge', surface: 'edge-left', rect: { x: 0, y: 0.2, w: 1, h: 0.6 }, color: ZONE_COLORS[5]! },
    { id: 'right-edge', name: 'Right edge', surface: 'edge-right', rect: { x: 0, y: 0.2, w: 1, h: 0.6 }, color: ZONE_COLORS[6]! },
    { id: 'lid', name: 'Lid', surface: 'lid', rect: { x: 0.3, y: 0.2, w: 0.4, h: 0.6 }, color: ZONE_COLORS[7]! }
  )
  return zones
}

export function defaultConfig(family: DeviceFamily): Config {
  return {
    version: 1,
    zones: defaultZones(family),
    bindings: [
      {
        id: 'b1',
        enabled: true,
        gesture: 'double',
        zone: 'right-palm',
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'media', command: 'playpause' },
        label: 'Play or pause'
      },
      {
        id: 'b2',
        enabled: true,
        gesture: 'tap',
        zone: family.startsWith('macbook-pro') ? 'right-grille' : 'right-edge',
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'volume', step: 6 },
        label: 'Volume up'
      },
      {
        id: 'b3',
        enabled: true,
        gesture: 'tap',
        zone: family.startsWith('macbook-pro') ? 'left-grille' : 'left-edge',
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'volume', step: -6 },
        label: 'Volume down'
      },
      {
        id: 'b4',
        enabled: true,
        gesture: 'double',
        zone: 'left-palm',
        zones: null,
        modifiers: [],
        app: 'com.microsoft.Excel',
        action: { kind: 'keystroke', key: 't', modifiers: ['command', 'shift'] },
        label: 'AutoSum'
      },
      {
        id: 'b5',
        enabled: true,
        gesture: 'sequence',
        zone: null,
        zones: ['left-palm', 'right-palm'],
        modifiers: [],
        app: '*',
        action: { kind: 'window', op: 'maximize' },
        label: 'Fill the screen'
      },
      {
        id: 'b6',
        enabled: true,
        gesture: 'cover_hold',
        zone: null,
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'system', op: 'lock' },
        label: 'Lock screen'
      },
      {
        id: 'b7',
        enabled: false,
        gesture: 'lid_nudge',
        zone: null,
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'system', op: 'dnd-toggle' },
        label: 'Toggle Do Not Disturb'
      },
      {
        id: 'b8',
        enabled: true,
        gesture: 'triple',
        zone: 'top-strip',
        zones: null,
        modifiers: ['shift'],
        app: '*',
        action: { kind: 'system', op: 'screenshot-area' },
        label: 'Screenshot of an area'
      }
    ],
    settings: { sensitivity: 0.5, typingGateMs: 450, doubleWindowMs: 350, minConfidence: 0.8, hud: true, haptics: false }
  }
}
