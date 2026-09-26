import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIBRARY_PATH, loadPresetLibrary, parsePresetLibrary } from '../src/presets.js'

describe('preset library', () => {
  it('points at presets/library.json at the repo root', () => {
    expect(DEFAULT_LIBRARY_PATH.replace(/\\/g, '/')).toMatch(/ghostkeys\/presets\/library\.json$/)
  })
  it('tolerates a missing or broken file', () => {
    expect(loadPresetLibrary('/nonexistent/library.json')).toEqual([])
    const dir = mkdtempSync(join(tmpdir(), 'gk-'))
    writeFileSync(join(dir, 'bad.json'), '{not json')
    expect(loadPresetLibrary(join(dir, 'bad.json'))).toEqual([])
  })
  it('accepts an array or { presets }, keeps valid actions and drops invalid ones', () => {
    const list = [
      { id: 'a', name: 'Lock', keywords: 'lock screen', action: { kind: 'system', op: 'lock' } },
      { id: 'b', name: 'Bad', action: { kind: 'teleport' } },
      { name: 'No id', action: { kind: 'mute' } }
    ]
    expect(parsePresetLibrary(list).map((p) => p.id)).toEqual(['a'])
    expect(parsePresetLibrary({ presets: list })[0]?.keywords).toEqual(['lock', 'screen'])
    expect(parsePresetLibrary('nope')).toEqual([])
  })
})
