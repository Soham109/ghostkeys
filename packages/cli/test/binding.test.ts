import type { Binding, Zone } from '@ghostkeys/sdk'
import { describe, expect, it } from 'vitest'
import { buildBinding, describeBinding, nextBindingId, unknownZones } from '../src/binding.js'
import { parseBindSpec } from '../src/grammar.js'

function zone(id: string): Zone {
  return { id, name: id, surface: 'base', rect: { x: 0, y: 0, w: 1, h: 1 }, color: '#fff' }
}

describe('nextBindingId', () => {
  it('starts at b1 with no existing bindings', () => {
    expect(nextBindingId([])).toBe('b1')
  })

  it('continues after the highest bN id', () => {
    const bindings = [{ id: 'b1' }, { id: 'b3' }, { id: 'b2' }] as Binding[]
    expect(nextBindingId(bindings)).toBe('b4')
  })

  it('falls back to a non-bN id when ids do not follow the bN convention', () => {
    const bindings = [{ id: 'custom-one' }] as Binding[]
    expect(nextBindingId(bindings)).toMatch(/^b-/)
  })
})

describe('unknownZones', () => {
  const zones = [zone('left-palm'), zone('right-palm')]

  it('is empty when the zone exists', () => {
    const spec = parseBindSpec('double left-palm')
    expect(unknownZones(spec, zones)).toEqual([])
  })

  it('reports a single unknown zone', () => {
    const spec = parseBindSpec('double top-strip')
    expect(unknownZones(spec, zones)).toEqual(['top-strip'])
  })

  it('reports unknown zones from a sequence pair', () => {
    const spec = parseBindSpec('sequence left-palm,top-strip')
    expect(unknownZones(spec, zones)).toEqual(['top-strip'])
  })

  it('is empty for a zoneless gesture', () => {
    const spec = parseBindSpec('cover_hold')
    expect(unknownZones(spec, zones)).toEqual([])
  })
})

describe('buildBinding', () => {
  it('builds a binding from a parsed spec and an action', () => {
    const spec = parseBindSpec('double right-grille +shift @com.microsoft.Excel')
    const binding = buildBinding(spec, { kind: 'volume', step: 6 }, { id: 'b1' })
    expect(binding).toEqual({
      id: 'b1',
      enabled: true,
      gesture: 'double',
      zone: 'right-grille',
      zones: null,
      modifiers: ['shift'],
      app: 'com.microsoft.Excel',
      action: { kind: 'volume', step: 6 },
      label: 'volume up 6%'
    })
  })

  it('honors enabled: false and an explicit label', () => {
    const spec = parseBindSpec('tap left-palm')
    const binding = buildBinding(spec, { kind: 'mute' }, { id: 'b2', enabled: false, label: 'Mute toggle' })
    expect(binding.enabled).toBe(false)
    expect(binding.label).toBe('Mute toggle')
  })
})

describe('describeBinding', () => {
  it('reads naturally for a zoned binding', () => {
    const spec = parseBindSpec('double right-grille +shift @com.microsoft.Excel')
    const binding = buildBinding(spec, { kind: 'volume', step: 6 }, { id: 'b1' })
    expect(describeBinding(binding)).toBe('double +shift right-grille in com.microsoft.Excel -> volume up 6%')
  })

  it('reads naturally for a zoneless, unrestricted binding', () => {
    const spec = parseBindSpec('cover_hold')
    const binding = buildBinding(spec, { kind: 'system', op: 'lock' }, { id: 'b2' })
    expect(describeBinding(binding)).toBe('cover_hold anywhere -> system: lock')
  })

  it('joins a sequence zone pair with "then"', () => {
    const spec = parseBindSpec('sequence left-palm,right-palm')
    const binding = buildBinding(spec, { kind: 'window', op: 'maximize' }, { id: 'b3' })
    expect(describeBinding(binding)).toContain('left-palm then right-palm')
  })
})
