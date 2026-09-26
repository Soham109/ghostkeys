import type { BindingTrigger, Conflict } from './conflicts.js'
import type { DestructiveReason, Violation } from './guardrails.js'
import type { Action, Binding, Gesture, Modifier, Zone } from './schema.js'

export interface Preset {
  id: string
  name: string
  category?: string
  keywords?: string[]
  /** Bundle id the preset is meant for, or "*". */
  app?: string
  action: Action
}

export interface DeviceCapabilities {
  model?: string
  family?: string
  /** From the daemon `hello` message. Missing sensors are treated as present. */
  sensors?: { imu?: boolean; gyro?: boolean; lid?: boolean; light?: boolean }
}

export interface FrontmostApp {
  bundleId: string
  name?: string
}

export interface ComposeContext {
  config: {
    zones: Zone[]
    /** Existing bindings. Read loosely: only trigger fields, id and label are needed. */
    bindings: BindingTrigger[]
  }
  frontmostApp?: FrontmostApp | string | null
  /** Preset library. When omitted, compose() loads ../../presets/library.json if it exists. */
  presets?: Preset[]
  device?: DeviceCapabilities
}

/** What the model or the offline parser proposes before code validates and hardens it. */
export interface BindingDraft {
  gesture: Gesture
  zone: string | null
  zones: string[] | null
  /** "anywhere": expand to one binding per configured zone. */
  allZones: boolean
  modifiers: Modifier[]
  /** "*" or a bundle id. */
  app: string
  action: Action
}

export type DraftOutcome =
  | { type: 'binding'; draft: BindingDraft; notes?: string[] }
  | { type: 'clarify'; question: string }
  | { type: 'refuse'; code: 'unsafe' | 'impossible'; reason: string }

export type ComposeSource = 'model' | 'offline'

export interface ComposeOk {
  status: 'ok'
  source: ComposeSource
  /** The primary binding (bindings[0]). */
  binding: Binding
  /** Usually one; "anywhere" requests produce one per configured zone. */
  bindings: Binding[]
  /** One plain-English sentence, no em or en dashes. */
  explanation: string
  destructive: boolean
  destructiveReasons: DestructiveReason[]
  /** The UI must ask the user to confirm before saving. */
  requiresConfirmation: boolean
  conflicts: Conflict[]
  warnings: string[]
  /** Changes code made to what was proposed (e.g. single tap upgraded to double). */
  adjustments: string[]
  /** Model calls used (0 offline, 1 or 2 live). */
  attempts: number
}

export interface ComposeClarify {
  status: 'clarify'
  source: ComposeSource
  /** Exactly one question. */
  question: string
  attempts: number
}

export interface ComposeRejected {
  status: 'rejected'
  source: ComposeSource
  reason: 'unsafe' | 'impossible'
  explanation: string
  violations: Violation[]
  attempts: number
}

export type ComposeErrorCode =
  | 'missing_api_key'
  | 'invalid_request'
  | 'invalid_output'
  | 'model_refusal'
  | 'api_error'

export interface ComposeError {
  status: 'error'
  code: ComposeErrorCode
  message: string
  details?: string[]
  attempts: number
}

export type ComposeResult = ComposeOk | ComposeClarify | ComposeRejected | ComposeError

export type ComposeMode = 'live' | 'offline' | 'auto'
