import Anthropic from '@anthropic-ai/sdk'
import { sanitizeSentence } from './explain.js'
import { finalizeDraft } from './finalize.js'
import { buildUserMessage, callModel, outcomeFromModel, retryMessage } from './llm.js'
import { parseOffline } from './offline.js'
import { loadPresetLibrary } from './presets.js'
import type { ComposeContext, ComposeMode, ComposeResult, ComposeSource, DraftOutcome } from './types.js'

export const MAX_REQUEST_CHARS = 2000

export interface ComposeOptions {
  /**
   * "live" (default): use Claude; returns a missing_api_key error when ANTHROPIC_API_KEY is unset.
   * "offline": rule-based parser only, never touches the network.
   * "auto": live when a key is set, offline otherwise.
   */
  mode?: ComposeMode
  /** Inject a client (tests). Otherwise one is built from ANTHROPIC_API_KEY. */
  client?: Anthropic
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  signal?: AbortSignal
  /** Environment to read the key from (defaults to process.env). */
  env?: Record<string, string | undefined>
}

function withPresets(ctx: ComposeContext): ComposeContext {
  return ctx.presets ? ctx : { ...ctx, presets: loadPresetLibrary() }
}

function fromOutcome(outcome: DraftOutcome, ctx: ComposeContext, source: ComposeSource, attempts: number) {
  switch (outcome.type) {
    case 'clarify':
      return { done: true as const, result: { status: 'clarify' as const, source, question: sanitizeSentence(outcome.question).replace(/\.$/, '?').replace(/\?+$/, '?'), attempts } }
    case 'refuse':
      return {
        done: true as const,
        result: { status: 'rejected' as const, source, reason: outcome.code, explanation: sanitizeSentence(outcome.reason), violations: [], attempts }
      }
    case 'binding': {
      const f = finalizeDraft(outcome.draft, ctx, source)
      if (f.kind === 'retryable') return { done: false as const, errors: f.errors }
      return { done: true as const, result: { ...f.result, attempts } }
    }
  }
}

export function composeOffline(request: string, context: ComposeContext): ComposeResult {
  const bad = checkRequest(request)
  if (bad) return bad
  const ctx = withPresets(context)
  const r = fromOutcome(parseOffline(request, ctx), ctx, 'offline', 0)
  if (r.done) return r.result
  return { status: 'error', code: 'invalid_output', message: 'The offline parser produced a binding that failed validation.', details: r.errors, attempts: 0 }
}

function checkRequest(request: unknown): ComposeResult | null {
  if (typeof request !== 'string' || !request.trim())
    return { status: 'error', code: 'invalid_request', message: 'The request is empty.', attempts: 0 }
  if (request.length > MAX_REQUEST_CHARS)
    return { status: 'error', code: 'invalid_request', message: `The request is longer than ${MAX_REQUEST_CHARS} characters.`, attempts: 0 }
  return null
}

/**
 * Compose one binding from a plain-English request.
 * Returns a validated binding, one clarifying question, a rejection (unsafe or impossible), or an error.
 */
export async function compose(request: string, context: ComposeContext, options: ComposeOptions = {}): Promise<ComposeResult> {
  const bad = checkRequest(request)
  if (bad) return bad
  const env = options.env ?? process.env
  const key = env['ANTHROPIC_API_KEY']?.trim()
  const mode = options.mode ?? 'live'

  if (mode === 'offline' || (mode === 'auto' && !key && !options.client)) return composeOffline(request, context)
  if (!key && !options.client) {
    return {
      status: 'error',
      code: 'missing_api_key',
      message: 'ANTHROPIC_API_KEY is not set, so the AI composer cannot run. Set it in the environment, or call compose with { mode: "offline" } (or "auto") to use the built-in rule-based parser.',
      attempts: 0
    }
  }

  const ctx = withPresets(context)
  const client = options.client ?? new Anthropic({ apiKey: key })
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: buildUserMessage(request, ctx) }]
  let lastErrors: string[] = []

  for (let attempt = 1; attempt <= 2; attempt++) {
    let turn
    try {
      turn = await callModel(messages, { client, effort: options.effort, signal: options.signal })
    } catch (err) {
      return apiError(err, attempt)
    }
    if (turn.kind === 'refusal') {
      return { status: 'rejected', source: 'model', reason: 'unsafe', explanation: sanitizeSentence(turn.explanation), violations: [], attempts: attempt }
    }
    let errors: string[]
    if (turn.kind === 'unparseable') {
      errors = turn.errors
    } else {
      const outcome = outcomeFromModel(turn.output)
      if ('invalid' in outcome) errors = outcome.invalid
      else {
        const r = fromOutcome(outcome, ctx, 'model', attempt)
        if (r.done) return r.result
        errors = r.errors
      }
    }
    lastErrors = errors
    // Retry once, append-only: keep the model's own reply, then the validation errors.
    messages.push({ role: 'assistant', content: turn.content })
    messages.push({ role: 'user', content: retryMessage(errors) })
  }
  return {
    status: 'error',
    code: 'invalid_output',
    message: 'The model could not produce a valid binding after one retry.',
    details: lastErrors,
    attempts: 2
  }
}

function apiError(err: unknown, attempts: number): ComposeResult {
  if (err instanceof Anthropic.AuthenticationError)
    return { status: 'error', code: 'missing_api_key', message: 'ANTHROPIC_API_KEY was rejected by the API. Check the key, or use offline mode.', attempts }
  if (err instanceof Anthropic.RateLimitError)
    return { status: 'error', code: 'api_error', message: 'The API is rate limiting requests. Try again shortly, or use offline mode.', attempts }
  if (err instanceof Anthropic.APIError)
    return { status: 'error', code: 'api_error', message: `The API returned an error${err.status ? ` (${err.status})` : ''}: ${err.message}`, attempts }
  if (err instanceof Error && err.name === 'AbortError') return { status: 'error', code: 'api_error', message: 'The request was cancelled.', attempts }
  return { status: 'error', code: 'api_error', message: err instanceof Error ? err.message : String(err), attempts }
}
