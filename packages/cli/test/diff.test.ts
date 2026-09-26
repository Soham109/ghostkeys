import type { Config } from '@ghostkeys/sdk'
import { describe, expect, it } from 'vitest'
import { diffConfig } from '../src/diff.js'

function baseConfig(): Config {
  return {
    version: 1,
    zones: [{ id: 'left-palm', name: 'Left palm rest', surface: 'base', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff' }],
    bindings: [
      {
        id: 'b1',
        enabled: true,
        gesture: 'double',
        zone: 'left-palm',
        zones: null,
        modifiers: [],
        app: '*',
        action: { kind: 'mute' },
        label: 'Mute'
      }
    ],
    settings: {
      sensitivity: 0.5,
      typingGateMs: 450,
      doubleWindowMs: 350,
      minConfidence: 0.8,
      hud: true,
      haptics: false,
      sound: { enabled: false, sessionSeconds: 30, autoApps: [] },
      camera: { enabled: false, sessionSeconds: 30, autoApps: [], deskMode: false }
    }
  }
}

function stripColor(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

describe('diffConfig', () => {
  it('reports no changes for an identical config', () => {
    const config = baseConfig()
    expect(diffConfig(config, structuredClone(config)).map(stripColor)).toEqual(['  no changes'])
  })

  it('reports an added zone', () => {
    const current = baseConfig()
    const next = structuredClone(current)
    next.zones.push({ id: 'right-palm', name: 'Right palm rest', surface: 'base', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#000' })
    const lines = diffConfig(current, next).map(stripColor)
    expect(lines).toContain('  + zone right-palm')
  })

  it('reports a removed binding', () => {
    const current = baseConfig()
    const next = structuredClone(current)
    next.bindings = []
    const lines = diffConfig(current, next).map(stripColor)
    expect(lines).toContain('  - binding b1')
  })

  it('reports a changed binding', () => {
    const current = baseConfig()
    const next = structuredClone(current)
    next.bindings[0]!.enabled = false
    const lines = diffConfig(current, next).map(stripColor)
    expect(lines).toContain('  ~ binding b1')
  })

  it('reports a changed setting with before and after values', () => {
    const current = baseConfig()
    const next = structuredClone(current)
    next.settings.sensitivity = 0.9
    const lines = diffConfig(current, next).map(stripColor)
    expect(lines).toContain('  ~ settings.sensitivity: 0.5 to 0.9')
  })
})
