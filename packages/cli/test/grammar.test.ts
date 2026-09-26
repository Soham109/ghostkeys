import { describe, expect, it } from 'vitest'
import { BindGrammarError, parseBindSpec } from '../src/grammar.js'

describe('parseBindSpec', () => {
  it('parses a plain gesture + zone', () => {
    expect(parseBindSpec('double right-grille')).toEqual({
      gesture: 'double',
      zone: 'right-grille',
      zones: null,
      modifiers: [],
      app: '*'
    })
  })

  it('is case-insensitive on the gesture', () => {
    expect(parseBindSpec('Double right-grille').gesture).toBe('double')
    expect(parseBindSpec('DOUBLE right-grille').gesture).toBe('double')
  })

  it('parses a single modifier', () => {
    expect(parseBindSpec('tap right-grille +shift')).toMatchObject({ modifiers: ['shift'] })
  })

  it('parses combined modifiers in one +token', () => {
    expect(parseBindSpec('tap right-grille +shift+command').modifiers.sort()).toEqual(['command', 'shift'])
  })

  it('parses comma-separated modifiers in one +token', () => {
    expect(parseBindSpec('tap right-grille +shift,command').modifiers.sort()).toEqual(['command', 'shift'])
  })

  it('parses multiple +tokens', () => {
    expect(parseBindSpec('tap right-grille +shift +command').modifiers.sort()).toEqual(['command', 'shift'])
  })

  it('parses an @app filter', () => {
    expect(parseBindSpec('double left-palm @com.microsoft.Excel').app).toBe('com.microsoft.Excel')
  })

  it('defaults app to "*" when no @ token is given', () => {
    expect(parseBindSpec('double left-palm').app).toBe('*')
  })

  it('accepts gesture, zone, modifiers and app together in any order', () => {
    expect(parseBindSpec('double right-grille +shift @com.microsoft.Excel')).toEqual({
      gesture: 'double',
      zone: 'right-grille',
      zones: null,
      modifiers: ['shift'],
      app: 'com.microsoft.Excel'
    })
    expect(parseBindSpec('double @com.microsoft.Excel right-grille +shift')).toEqual({
      gesture: 'double',
      zone: 'right-grille',
      zones: null,
      modifiers: ['shift'],
      app: 'com.microsoft.Excel'
    })
  })

  it('collapses whitespace and trims', () => {
    expect(parseBindSpec('  double    right-grille   +shift  ')).toMatchObject({
      gesture: 'double',
      zone: 'right-grille',
      modifiers: ['shift']
    })
  })

  it('deduplicates repeated modifiers', () => {
    expect(parseBindSpec('tap right-grille +shift +shift').modifiers).toEqual(['shift'])
  })

  describe('zoneless gestures', () => {
    it('accepts no zone for cover_hold', () => {
      expect(parseBindSpec('cover_hold')).toEqual({ gesture: 'cover_hold', zone: null, zones: null, modifiers: [], app: '*' })
    })

    it('accepts modifiers and app with no zone', () => {
      expect(parseBindSpec('lid_nudge +shift @com.apple.Music')).toEqual({
        gesture: 'lid_nudge',
        zone: null,
        zones: null,
        modifiers: ['shift'],
        app: 'com.apple.Music'
      })
    })

    it('rejects a zone token for a zoneless gesture', () => {
      expect(() => parseBindSpec('cover_hold left-palm')).toThrow(BindGrammarError)
      expect(() => parseBindSpec('cover_hold left-palm')).toThrow(/does not take a zone/)
    })

    for (const gesture of ['lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right']) {
      it(`treats "${gesture}" as zoneless`, () => {
        expect(parseBindSpec(gesture).zone).toBeNull()
      })
    }
  })

  describe('sequence (two zones)', () => {
    it('parses a comma-separated pair', () => {
      expect(parseBindSpec('sequence left-palm,right-palm')).toEqual({
        gesture: 'sequence',
        zone: null,
        zones: ['left-palm', 'right-palm'],
        modifiers: [],
        app: '*'
      })
    })

    it('trims whitespace around the comma', () => {
      expect(parseBindSpec('sequence left-palm , right-palm').zones).toEqual(['left-palm', 'right-palm'])
    })

    it('rejects a single zone', () => {
      expect(() => parseBindSpec('sequence left-palm')).toThrow(/exactly two zones/)
    })

    it('rejects three zones', () => {
      expect(() => parseBindSpec('sequence left-palm,right-palm,lid')).toThrow(/exactly two zones/)
    })
  })

  describe('errors', () => {
    it('rejects an empty spec', () => {
      expect(() => parseBindSpec('')).toThrow(/empty bind spec/)
      expect(() => parseBindSpec('   ')).toThrow(/empty bind spec/)
    })

    it('rejects an unknown gesture', () => {
      expect(() => parseBindSpec('quadruple right-grille')).toThrow(/unknown gesture/)
    })

    it('rejects a missing zone for a zoned gesture', () => {
      expect(() => parseBindSpec('double')).toThrow(/needs a zone/)
      expect(() => parseBindSpec('double +shift')).toThrow(/needs a zone/)
    })

    it('rejects a second zone-looking token', () => {
      expect(() => parseBindSpec('double left-palm right-palm')).toThrow(/unexpected token/)
    })

    it('rejects an unknown modifier', () => {
      expect(() => parseBindSpec('tap right-grille +banana')).toThrow(/unknown modifier/)
    })

    it('rejects a bare "+" with nothing after it', () => {
      expect(() => parseBindSpec('tap right-grille +')).toThrow(/does not name any modifier/)
    })

    it('rejects a bare "@" with nothing after it', () => {
      expect(() => parseBindSpec('tap right-grille @')).toThrow(/needs an app/)
    })

    it('rejects two @app tokens', () => {
      expect(() => parseBindSpec('tap right-grille @a.b @c.d')).toThrow(/only one @app filter/)
    })

    it('rejects a comma-separated zone for a single-zone gesture', () => {
      expect(() => parseBindSpec('tap left-palm,right-palm')).toThrow(/takes one zone/)
    })
  })
})
