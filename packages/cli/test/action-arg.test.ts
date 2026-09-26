import { describe, expect, it } from 'vitest'
import { ActionArgError, resolveActionArg } from '../src/action-arg.js'
import type { Preset } from '../src/presets.js'

const presets: Preset[] = [
  {
    id: 'vol-up',
    title: 'Volume up',
    subtitle: 'Turns the volume up.',
    category: 'Media',
    keywords: ['sound'],
    action: { kind: 'volume', step: 6 },
    destructive: false,
    requires: [],
    apps: ['*']
  }
]

describe('resolveActionArg', () => {
  it('parses inline JSON', () => {
    const result = resolveActionArg('{"kind":"mute"}', null)
    expect(result.action).toEqual({ kind: 'mute' })
    expect(result.label).toBeUndefined()
  })

  it('rejects invalid JSON', () => {
    expect(() => resolveActionArg('{not json', null)).toThrow(ActionArgError)
    expect(() => resolveActionArg('{not json', null)).toThrow(/invalid action JSON/)
  })

  it('rejects JSON that is not a valid action', () => {
    expect(() => resolveActionArg('{"kind":"nonsense"}', null)).toThrow(/invalid action/)
  })

  it('resolves a known preset id and carries its title as the label', () => {
    const result = resolveActionArg('vol-up', presets)
    expect(result.action).toEqual({ kind: 'volume', step: 6 })
    expect(result.label).toBe('Volume up')
  })

  it('is case-insensitive on the preset id', () => {
    expect(resolveActionArg('VOL-UP', presets).label).toBe('Volume up')
  })

  it('rejects an unknown preset id when a library is present', () => {
    expect(() => resolveActionArg('does-not-exist', presets)).toThrow(/no preset "does-not-exist"/)
  })

  it('gives a clear error for a preset id when no library is present', () => {
    expect(() => resolveActionArg('vol-up', null)).toThrow(/no preset library was found/)
  })
})
