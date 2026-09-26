import type { ComposeContext, Preset } from '../src/types.js'
import type { Zone } from '../src/schema.js'

const Z = (id: string, name: string, surface: Zone['surface'], x: number, y: number): Zone => ({
  id,
  name,
  surface,
  rect: { x, y, w: 0.1, h: 0.2 },
  color: '#7C5CFF'
})

export const ZONES: Zone[] = [
  Z('left-palm', 'Left palm', 'base', 0.05, 0.6),
  Z('right-palm', 'Right palm', 'base', 0.75, 0.6),
  Z('left-grille', 'Left grille', 'base', 0.02, 0.08),
  Z('right-grille', 'Right grille', 'base', 0.88, 0.08),
  Z('top-strip', 'Top strip', 'base', 0.2, 0.01),
  Z('left-edge', 'Left edge', 'edge-left', 0, 0.3),
  Z('right-edge', 'Right edge', 'edge-right', 0.99, 0.3),
  Z('lid', 'Lid', 'lid', 0.4, 0.4)
]

export const PRESETS: Preset[] = [
  { id: 'zoom-mute', name: 'Mute in Zoom', category: 'Media', keywords: ['meeting', 'call', 'microphone', 'zoom'], app: 'us.zoom.xos', action: { kind: 'keystroke', key: 'a', modifiers: ['command', 'shift'] } },
  { id: 'meet-mute', name: 'Mute in Google Meet', category: 'Media', keywords: ['meeting', 'call', 'microphone', 'meet'], app: 'com.google.Chrome', action: { kind: 'keystroke', key: 'd', modifiers: ['command'] } },
  { id: 'xl-paste-values', name: 'Paste values only', category: 'Excel and Sheets', keywords: ['paste', 'values', 'excel'], app: 'com.microsoft.Excel', action: { kind: 'keystroke', key: 'v', modifiers: ['command', 'shift'] } },
  { id: 'dev-palette', name: 'VS Code command palette', category: 'Dev', keywords: ['palette', 'vscode', 'commands'], app: 'com.microsoft.VSCode', action: { kind: 'keystroke', key: 'p', modifiers: ['command', 'shift'] } }
]

export function makeContext(over: Partial<ComposeContext> = {}): ComposeContext {
  return {
    config: {
      zones: ZONES,
      bindings: [
        { id: 'b1', enabled: true, gesture: 'double', zone: 'right-grille', zones: null, modifiers: [], app: '*', label: 'Volume up' },
        { id: 'b2', enabled: true, gesture: 'tap', zone: 'left-palm', zones: null, modifiers: [], app: 'com.microsoft.Excel', label: 'AutoSum' },
        { id: 'b3', enabled: false, gesture: 'triple', zone: 'lid', zones: null, modifiers: ['shift'], app: '*', label: 'Screenshot' }
      ]
    },
    frontmostApp: { bundleId: 'com.microsoft.Excel', name: 'Microsoft Excel' },
    presets: PRESETS,
    device: { model: 'Mac17,8', family: 'macbook-pro-14', sensors: { imu: true, gyro: true, lid: true, light: true } },
    ...over
  }
}
