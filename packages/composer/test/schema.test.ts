import { describe, expect, it } from 'vitest'
import { OUTPUT_JSON_SCHEMA } from '../src/llm.js'
import { ActionSchema, BindingSchema, ConfigSchema, MACRO_MAX_STEPS, ZoneSchema } from '../src/schema.js'
import { ZONES } from './fixtures.js'

const base = { id: 'b1', enabled: true, gesture: 'double', zone: 'right-grille', zones: null, modifiers: [], app: '*', label: 'Volume up' }

describe('BindingSchema mirrors PROTOCOL.md', () => {
  it('accepts the protocol example binding', () => {
    expect(BindingSchema.safeParse({ ...base, action: { kind: 'volume', step: 6 } }).success).toBe(true)
  })

  it('accepts every action kind', () => {
    const actions = [
      { kind: 'keystroke', key: 'v', modifiers: ['command'] },
      { kind: 'volume', step: -6 },
      { kind: 'mute' },
      { kind: 'media', command: 'next' },
      { kind: 'brightness', step: 10 },
      { kind: 'open', target: 'Safari' },
      { kind: 'shell', command: 'echo hi' },
      { kind: 'applescript', source: 'beep' },
      { kind: 'shortcut', name: 'Morning' },
      { kind: 'text', text: 'hello' },
      { kind: 'clipboard', text: '' },
      { kind: 'window', op: 'next-display' },
      { kind: 'app', op: 'hide' },
      { kind: 'integration', app: 'excel', command: 'wrap-iferror', args: { fallback: '-' } },
      { kind: 'system', op: 'lock' },
      { kind: 'macro', steps: [{ kind: 'system', op: 'lock' }, { kind: 'media', command: 'playpause', delayMs: 200 }] }
    ]
    for (const action of actions) expect(ActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true)
  })

  it('rejects unknown kinds, unknown fields and bad enums', () => {
    expect(ActionSchema.safeParse({ kind: 'teleport' }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'mute', extra: 1 }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'window', op: 'close' }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'volume', step: 0 }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'volume', step: 500 }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'integration', app: 'excel', command: 'Wrap IFERROR' }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'system', op: 'reboot' }).success).toBe(false)
  })

  it('enforces macro limits and forbids nested macros and top-level delayMs', () => {
    const step = { kind: 'mute' }
    expect(ActionSchema.safeParse({ kind: 'macro', steps: [] }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'macro', steps: Array(MACRO_MAX_STEPS + 1).fill(step) }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'macro', steps: [{ ...step, delayMs: 20_000 }, { ...step, delayMs: 20_000 }] }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'macro', steps: [{ kind: 'macro', steps: [step] }] }).success).toBe(false)
    expect(ActionSchema.safeParse({ kind: 'mute', delayMs: 5 }).success).toBe(false)
  })

  it('enforces gesture and zone rules', () => {
    const a = { kind: 'mute' }
    expect(BindingSchema.safeParse({ ...base, action: a, zone: null }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'cover', zone: null }).success).toBe(true)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'cover' }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'sequence', zone: 'left-palm', zones: ['left-palm', 'right-palm'] }).success).toBe(true)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'sequence', zone: 'left-palm', zones: ['left-palm'] }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'sequence', zone: 'left-palm', zones: ['left-palm', 'left-palm'] }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, gesture: 'quadruple' }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, modifiers: ['shift', 'shift'] }).success).toBe(false)
    expect(BindingSchema.safeParse({ ...base, action: a, modifiers: ['hyper'] }).success).toBe(false)
  })

  it('accepts "*" or a bundle id for app', () => {
    const a = { kind: 'mute' }
    expect(BindingSchema.safeParse({ ...base, action: a, app: 'com.microsoft.Excel' }).success).toBe(true)
    expect(BindingSchema.safeParse({ ...base, action: a, app: 'Excel' }).success).toBe(false)
  })

  it('validates zones and whole configs', () => {
    for (const z of ZONES) expect(ZoneSchema.safeParse(z).success).toBe(true)
    expect(ZoneSchema.safeParse({ ...ZONES[0], surface: 'keyboard' }).success).toBe(false)
    expect(ConfigSchema.safeParse({ version: 1, zones: ZONES, bindings: [{ ...base, action: { kind: 'mute' } }] }).success).toBe(true)
  })
})

describe('OUTPUT_JSON_SCHEMA is strict-mode compatible', () => {
  function walk(node: unknown, path: string, out: string[]): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'object') {
      if (n['additionalProperties'] !== false) out.push(`${path}: additionalProperties must be false`)
      const props = Object.keys((n['properties'] as object) ?? {})
      const req = (n['required'] as string[]) ?? []
      if (props.sort().join() !== [...req].sort().join()) out.push(`${path}: every property must be required`)
    }
    for (const bad of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'format'])
      if (bad in n) out.push(`${path}: ${bad} is not allowed`)
    for (const [k, v] of Object.entries(n)) {
      if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${k}[${i}]`, out))
      else if (typeof v === 'object') walk(v, `${path}.${k}`, out)
    }
  }
  it('has closed objects with all properties required', () => {
    const problems: string[] = []
    walk(OUTPUT_JSON_SCHEMA, '$', problems)
    expect(problems).toEqual([])
  })
})
