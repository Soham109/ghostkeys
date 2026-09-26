/**
 * Offline mode: a small rule-based parser for common phrasings, so the composer works
 * without an API key. It covers volume, media, brightness, window snapping, lock and other
 * system commands, opening apps and URLs, app hide/quit, Excel integrations, typed text,
 * quoted shell commands, keystrokes and presets by keyword. Anything else gets one question.
 */
import { KNOWN_APPS, findAppByBundle, findAppByName } from './apps.js'
import type { Gesture, LeafAction, MacroStep, Modifier, Zone } from './schema.js'
import { MACRO_MAX_STEPS } from './schema.js'
import type { ComposeContext, DraftOutcome, Preset } from './types.js'

interface Found<T> {
  index: number
  value: T
}

// ---------- zones ----------

const ZONE_SYNONYMS: Record<string, string[]> = {
  'right-grille': ['right speaker grille', 'right speaker', 'right grille', 'right grill'],
  'left-grille': ['left speaker grille', 'left speaker', 'left grille', 'left grill'],
  'right-palm': ['right palm rest', 'right palmrest', 'right palm', 'right of the trackpad', 'right of trackpad'],
  'left-palm': ['left palm rest', 'left palmrest', 'left palm', 'left of the trackpad', 'left of trackpad'],
  'top-strip': ['top strip', 'strip above the keyboard', 'above the keyboard', 'above the keys', 'hinge strip'],
  'left-edge': ['left edge', 'left side of the laptop', 'left side'],
  'right-edge': ['right edge', 'right side of the laptop', 'right side'],
  lid: ['back of the lid', 'back of the screen', 'lid']
}

const IMPOSSIBLE_SURFACES: [RegExp, string][] = [
  [/\b(the )?(track ?pad)\b/, 'the trackpad'],
  [/\b(the )?(keyboard|keys|key)\b/, 'the keyboard'],
  [/\b(touch ?bar)\b/, 'the Touch Bar'],
  [/\b(touch ?id|fingerprint|power button)\b/, 'the Touch ID button'],
  [/\b(the )?(display|screen glass|notch|webcam)\b/, 'the display'],
  [/\bport(s)?\b|\busb\b|\bcharger\b|\bmagsafe\b/, 'the ports']
]

function findZones(text: string, zones: readonly Zone[]): { found: Found<string>[]; rest: string } {
  const found: Found<string>[] = []
  let rest = text
  const candidates: [string, string][] = []
  for (const [id, syns] of Object.entries(ZONE_SYNONYMS)) for (const s of syns) candidates.push([s, id])
  for (const z of zones) {
    candidates.push([z.name.toLowerCase(), z.id])
    candidates.push([z.id.replace(/-/g, ' '), z.id])
    candidates.push([z.id, z.id])
  }
  candidates.sort((a, b) => b[0].length - a[0].length)
  for (const [phrase, id] of candidates) {
    const re = new RegExp(`\\b${escapeRe(phrase)}\\b`, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(rest))) {
      found.push({ index: m.index, value: id })
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length)
    }
  }
  found.sort((a, b) => a.index - b.index)
  return { found, rest }
}

// ---------- gestures ----------

const UNSUPPORTED_GESTURES: [RegExp, string][] = [
  [/\b(quadruple|quad|four|4|five|5|ten|10)[- ]?(times|taps?|knocks?)\b|\btap(s)? (four|five|4|5) times\b/, 'Ghostkeys detects at most a triple tap'],
  [/\bswipe|\bslide\b|\bpinch|\bscroll\b|\bdrag\b/, 'Ghostkeys detects taps and knocks, not swipes or drags'],
  [/\blong[- ]?press\b|\bpress and hold\b|\btap and hold\b|\bhold (my )?finger\b/, 'Ghostkeys cannot detect a long press on a surface'],
  [/\bshake\b|\bflip\b|\bspin\b/, 'Ghostkeys detects tilts, not shakes or flips'],
  [/\bclap|\bsnap (my )?fingers|\bwhistle|\bvoice\b|\bsay\b|\bblink/, 'Ghostkeys only senses touches, the lid, tilt and light, not sound or eyes']
]

function findGesture(t: string): { gesture?: Gesture; unsupported?: string; sequenceHint: boolean } {
  for (const [re, why] of UNSUPPORTED_GESTURES) if (re.test(t)) return { unsupported: why, sequenceHint: false }
  const sequenceHint = /\bthen\b|\bfollowed by\b|\bafter\b/.test(t)
  if (/\brhythm\b|\btap,? pause,? double\b/.test(t)) return { gesture: 'rhythm', sequenceHint }
  if (/\bcover(ing)?\b.*\b(hold|keep|long|seconds?)\b|\bkeep (it |the sensor )?covered\b|\bcover[ _]hold\b|\bhold (my )?hand over\b/.test(t))
    return { gesture: 'cover_hold', sequenceHint }
  if (/\bcover(ing)?\b|\bwave (my hand )?over\b|\bblock the (light|camera|sensor)\b/.test(t)) return { gesture: 'cover', sequenceHint }
  if (/\blid[ _]nudge\b|\bnudge the lid\b|\bnudge (the )?screen\b|\bwiggle the lid\b|\bpush the lid back\b|\btilt the lid\b/.test(t))
    return { gesture: 'lid_nudge', sequenceHint }
  if (/\b(tilt|roll|lean)(ing)? (the laptop |it |the mac )?left\b|\btilt[ _]left\b/.test(t)) return { gesture: 'tilt_left', sequenceHint }
  if (/\b(tilt|roll|lean)(ing)? (the laptop |it |the mac )?right\b|\btilt[ _]right\b/.test(t)) return { gesture: 'tilt_right', sequenceHint }
  if (/\btriple\b|\bthree (taps|knocks|times)\b|\b3 (taps|knocks|times)\b|\b(tap|knock)(s|ed)? (three|3) times\b|\bthrice\b/.test(t))
    return { gesture: 'triple', sequenceHint }
  if (/\bdouble\b|\btwo (taps|knocks)\b|\b2 (taps|knocks)\b|\b(tap|knock)(s|ed)? twice\b|\btwice\b/.test(t)) return { gesture: 'double', sequenceHint }
  if (/\b(single )?(tap|knock|touch|thump|hit|pat)(s|ped|ping|ed)?\b/.test(t)) return { gesture: 'tap', sequenceHint }
  return { sequenceHint }
}

// ---------- modifiers ----------

const MOD_WORDS: [RegExp, Modifier][] = [
  [/\b(shift)\b/, 'shift'],
  [/\b(control|ctrl|ctl)\b/, 'control'],
  [/\b(option|alt|opt)\b/, 'option'],
  [/\b(command|cmd)\b|⌘/, 'command'],
  [/\bfn\b|\bfunction key\b/, 'fn']
]

function modsIn(s: string): Modifier[] {
  const out: Modifier[] = []
  for (const [re, m] of MOD_WORDS) if (re.test(s)) out.push(m)
  return out
}

/** Gesture modifiers: "while holding shift", "with command held", "shift double tap". */
function findGestureModifiers(t: string): Modifier[] {
  const out = new Set<Modifier>()
  const hold = t.match(/\b(?:while |when )?(?:holding|hold|pressing)(?: down)? ((?:(?:shift|control|ctrl|option|alt|opt|command|cmd|fn|and|\+|,)\s*)+)/)
  if (hold?.[1]) for (const m of modsIn(hold[1])) out.add(m)
  const held = t.match(/\bwith ((?:(?:shift|control|ctrl|option|alt|opt|command|cmd|fn|and|\+)\s*)+)(held|down|pressed)\b/)
  if (held?.[1]) for (const m of modsIn(held[1])) out.add(m)
  const prefix = t.match(/\b((?:(?:shift|control|ctrl|option|alt|opt|command|cmd|fn)[ +-])+)(?:double |triple |single )?(?:tap|knock|click)/)
  if (prefix?.[1]) for (const m of modsIn(prefix[1])) out.add(m)
  return [...out]
}

// ---------- app layer ----------

function frontmostBundle(ctx: ComposeContext): string | undefined {
  const f = ctx.frontmostApp
  if (!f) return undefined
  return typeof f === 'string' ? f : f.bundleId
}

function findAppLayer(t: string, ctx: ComposeContext): { app?: string; needsFrontmost?: boolean } {
  if (/\b(in|for|inside) (this|the current|the frontmost|my current) app\b|\bin here\b|\bonly here\b/.test(t)) {
    const b = frontmostBundle(ctx)
    return b ? { app: b } : { needsFrontmost: true }
  }
  if (/\b(anywhere|everywhere|in (any|every|all) apps?|globally|system[- ]wide)\b/.test(t)) return { app: '*' }
  const aliases = KNOWN_APPS.flatMap((a) => a.aliases.map((alias) => [alias, a.bundleId] as const)).sort((a, b) => b[0].length - a[0].length)
  for (const [alias, bundle] of aliases) {
    const re = new RegExp(`\\b(?:in|inside|within|while (?:in|using)|when (?:in|using)|for|on) (?:the )?${escapeRe(alias)}\\b|\\bwhen ${escapeRe(alias)} is (?:open|frontmost|focused|active)\\b`)
    if (re.test(t)) return { app: bundle }
  }
  return {}
}

// ---------- actions ----------

type Matcher = (t: string, raw: string, ctx: ComposeContext) => Found<LeafAction>[] | { clarify: string } | { refuse: string; code: 'unsafe' | 'impossible' }

function all(re: RegExp, t: string): RegExpExecArray[] {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  return [...t.matchAll(g)]
}

function num(s: string | undefined, dflt: number): number {
  const n = s ? parseInt(s, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : dflt
}

const KEY_NAMES: Record<string, string> = {
  esc: 'escape',
  escape: 'escape',
  return: 'return',
  enter: 'return',
  tab: 'tab',
  space: 'space',
  spacebar: 'space',
  delete: 'delete',
  backspace: 'delete',
  left: 'left',
  right: 'right',
  up: 'up',
  down: 'down',
  home: 'home',
  end: 'end'
}

function parseCombo(combo: string): { key: string; modifiers: Modifier[] } | null {
  const parts = combo
    .toLowerCase()
    .replace(/⌘/g, 'command ')
    .replace(/⇧/g, 'shift ')
    .replace(/⌥/g, 'option ')
    .replace(/⌃/g, 'control ')
    .split(/[\s+-]+/)
    .filter(Boolean)
  const modifiers: Modifier[] = []
  let key: string | null = null
  for (const p of parts) {
    const m = modsIn(p)
    if (m.length && m[0]) {
      if (!modifiers.includes(m[0])) modifiers.push(m[0])
    } else if (/^f([1-9]|1[0-9]|20)$/.test(p) || p.length === 1 || KEY_NAMES[p]) {
      key = KEY_NAMES[p] ?? p
    } else return null
  }
  return key ? { key, modifiers } : null
}

const ACTION_MATCHERS: Matcher[] = [
  // Quoted or explicit shell commands. Checked first so their contents are not parsed as other actions.
  (_t, raw) => {
    const m = raw.match(/\b(?:run|execute|exec)\s+(?:the\s+)?(?:shell\s+|terminal\s+)?(?:command|script|cmd)?\s*[:=]?\s*(`[^`]+`|"[^"]+"|'[^']+'|[^,]+?)\s*$/i)
    if (!m?.[1] || /^(?:the\s+)?(?:my\s+)?shortcut\b/i.test(m[1])) return []
    const cmd = m[1].replace(/^[`"']|[`"']$/g, '').trim()
    if (!cmd) return []
    return [{ index: m.index ?? 0, value: { kind: 'shell', command: cmd } }]
  },
  (_t, raw) =>
    all(/\b(?:run|trigger|start)\s+(?:the\s+|my\s+)?shortcut\s+(?:called\s+|named\s+)?["“]?([^"”,]+?)["”]?(?=\s*(?:,|\band\b|$))/i, raw).map((m) => ({
      index: m.index ?? 0,
      value: { kind: 'shortcut', name: m[1]!.trim() }
    })),
  (_t, raw) =>
    all(/\btype\s+(?:out\s+)?["“]([^"”]+)["”]/i, raw).map((m) => ({ index: m.index ?? 0, value: { kind: 'text', text: m[1]! } })),
  (_t, raw) =>
    all(/\bcopy\s+["“]([^"”]+)["”]\s+(?:to|into|onto)\s+(?:the\s+)?clipboard/i, raw).map((m) => ({ index: m.index ?? 0, value: { kind: 'clipboard', text: m[1]! } })),
  // Keystrokes: "press cmd+shift+t", "send ⌘W".
  (t) => {
    const out: Found<LeafAction>[] = []
    for (const m of all(/(?:\b(?:press|send|hit|keystroke|shortcut key)\s+|(?:->|=|:)\s*)((?:(?:cmd|command|⌘|shift|⇧|option|opt|alt|⌥|control|ctrl|⌃|fn)\s*[+-]?\s*)+[a-z0-9]{1,9})\b/, t)) {
      const c = parseCombo(m[1]!)
      if (c) out.push({ index: m.index ?? 0, value: { kind: 'keystroke', key: c.key, modifiers: c.modifiers } })
    }
    return out
  },
  // Excel integrations.
  (t, raw) => {
    const out: Found<LeafAction>[] = []
    const ife = t.match(/\biferror\b/)
    if (ife) {
      let fallback: string | undefined
      const q = raw.match(/iferror[^"“']*(?:with|showing|returning|to)\s+(?:an?\s+)?["“']([^"”']*)["”']/i)
      if (q) fallback = q[1]
      else if (/\b(with|to|showing|returning) (a |an )?(dash|hyphen|minus)\b/.test(t)) fallback = '-'
      else if (/\b(with|to|showing|returning) (a )?(blank|empty|nothing)\b/.test(t)) fallback = ''
      else if (/\b(with|to|showing|returning) (a )?(zero|0)\b/.test(t)) fallback = '0'
      else if (/\bn\/a\b|\bna\b/.test(t)) fallback = 'N/A'
      out.push({
        index: ife.index ?? 0,
        value: { kind: 'integration', app: 'excel', command: 'wrap-iferror', ...(fallback !== undefined ? { args: { fallback } } : {}) }
      })
    }
    const abs = t.match(/\b(absolute reference|toggle absolute|anchor (the )?(cell|reference)|dollar signs?)\b/)
    if (abs) out.push({ index: abs.index ?? 0, value: { kind: 'integration', app: 'excel', command: 'toggle-absolute' } })
    const nf = t.match(/\bcycle (the )?number formats?\b/)
    if (nf) out.push({ index: nf.index ?? 0, value: { kind: 'integration', app: 'excel', command: 'cycle-number-format' } })
    const xl = t.match(/\bxlookup\b/)
    if (xl) out.push({ index: xl.index ?? 0, value: { kind: 'integration', app: 'excel', command: 'insert-xlookup' } })
    return out
  },
  // Volume.
  (t) => {
    const out: Found<LeafAction>[] = []
    for (const m of all(/\b(?:turn |raise |lower |increase |decrease |bump |crank )?(?:the )?(?:volume|sound)\s*(up|down|\+|-)(?:\s*by\s*(\d+)\s*(?:%|percent)?)?/, t)) {
      const up = m[1] === 'up' || m[1] === '+'
      out.push({ index: m.index ?? 0, value: { kind: 'volume', step: (up ? 1 : -1) * num(m[2], 6) } })
    }
    for (const m of all(/\b(?:raise|increase|bump up|bump|turn up) (?:up )?(?:the )?(?:volume|sound)(?:\s*by\s*(\d+)\s*(?:%|percent)?)?/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'volume', step: num(m[1], 6) } })
    for (const m of all(/\b(?:lower|decrease|reduce|turn down) (?:the )?(?:volume|sound)(?:\s*by\s*(\d+)\s*(?:%|percent)?)?/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'volume', step: -num(m[1], 6) } })
    for (const m of all(/\b(louder)\b/, t)) out.push({ index: m.index ?? 0, value: { kind: 'volume', step: 6 } })
    for (const m of all(/\b(quieter|softer)\b/, t)) out.push({ index: m.index ?? 0, value: { kind: 'volume', step: -6 } })
    if (!out.length && /\b(volume|sound level)\b/.test(t) && !/\bmute\b/.test(t)) return { clarify: 'Should it turn the volume up or down?' }
    return dedupeByIndex(out)
  },
  // Mute (output). Microphone mute needs an app preset.
  (t) => {
    const m = t.match(/\b(un)?mute\b(?! (my |the )?(mic|microphone))/)
    if (!m) return []
    if (/\bmute (my |the )?(mic|microphone)\b/.test(t)) return []
    return [{ index: m.index ?? 0, value: { kind: 'mute' } }]
  },
  // Media.
  (t) => {
    const out: Found<LeafAction>[] = []
    for (const m of all(/\b(play\s*\/\s*pause|play or pause|play-pause|playpause|(?:pause|resume|play|stop)(?: the| my)? (?:music|song|track|media|audio|spotify|podcast|video)|toggle (?:the )?(?:music|playback))\b/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'media', command: 'playpause' } })
    for (const m of all(/\b(next (?:track|song)|skip(?: the| this)? (?:track|song)|skip ahead)\b/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'media', command: 'next' } })
    for (const m of all(/\b(previous (?:track|song)|last (?:track|song)|go back a (?:track|song)|prev track)\b/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'media', command: 'previous' } })
    if (!out.length) {
      const bare = t.match(/(?:=|,|\bto\b|:|->)\s*(pause|play)\s*$/)
      if (bare) out.push({ index: bare.index ?? 0, value: { kind: 'media', command: 'playpause' } })
    }
    return out
  },
  // Brightness.
  (t) => {
    const out: Found<LeafAction>[] = []
    for (const m of all(/\b(?:(?:turn |raise |increase )?(?:the )?(?:screen )?brightness\s*(up|down)|(brighter)|(dimmer|dim the screen))\b/, t)) {
      const up = m[1] === 'up' || !!m[2]
      out.push({ index: m.index ?? 0, value: { kind: 'brightness', step: up ? 10 : -10 } })
    }
    for (const m of all(/\b(raise|increase|bump up|turn up|lower|decrease|reduce|turn down) (?:the )?(?:screen )?brightness\b/, t))
      out.push({ index: m.index ?? 0, value: { kind: 'brightness', step: /raise|increase|up/.test(m[1]!) ? 10 : -10 } })
    if (!out.length && /\bbrightness\b/.test(t)) return { clarify: 'Should it turn the brightness up or down?' }
    return out
  },
  // Window management.
  (t) => {
    const out: Found<LeafAction>[] = []
    const re = /\b(?:snap|move|tile|put|send|throw)\s+(?:the\s+|this\s+|my\s+)?(?:window\s+|app\s+)?(?:to\s+)?(?:the\s+)?(left|right|top|bottom)(?:\s+half|\s+side)?\b/
    for (const m of all(re, t)) out.push({ index: m.index ?? 0, value: { kind: 'window', op: m[1] as 'left' } })
    for (const m of all(/\b(?:(?:left|right|top|bottom) half)\b/, t)) {
      if (!out.some((o) => Math.abs(o.index - (m.index ?? 0)) < 30))
        out.push({ index: m.index ?? 0, value: { kind: 'window', op: m[0].split(' ')[0] as 'left' } })
    }
    const ops: [RegExp, 'maximize' | 'center' | 'next-display' | 'minimize' | 'fullscreen'][] = [
      [/\bmaximi[sz]e\b/, 'maximize'],
      [/\bcent(er|re) (the |this )?window\b/, 'center'],
      [/\b(next|other|second|external) (display|monitor|screen)\b/, 'next-display'],
      [/\bminimi[sz]e\b/, 'minimize'],
      [/\bfull ?screen\b/, 'fullscreen']
    ]
    for (const [r, op] of ops) {
      const m = t.match(r)
      if (m) out.push({ index: m.index ?? 0, value: { kind: 'window', op } })
    }
    if (!out.length && /\b(snap|tile) (the |this )?window\b/.test(t)) return { clarify: 'Which way should the window snap: left half, right half, or maximized?' }
    return out
  },
  // System.
  (t) => {
    const out: Found<LeafAction>[] = []
    const ops: [RegExp, 'lock' | 'sleep-display' | 'screenshot' | 'screenshot-area' | 'dnd-toggle' | 'mission-control' | 'launchpad' | 'show-desktop'][] = [
      [/\block (the |my )?(screen|mac|computer|laptop|macbook)\b|\block it\b|\bscreen lock\b|(?:\bto|=|:|->|\band)\s*lock\s*(?:$|,|\band\b|\bthen\b)/, 'lock'],
      [/\b(sleep|turn off|switch off) (the )?(display|screen|monitor)\b|\bdisplay (to )?sleep\b/, 'sleep-display'],
      [/\bscreenshot (of )?(an |a |the )?(area|region|selection|portion|part)\b|\b(area|region|partial) screenshot\b/, 'screenshot-area'],
      [/\b(take (a )?)?screen ?shot\b|\bscreen capture\b/, 'screenshot'],
      [/\bdo not disturb\b|\bdnd\b|\bfocus mode\b/, 'dnd-toggle'],
      [/\bmission control\b/, 'mission-control'],
      [/\blaunchpad\b/, 'launchpad'],
      [/\bshow (the )?desktop\b/, 'show-desktop']
    ]
    for (const [r, op] of ops) {
      const m = t.match(r)
      if (m && !(op === 'screenshot' && out.some((o) => o.value.kind === 'system' && o.value.op === 'screenshot-area')))
        out.push({ index: m.index ?? 0, value: { kind: 'system', op } })
    }
    return out
  },
  // Frontmost app operations and destructive keystrokes.
  (t) => {
    const out: Found<LeafAction>[] = []
    const q = t.match(/\bforce[- ]?quit\b/)
    if (q) out.push({ index: q.index ?? 0, value: { kind: 'keystroke', key: 'escape', modifiers: ['command', 'option'] } })
    const quit = t.match(/\b(?<!force[- ])(quit|close|kill|exit) (the |this |current |frontmost |active )*(app|application|program)\b/)
    if (quit && !q) out.push({ index: quit.index ?? 0, value: { kind: 'app', op: 'quit' } })
    const hide = t.match(/\bhide (the |this |current |frontmost |active )*(app|application|window)\b/)
    if (hide) out.push({ index: hide.index ?? 0, value: { kind: 'app', op: 'hide' } })
    const next = t.match(/\bswitch to (the )?next app\b|\bnext app\b|\bcycle (through )?apps\b/)
    if (next) out.push({ index: next.index ?? 0, value: { kind: 'app', op: 'switch-next' } })
    const prev = t.match(/\b(switch to )?(the )?previous app\b|\blast app\b/)
    if (prev) out.push({ index: prev.index ?? 0, value: { kind: 'app', op: 'switch-previous' } })
    const close = t.match(/\bclose (the |this |current )?(window|tab)\b/)
    if (close) out.push({ index: close.index ?? 0, value: { kind: 'keystroke', key: 'w', modifiers: ['command'] } })
    const trash = t.match(/\bempty (the )?trash\b/)
    if (trash) out.push({ index: trash.index ?? 0, value: { kind: 'applescript', source: 'tell application "Finder" to empty trash' } })
    return out
  },
  // Open app, URL or path.
  (t, raw) => {
    const out: Found<LeafAction>[] = []
    for (const m of all(/\b(?:go to|visit|browse to)\s+(https?:\/\/\S+|[a-z0-9.-]+\.(?:com|org|net|io|dev|app|ai|co)(?:\/\S*)?)/i, raw)) {
      const target = /^https?:/i.test(m[1]!) ? m[1]! : `https://${m[1]!}`
      out.push({ index: m.index ?? 0, value: { kind: 'open', target: target.replace(/[.,]$/, '') } })
    }
    for (const m of all(/\b(?:open|launch|start up|start)\s+(?:up\s+)?(?:the\s+)?(?:app\s+)?(https?:\/\/\S+|[a-z0-9.-]+\.(?:com|org|net|io|dev|app|ai|co)(?:\/\S*)?|~?\/[^\s,]+|[a-z][a-z0-9 .]*?)(?:\s+app)?(?=\s*(?:,|\band\b|\bthen\b|\bin\b|\bwhen\b|$))/i, raw)) {
      let target = m[1]!.trim().replace(/[.,]$/, '')
      const lower = target.toLowerCase()
      if (!target || /^(it|this|that|the|a|an|my|window|tab|preset|launchpad|mission control|the desktop|desktop|do not disturb)$/.test(lower)) continue
      const app = findAppByName(lower)
      if (app) target = app.name
      else if (/^[a-z0-9.-]+\.(com|org|net|io|dev|app|ai|co)(\/|$)/i.test(target)) target = `https://${target}`
      else if (!/^(https?:\/\/|~?\/)/i.test(target)) target = target.replace(/\b\w/g, (c) => c.toUpperCase())
      out.push({ index: m.index ?? 0, value: { kind: 'open', target } })
    }
    return t.length ? out : []
  }
]

function dedupeByIndex<T>(list: Found<T>[]): Found<T>[] {
  const seen = new Set<number>()
  return list.filter((f) => (seen.has(f.index) ? false : (seen.add(f.index), true)))
}

function matchPresets(t: string, presets: readonly Preset[]): { preset?: Preset; ambiguous?: Preset[] } {
  if (!presets.length) return {}
  const byName = presets.filter((p) => new RegExp(`\\b${escapeRe(p.name.toLowerCase())}\\b`).test(t) || new RegExp(`\\b${escapeRe(p.id.toLowerCase())}\\b`).test(t))
  if (byName.length === 1) return { preset: byName[0] }
  if (byName.length > 1) return { preset: byName.sort((a, b) => b.name.length - a.name.length)[0] }
  const words = new Set(t.split(/[^a-z0-9]+/).filter((w) => w.length > 2))
  let best: Preset[] = []
  let bestScore = 0
  for (const p of presets) {
    const kws = [...(p.keywords ?? []), ...p.name.toLowerCase().split(/\s+/)].map((k) => k.toLowerCase()).filter((k) => k.length > 2)
    const score = new Set(kws.filter((k) => words.has(k))).size
    if (score > bestScore) {
      bestScore = score
      best = [p]
    } else if (score === bestScore && score > 0) best.push(p)
  }
  if (bestScore >= 2 && best.length === 1) return { preset: best[0] }
  if (bestScore >= 1 && best.length > 1 && best.length <= 4) return { ambiguous: best }
  if (bestScore >= 1 && best.length === 1 && /\bpreset\b/.test(t)) return { preset: best[0] }
  return {}
}

const OUT_OF_SCOPE: [RegExp, string, 'unsafe' | 'impossible'][] = [
  [/\b(system settings|system preferences|wi-?fi|bluetooth|firewall|filevault|gatekeeper|sip\b|login items?|launch (agent|daemon)s?|kernel extension|kext)\b/, 'Ghostkeys never changes System Settings, login items, launch daemons or kernel extensions.', 'unsafe'],
  [/\b(install|uninstall)\b.*\b(app|package|software|brew|homebrew|pkg)\b|\bbrew install\b/, 'Ghostkeys does not install or remove software.', 'unsafe'],
  [/\b(as root|admin(istrator)? (rights|privileges|password)|root access)\b/, 'Ghostkeys never runs anything with admin rights.', 'unsafe'],
  [/\b(ignore|disregard|forget|override|bypass)\b.*\b(rules|instructions|guardrails|safety|restrictions|system prompt)\b/, 'Requests to ignore the safety rules are refused.', 'unsafe'],
  [/\b(coffee|pizza|tea|lights|lamps?|bulbs?|thermostat|door|garage|car|dishwasher|robot)\b/, 'Ghostkeys can only act on this Mac, not on things in the physical world.', 'impossible'],
  [/\b(email|text|message|tweet|post|dm) (to )?(my |the )?(boss|mom|dad|friend|team|everyone|someone|followers)\b|\bsend (an? )?(email|text|message|tweet)\b/, 'Ghostkeys does not send messages or post anything over the network.', 'impossible'],
  [/\b(read|keylog|record) (my |the )?(keystrokes|passwords?|screen)\b|\bsteal\b|\bspy\b/, 'Ghostkeys does not record input or read secrets.', 'unsafe']
]

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Normalize input for matching: lowercase, straight quotes, collapse spaces. Keeps the raw text for quoted parts. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

export function parseOffline(request: string, ctx: ComposeContext): DraftOutcome {
  const raw = request.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
  const t = normalize(request)
  if (!t) return { type: 'clarify', question: 'What would you like a gesture to do?' }

  // Explicit shell text is guarded by code later; everything outside quotes is checked for scope.
  const unquoted = t.replace(/`[^`]*`|"[^"]*"/g, ' ')
  for (const [re, why, code] of OUT_OF_SCOPE) {
    if (re.test(unquoted)) {
      // A prompt-injection preamble followed by a harmless, parseable request still gets refused: refuse loudly.
      return { type: 'refuse', code, reason: why }
    }
  }

  // Trigger parts.
  const { found: zoneHits, rest } = findZones(t, ctx.config.zones)
  const g = findGesture(t)
  if (g.unsupported) return { type: 'refuse', code: 'impossible', reason: `${g.unsupported}.` }

  // Actions.
  const leaves: Found<LeafAction>[] = []
  const actionText = rest
  // Once a shell command is found, the rest of the text is the command itself: later matchers
  // only see the text before it (so "open terminal and run `ls`" keeps both steps).
  let cutoff = actionText.length
  for (const matcher of ACTION_MATCHERS) {
    const r = matcher(actionText.slice(0, cutoff), raw.slice(0, cutoff), ctx)
    if (Array.isArray(r)) {
      leaves.push(...r)
      const sh = r.find((x) => x.value.kind === 'shell')
      if (sh) cutoff = sh.index
    } else if ('clarify' in r) {
      if (!leaves.length) return { type: 'clarify', question: r.clarify }
    } else return { type: 'refuse', code: r.code, reason: r.refuse }
  }

  // Presets by name or keyword when nothing concrete matched (or when explicitly asked for).
  const wantsPreset = /\bpreset\b/.test(t)
  let presetApp: string | undefined
  if (!leaves.length || wantsPreset) {
    const presets = ctx.presets ?? []
    const pm = matchPresets(t, presets)
    if (pm.preset) {
      const p = pm.preset
      const steps = p.action.kind === 'macro' ? p.action.steps : [p.action]
      if (wantsPreset) leaves.length = 0
      steps.forEach((s, i) => leaves.push({ index: 10_000 + i, value: s as LeafAction }))
      if (p.app && p.app !== '*') presetApp = p.app
    } else if (pm.ambiguous) {
      return { type: 'clarify', question: `Which preset did you mean: ${pm.ambiguous.map((p) => p.name).join(', ')}?` }
    }
  }

  // Impossible surfaces (checked after zones so "above the keyboard" still works).
  if (!zoneHits.length) {
    for (const [re, name] of IMPOSSIBLE_SURFACES) {
      const m = rest.match(re)
      if (m && g.gesture && ['tap', 'double', 'triple', 'sequence', 'rhythm'].includes(g.gesture)) {
        const before = rest.slice(0, m.index)
        // "press cmd+w" style text is an action, not a surface.
        if (!/\b(press|send|hit)\s*$/.test(before))
          return { type: 'refuse', code: 'impossible', reason: `Ghostkeys cannot sense taps on ${name}; pick one of the blank zones instead.` }
      }
    }
  }

  if (!leaves.length) {
    if (/\bmute (my |the )?(mic|microphone)\b/.test(t))
      return { type: 'clarify', question: 'Which app should the microphone mute apply to, for example Zoom or Google Meet?' }
    return { type: 'clarify', question: 'What should the gesture do, for example lock the screen, play or pause music, or open an app?' }
  }

  // Order actions by where they appear, drop duplicates.
  leaves.sort((a, b) => a.index - b.index)
  const uniq: LeafAction[] = []
  for (const l of leaves) if (!uniq.some((u) => JSON.stringify(u) === JSON.stringify(l.value))) uniq.push(l.value)
  if (uniq.length > MACRO_MAX_STEPS) return { type: 'refuse', code: 'impossible', reason: `A macro can have at most ${MACRO_MAX_STEPS} steps.` }

  // Gesture.
  if (!g.gesture) {
    return {
      type: 'clarify',
      question: `Which gesture should trigger this, for example a double tap on the right grille or a triple tap anywhere?`
    }
  }
  let gesture: Gesture = g.gesture
  let zone: string | null = null
  let zones: string[] | null = null
  let allZones = false
  const zoneGesture = ['tap', 'double', 'triple', 'rhythm', 'sequence'].includes(gesture)
  const distinctZones = [...new Set(zoneHits.map((z) => z.value))]
  if (zoneGesture) {
    if (distinctZones.length >= 2 && g.sequenceHint && (gesture === 'tap' || gesture === 'sequence')) {
      gesture = 'sequence'
      zones = distinctZones.slice(0, 2)
      zone = zones[0]!
    } else if (distinctZones.length >= 1) {
      zone = distinctZones[0]!
      if (distinctZones.length > 1)
        return { type: 'clarify', question: `Should this use the ${distinctZones.map((z) => z.replace(/-/g, ' ')).join(' or the ')}?` }
    } else if (/\b(anywhere|any ?where on|any zone|everywhere|any surface|any spot)\b/.test(t)) {
      allZones = true
    } else if (ctx.config.zones.length === 1) {
      zone = ctx.config.zones[0]!.id
    } else {
      return { type: 'clarify', question: `Which zone should the ${gesture === 'tap' ? 'tap' : `${gesture} tap`} be on, for example the right grille or the left palm rest?` }
    }
    // A named default zone that has not been calibrated is not usable.
    for (const z of zones ?? (zone ? [zone] : [])) {
      if (!ctx.config.zones.some((c) => c.id === z))
        return { type: 'refuse', code: 'impossible', reason: `The ${z.replace(/-/g, ' ')} zone is not set up yet; calibrate it first, then try again.` }
    }
  }

  // App layer.
  const layer = findAppLayer(t, ctx)
  if (layer.needsFrontmost) return { type: 'clarify', question: 'Which app should this binding be limited to?' }
  let app = layer.app ?? presetApp ?? '*'
  if (app !== '*' && !findAppByBundle(app) && !/\./.test(app)) app = '*'

  const action =
    uniq.length === 1
      ? uniq[0]!
      : { kind: 'macro' as const, steps: uniq.map((s) => ({ ...s }) as MacroStep) }

  return {
    type: 'binding',
    draft: { gesture, zone, zones, allZones, modifiers: findGestureModifiers(t), app, action }
  }
}
