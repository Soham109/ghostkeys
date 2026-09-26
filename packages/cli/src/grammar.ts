/**
 * The `gk bind` spec grammar: `<gesture> [zone] [+modifier...] [@app]`, whitespace separated.
 *
 *   double right-grille +shift @com.microsoft.Excel
 *   cover_hold
 *   sequence left-palm,right-palm
 *   tap left-edge +command+option
 *
 * Rules:
 *   - gesture is required and must be one of protocol.GESTURES (case-insensitive on input).
 *   - a zone token is required for every gesture except the "zoneless" ones (lid_nudge, cover,
 *     cover_hold, tilt_left, tilt_right), and forbidden for those.
 *   - "sequence" is the one gesture that takes two zones: write them as a single comma-separated
 *     token, `zoneA,zoneB`, in order.
 *   - a token starting with "+" lists modifiers, either as one token per modifier (+shift +command)
 *     or combined (+shift+command, or +shift,command).
 *   - a token starting with "@" restricts the binding to one app (a bundle id), or "@*" for every
 *     app (the default when no @ token is given at all).
 *   - tokens may appear in any order after the gesture (and zone, if present).
 */
import { GESTURES, MODIFIERS, MULTI_ZONE_GESTURES, ZONELESS_GESTURES, type GestureKind, type Modifier } from '@ghostkeys/sdk'

export class BindGrammarError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BindGrammarError'
  }
}

export interface ParsedBindSpec {
  gesture: GestureKind
  zone: string | null
  zones: string[] | null
  modifiers: Modifier[]
  app: string
}

const MODIFIER_SET = new Set<string>(MODIFIERS)
const GESTURE_SET = new Set<string>(GESTURES)

export function parseBindSpec(spec: string): ParsedBindSpec {
  const tokens = spec.trim().split(/\s+/).filter(Boolean)
  const gestureToken = tokens[0]
  if (!gestureToken) {
    throw new BindGrammarError('empty bind spec: expected at least a gesture, e.g. "double right-grille"')
  }
  const gestureLower = gestureToken.toLowerCase()
  if (!GESTURE_SET.has(gestureLower)) {
    throw new BindGrammarError(`unknown gesture "${gestureToken}". Known gestures: ${GESTURES.join(', ')}`)
  }
  const gesture = gestureLower as GestureKind
  const zoneless = (ZONELESS_GESTURES as readonly string[]).includes(gesture)
  const multiZone = (MULTI_ZONE_GESTURES as readonly string[]).includes(gesture)

  // Plain (non +/@) tokens make up the zone(s). Collected rather than fixed at one token so a
  // "sequence" pair can be written with or without spaces around its comma: "a,b", "a, b" and
  // "a , b" all tokenize differently but should mean the same thing.
  const plainTokens: string[] = []
  const modifiers = new Set<Modifier>()
  let app: string | undefined

  for (const token of tokens.slice(1)) {
    if (token.startsWith('+')) {
      const parts = token.slice(1).split(/[+,]/).filter(Boolean)
      if (parts.length === 0) throw new BindGrammarError(`"${token}" does not name any modifier`)
      for (const part of parts) {
        const mod = part.toLowerCase()
        if (!MODIFIER_SET.has(mod)) {
          throw new BindGrammarError(`unknown modifier "${part}". Known modifiers: ${MODIFIERS.join(', ')}`)
        }
        modifiers.add(mod as Modifier)
      }
    } else if (token.startsWith('@')) {
      if (app !== undefined) throw new BindGrammarError(`only one @app filter is allowed, already have "@${app}"`)
      app = token.slice(1)
      if (app.length === 0) throw new BindGrammarError('"@" needs an app after it, e.g. @com.microsoft.Excel, or @* for every app')
    } else {
      if (zoneless) {
        throw new BindGrammarError(`"${gesture}" does not take a zone, but got "${token}"`)
      }
      plainTokens.push(token)
    }
  }

  let zone: string | null = null
  let zones: string[] | null = null
  if (!zoneless) {
    if (multiZone) {
      const parts = plainTokens
        .join('')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length !== 2) {
        throw new BindGrammarError(`"${gesture}" needs exactly two zones separated by a comma, like left-palm,right-palm`)
      }
      zones = parts
    } else {
      if (plainTokens.length === 0) {
        throw new BindGrammarError(`"${gesture}" needs a zone, e.g. "${gesture} right-grille"`)
      }
      if (plainTokens.length > 1 || plainTokens[0]!.includes(',')) {
        const extra = plainTokens.length > 1 ? plainTokens[1]! : plainTokens[0]!
        throw new BindGrammarError(`"${gesture}" takes one zone, not a list: unexpected token "${extra}"`)
      }
      zone = plainTokens[0]!
    }
  }

  return {
    gesture,
    zone,
    zones,
    modifiers: [...modifiers],
    app: app ?? '*'
  }
}
