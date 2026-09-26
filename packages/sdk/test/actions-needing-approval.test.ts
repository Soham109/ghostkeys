import { describe, expect, it } from 'vitest'
import { actionsNeedingApproval, APPROVAL_GATED_KINDS } from '../src/protocol/types.js'

describe('APPROVAL_GATED_KINDS', () => {
  it('matches the daemon\'s ApprovalStore.gatedKinds exactly', () => {
    expect([...APPROVAL_GATED_KINDS].sort()).toEqual(['applescript', 'open', 'shell', 'shortcut'])
  })
})

describe('actionsNeedingApproval', () => {
  it('returns the action itself for a gated top-level kind', () => {
    const action = { kind: 'shell' as const, command: 'echo hi' }
    expect(actionsNeedingApproval(action)).toEqual([action])
  })

  it('returns an empty array for a non-gated action', () => {
    expect(actionsNeedingApproval({ kind: 'volume', step: 6 })).toEqual([])
    expect(actionsNeedingApproval({ kind: 'mute' })).toEqual([])
  })

  it('returns only the gated steps of a macro', () => {
    const steps = [
      { kind: 'mute' as const },
      { kind: 'shell' as const, command: 'echo one' },
      { kind: 'volume' as const, step: 6 },
      { kind: 'open' as const, target: 'Finder' }
    ]
    const action = { kind: 'macro' as const, steps }
    expect(actionsNeedingApproval(action)).toEqual([steps[1], steps[3]])
  })

  it('returns an empty array for a macro with no gated steps', () => {
    const action = { kind: 'macro' as const, steps: [{ kind: 'mute' as const }, { kind: 'volume' as const, step: 6 }] }
    expect(actionsNeedingApproval(action)).toEqual([])
  })
})
