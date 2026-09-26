import { describe, expect, it } from 'vitest'
import { findPreset, loadPresets, presetsLibraryPath, searchPresets, type Preset } from '../src/presets.js'

function preset(overrides: Partial<Preset>): Preset {
  return {
    id: 'vol-up',
    title: 'Volume up',
    subtitle: 'Turns the volume up a bit.',
    category: 'Media',
    keywords: ['sound', 'louder'],
    action: { kind: 'volume', step: 6 },
    destructive: false,
    requires: [],
    apps: ['*'],
    ...overrides
  }
}

const fixture: Preset[] = [
  preset({ id: 'vol-up', title: 'Volume up', category: 'Media', keywords: ['sound', 'louder'] }),
  preset({ id: 'vol-down', title: 'Volume down', category: 'Media', keywords: ['sound', 'quieter'] }),
  preset({
    id: 'xl-autosum',
    title: 'AutoSum',
    category: 'Excel',
    keywords: ['sum', 'formula'],
    apps: ['com.microsoft.Excel'],
    action: { kind: 'keystroke', key: 't', modifiers: ['command', 'shift'] }
  }),
  preset({ id: 'app-quit', title: 'Quit frontmost app', category: 'Apps', destructive: true, action: { kind: 'app', op: 'quit' } })
]

describe('searchPresets', () => {
  it('returns everything for an empty query', () => {
    expect(searchPresets(fixture, '')).toHaveLength(fixture.length)
    expect(searchPresets(fixture, '   ')).toHaveLength(fixture.length)
  })

  it('matches by id', () => {
    expect(searchPresets(fixture, 'xl-autosum').map((p) => p.id)).toEqual(['xl-autosum'])
  })

  it('matches by title, case-insensitively', () => {
    expect(searchPresets(fixture, 'AUTOSUM').map((p) => p.id)).toEqual(['xl-autosum'])
  })

  it('matches by category', () => {
    expect(searchPresets(fixture, 'media').map((p) => p.id).sort()).toEqual(['vol-down', 'vol-up'])
  })

  it('matches by keyword', () => {
    expect(searchPresets(fixture, 'quieter').map((p) => p.id)).toEqual(['vol-down'])
  })

  it('matches by app bundle id', () => {
    expect(searchPresets(fixture, 'microsoft.excel').map((p) => p.id)).toEqual(['xl-autosum'])
  })

  it('returns nothing for a query that matches no preset', () => {
    expect(searchPresets(fixture, 'nonexistent-thing')).toEqual([])
  })
})

describe('findPreset', () => {
  it('finds by exact id', () => {
    expect(findPreset(fixture, 'vol-up')?.title).toBe('Volume up')
  })

  it('is case-insensitive', () => {
    expect(findPreset(fixture, 'VOL-UP')?.title).toBe('Volume up')
  })

  it('returns undefined for an unknown id', () => {
    expect(findPreset(fixture, 'nope')).toBeUndefined()
  })
})

describe('loadPresets against the real repo library', () => {
  it('loads presets/library.json when it is present, with the expected shape', async () => {
    const presets = await loadPresets()
    if (presets === null) {
      // Not every checkout will have presets/library.json yet; that's a valid state gk handles gracefully.
      console.warn(`no preset library at ${presetsLibraryPath()}, skipping shape assertions`)
      return
    }
    expect(presets.length).toBeGreaterThan(0)
    for (const p of presets.slice(0, 5)) {
      expect(typeof p.id).toBe('string')
      expect(typeof p.title).toBe('string')
      expect(Array.isArray(p.apps)).toBe(true)
      expect(typeof p.action.kind).toBe('string')
    }
  })
})
