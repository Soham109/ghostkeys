import { describe, expect, it } from 'vitest'
import { detectConflicts } from '../src/conflicts.js'
import { composeOffline } from '../src/compose.js'
import { makeContext } from './fixtures.js'

const existing = makeContext().config.bindings

describe('detectConflicts', () => {
  it('finds an exact duplicate in the same app layer', () => {
    const c = detectConflicts({ id: 'n', gesture: 'double', zone: 'right-grille', modifiers: [], app: '*' }, existing)
    expect(c).toHaveLength(1)
    expect(c[0]?.kind).toBe('duplicate')
    expect(c[0]?.bindingId).toBe('b1')
  })
  it('reports an app-specific binding that overrides a global one', () => {
    const c = detectConflicts({ id: 'n', gesture: 'double', zone: 'right-grille', modifiers: [], app: 'com.microsoft.Excel' }, existing)
    expect(c[0]?.kind).toBe('overrides')
  })
  it('reports a global binding that is overridden inside one app', () => {
    const c = detectConflicts({ id: 'n', gesture: 'tap', zone: 'left-palm', modifiers: [], app: '*' }, existing)
    expect(c[0]?.kind).toBe('overridden')
  })
  it('treats modifiers as an unordered set and flags disabled bindings', () => {
    const c = detectConflicts({ id: 'n', gesture: 'triple', zone: 'lid', modifiers: ['shift'], app: '*' }, existing)
    expect(c[0]?.enabled).toBe(false)
    expect(c[0]?.message).toMatch(/disabled/)
    expect(detectConflicts({ id: 'n', gesture: 'triple', zone: 'lid', modifiers: [], app: '*' }, existing)).toEqual([])
  })
  it('does not confuse different gestures, zones or apps', () => {
    expect(detectConflicts({ id: 'n', gesture: 'tap', zone: 'right-grille', modifiers: [], app: '*' }, existing)).toEqual([])
    expect(detectConflicts({ id: 'n', gesture: 'tap', zone: 'left-palm', modifiers: [], app: 'com.apple.Safari' }, existing)).toEqual([])
  })
  it('compares sequences by ordered zones', () => {
    const seq = [{ id: 's', gesture: 'sequence', zone: 'left-palm', zones: ['left-palm', 'right-palm'], modifiers: [], app: '*' }]
    expect(detectConflicts({ id: 'n', gesture: 'sequence', zone: 'left-palm', zones: ['left-palm', 'right-palm'], app: '*' }, seq)).toHaveLength(1)
    expect(detectConflicts({ id: 'n', gesture: 'sequence', zone: 'right-palm', zones: ['right-palm', 'left-palm'], app: '*' }, seq)).toEqual([])
  })
  it('is reported by compose', () => {
    const r = composeOffline('double tap the right grille to go to the next track', makeContext())
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.conflicts.map((c) => c.kind)).toEqual(['duplicate'])
  })
})
