import type { Action } from '@ghostkeys/sdk'
import { describe, expect, it } from 'vitest'
import { comboText, describeAction, isDestructive } from '../src/describe.js'

describe('comboText', () => {
  it('orders modifiers fn, control, option, shift, command', () => {
    expect(comboText('v', ['command', 'shift', 'control'])).toBe('ctrl+shift+cmd+v')
  })

  it('handles no modifiers', () => {
    expect(comboText('escape', [])).toBe('escape')
  })
})

describe('describeAction', () => {
  it('describes every action kind', () => {
    const cases: Array<[Action, RegExp]> = [
      [{ kind: 'keystroke', key: 'v', modifiers: ['command'] }, /press cmd\+v/],
      [{ kind: 'volume', step: 6 }, /volume up 6%/],
      [{ kind: 'volume', step: -6 }, /volume down 6%/],
      [{ kind: 'mute' }, /mute/],
      [{ kind: 'media', command: 'playpause' }, /playpause/],
      [{ kind: 'brightness', step: -1 }, /brightness -1/],
      [{ kind: 'open', target: 'Finder' }, /open Finder/],
      [{ kind: 'shell', command: 'echo hi\nrest' }, /echo hi/],
      [{ kind: 'applescript', source: 'beep' }, /applescript/],
      [{ kind: 'shortcut', name: 'My Shortcut' }, /My Shortcut/],
      [{ kind: 'text', text: 'hello' }, /hello/],
      [{ kind: 'clipboard', text: 'hello' }, /clipboard/],
      [{ kind: 'window', op: 'left' }, /left/],
      [{ kind: 'app', op: 'quit' }, /quit/],
      [{ kind: 'integration', app: 'excel', command: 'wrap-iferror' }, /excel.*wrap-iferror/],
      [{ kind: 'system', op: 'lock' }, /lock/],
      [{ kind: 'macro', steps: [{ kind: 'mute' }] }, /macro \(1 step\)/],
      [{ kind: 'macro', steps: [{ kind: 'mute' }, { kind: 'mute' }] }, /macro \(2 steps\)/]
    ]
    for (const [action, pattern] of cases) {
      expect(describeAction(action)).toMatch(pattern)
    }
  })

  it('truncates long text actions', () => {
    const long = 'a'.repeat(50)
    const result = describeAction({ kind: 'text', text: long })
    expect(result.length).toBeLessThan(long.length)
  })
})

describe('isDestructive', () => {
  it('flags app quit', () => {
    expect(isDestructive({ kind: 'app', op: 'quit' })).toBe(true)
  })

  it('does not flag other app ops', () => {
    expect(isDestructive({ kind: 'app', op: 'hide' })).toBe(false)
  })

  it('flags a macro containing app quit', () => {
    expect(isDestructive({ kind: 'macro', steps: [{ kind: 'mute' }, { kind: 'app', op: 'quit' }] })).toBe(true)
  })

  it('does not flag a harmless macro', () => {
    expect(isDestructive({ kind: 'macro', steps: [{ kind: 'mute' }] })).toBe(false)
  })

  it('does not flag unrelated actions', () => {
    expect(isDestructive({ kind: 'volume', step: 6 })).toBe(false)
  })
})
