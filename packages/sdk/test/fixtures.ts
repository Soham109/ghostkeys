import type { Config } from '../src/protocol/types.js'

export function testConfig(): Config {
  return {
    version: 1,
    zones: [
      { id: 'left-palm', name: 'Left palm rest', surface: 'base', rect: { x: 0.04, y: 0.62, w: 0.28, h: 0.34 }, color: '#3DDC97' },
      { id: 'right-grille', name: 'Right grille', surface: 'base', rect: { x: 0.88, y: 0.08, w: 0.1, h: 0.45 }, color: '#7C5CFF' }
    ],
    bindings: [
      {
        id: 'b1',
        enabled: true,
        gesture: 'double',
        zone: 'right-grille',
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'volume', step: 6 },
        label: 'Volume up'
      }
    ],
    settings: {
      sensitivity: 0.5,
      typingGateMs: 450,
      doubleWindowMs: 350,
      minConfidence: 0.8,
      followUpConfidence: 0.5,
      lightTouch: false,
      learnFromUse: true,
      hud: true,
      haptics: false,
      sound: { enabled: false, sessionSeconds: 30, autoApps: [] },
      camera: { enabled: false, sessionSeconds: 30, autoApps: [], deskMode: false },
      sonar: { enabled: false, sessionSeconds: 30, autoApps: [] }
    }
  }
}
