import type { Config, DeviceFamily, Zone } from './protocol'
import zoneDefaults from './zone-defaults.json'

/** Zone palette. Muted, distinct in both themes; the app accent is kept out of it on purpose. */
export const ZONE_COLORS = ['#6E9BFF', '#4FC9B0', '#B58CFF', '#FF7A93', '#8AC96B', '#5FB8E8', '#E58CD6', '#9AA7FF']

/** Canonical default zones per MacBook family, shared with the daemon (zone-defaults.json). */
export function defaultZones(family: DeviceFamily): Zone[] {
  const f = (zoneDefaults.families as Record<string, { zones: Zone[] }>)[family] ?? zoneDefaults.families['macbook-pro-14']
  return structuredClone(f.zones) as Zone[]
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
