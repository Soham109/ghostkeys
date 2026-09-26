#!/usr/bin/env node
// Validates presets/library.json and presets/layouts/*.json against docs/PROTOCOL.md.
// Plain Node, no dependencies. Run with: node presets/validate.mjs

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIBRARY_PATH = path.join(HERE, 'library.json')
const LAYOUTS_DIR = path.join(HERE, 'layouts')

const errors = []
const warn = (msg) => errors.push(msg)

const DASH_RE = /[–—]/ // en dash, em dash

const MODIFIERS = new Set(['shift', 'control', 'option', 'command', 'fn'])
const WINDOW_OPS = new Set(['left', 'right', 'top', 'bottom', 'maximize', 'center', 'next-display', 'minimize', 'fullscreen'])
const APP_OPS = new Set(['hide', 'quit', 'switch-next', 'switch-previous'])
const SYSTEM_OPS = new Set(['lock', 'sleep-display', 'screenshot', 'screenshot-area', 'dnd-toggle', 'mission-control', 'launchpad', 'show-desktop'])
const MEDIA_COMMANDS = new Set(['playpause', 'next', 'previous'])
const ACTION_KINDS = new Set(['keystroke', 'volume', 'mute', 'media', 'brightness', 'open', 'shell', 'applescript', 'shortcut', 'text', 'macro', 'clipboard', 'window', 'app', 'system'])
const GESTURES = new Set(['tap', 'double', 'triple', 'sequence', 'rhythm', 'lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right'])
const ZONELESS_GESTURES = new Set(['lid_nudge', 'cover', 'cover_hold', 'tilt_left', 'tilt_right'])
const DEFAULT_ZONES = new Set(['left-palm', 'right-palm', 'left-grille', 'right-grille', 'top-strip', 'left-edge', 'right-edge', 'lid'])

// ---------------------------------------------------------------- helpers

function checkNoDash(value, where) {
  if (typeof value === 'string' && DASH_RE.test(value)) {
    warn(`${where}: contains an em dash or en dash: ${JSON.stringify(value)}`)
  }
}

function checkStringField(obj, field, where, required = true) {
  const v = obj[field]
  if (v === undefined) {
    if (required) warn(`${where}: missing required field "${field}"`)
    return
  }
  if (typeof v !== 'string') {
    warn(`${where}: field "${field}" must be a string, got ${typeof v}`)
    return
  }
  checkNoDash(v, `${where}.${field}`)
}

/** Validates one action object (any kind, including macro) against docs/PROTOCOL.md. Returns true if it is destructive. */
function validateAction(action, where, depth = 0) {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) {
    warn(`${where}: action must be an object`)
    return false
  }
  const kind = action.kind
  if (!ACTION_KINDS.has(kind)) {
    warn(`${where}: unknown action kind ${JSON.stringify(kind)}`)
    return false
  }

  const requireFields = (fields) => {
    for (const f of fields) {
      if (!(f in action)) warn(`${where}: action kind "${kind}" is missing required field "${f}"`)
    }
  }
  const forbidExtra = (allowed) => {
    for (const k of Object.keys(action)) {
      if (k !== 'kind' && k !== 'delayMs' && !allowed.includes(k)) {
        warn(`${where}: action kind "${kind}" has unexpected field "${k}"`)
      }
    }
  }
  const checkModifiers = (mods) => {
    if (!Array.isArray(mods)) {
      warn(`${where}: "modifiers" must be an array`)
      return
    }
    for (const m of mods) {
      if (!MODIFIERS.has(m)) warn(`${where}: unknown modifier ${JSON.stringify(m)}`)
    }
  }

  let destructive = false

  switch (kind) {
    case 'keystroke':
      requireFields(['key', 'modifiers'])
      forbidExtra(['key', 'modifiers'])
      if (typeof action.key !== 'string' || action.key.length === 0) warn(`${where}: "key" must be a non-empty string`)
      if (action.modifiers) checkModifiers(action.modifiers)
      break
    case 'volume':
    case 'brightness':
      requireFields(['step'])
      forbidExtra(['step'])
      if (typeof action.step !== 'number') warn(`${where}: "step" must be a number`)
      break
    case 'mute':
      forbidExtra([])
      break
    case 'media':
      requireFields(['command'])
      forbidExtra(['command'])
      if (!MEDIA_COMMANDS.has(action.command)) warn(`${where}: unknown media command ${JSON.stringify(action.command)}`)
      break
    case 'open':
      requireFields(['target'])
      forbidExtra(['target'])
      checkStringField(action, 'target', where)
      break
    case 'shell':
      requireFields(['command'])
      forbidExtra(['command'])
      checkStringField(action, 'command', where)
      if (typeof action.command === 'string') {
        const cmd = action.command
        if (/\bsudo\b/.test(cmd)) warn(`${where}: shell command must never use sudo`)
        if (/\b(rm|mv|dd|shred|truncate|chmod|chown)\b/.test(cmd)) warn(`${where}: shell command looks like it modifies or deletes files: ${cmd}`)
        if (/\b(curl|wget|nc|ssh|scp|ftp)\b/.test(cmd)) warn(`${where}: shell command looks like it touches the network: ${cmd}`)
        if (/[>]{1,2}(?!&)/.test(cmd) && !/\/dev\/null/.test(cmd)) warn(`${where}: shell command looks like it writes to a file: ${cmd}`)
      }
      break
    case 'applescript':
      requireFields(['source'])
      forbidExtra(['source'])
      checkStringField(action, 'source', where)
      break
    case 'shortcut':
      requireFields(['name'])
      forbidExtra(['name'])
      checkStringField(action, 'name', where)
      break
    case 'text':
      requireFields(['text'])
      forbidExtra(['text'])
      checkStringField(action, 'text', where)
      break
    case 'clipboard':
      requireFields(['text'])
      forbidExtra(['text'])
      checkStringField(action, 'text', where)
      break
    case 'window':
      requireFields(['op'])
      forbidExtra(['op'])
      if (!WINDOW_OPS.has(action.op)) warn(`${where}: unknown window op ${JSON.stringify(action.op)}`)
      break
    case 'app':
      requireFields(['op'])
      forbidExtra(['op'])
      if (!APP_OPS.has(action.op)) warn(`${where}: unknown app op ${JSON.stringify(action.op)}`)
      if (action.op === 'quit') destructive = true
      break
    case 'system':
      requireFields(['op'])
      forbidExtra(['op'])
      if (!SYSTEM_OPS.has(action.op)) warn(`${where}: unknown system op ${JSON.stringify(action.op)}`)
      break
    case 'macro': {
      requireFields(['steps'])
      forbidExtra(['steps'])
      if (depth > 0) warn(`${where}: macro steps cannot themselves be macros`)
      if (!Array.isArray(action.steps)) {
        warn(`${where}: "steps" must be an array`)
        break
      }
      if (action.steps.length === 0) warn(`${where}: macro must have at least one step`)
      if (action.steps.length > 50) warn(`${where}: macro has ${action.steps.length} steps, the protocol max is 50`)
      let totalDelay = 0
      action.steps.forEach((s, i) => {
        if (s && typeof s === 'object' && 'delayMs' in s) {
          if (typeof s.delayMs !== 'number' || s.delayMs < 0) warn(`${where}.steps[${i}]: "delayMs" must be a non-negative number`)
          else totalDelay += s.delayMs
        }
        if (s && s.kind === 'macro') {
          warn(`${where}.steps[${i}]: a macro step cannot itself be kind "macro"`)
        } else {
          const stepDestructive = validateAction(s, `${where}.steps[${i}]`, depth + 1)
          if (stepDestructive) destructive = true
        }
      })
      if (totalDelay > 30000) warn(`${where}: macro total delay is ${totalDelay}ms, the protocol max is 30000ms`)
      break
    }
  }

  return destructive
}

// ---------------------------------------------------------------- library.json

function validateLibrary() {
  if (!fs.existsSync(LIBRARY_PATH)) {
    warn(`missing ${LIBRARY_PATH}`)
    return { counts: {}, total: 0 }
  }
  const raw = fs.readFileSync(LIBRARY_PATH, 'utf8')
  let data
  try {
    data = JSON.parse(raw)
  } catch (e) {
    warn(`library.json is not valid JSON: ${e.message}`)
    return { counts: {}, total: 0 }
  }

  if (typeof data.version !== 'number') warn('library.json: "version" must be a number')
  if (!Array.isArray(data.presets)) {
    warn('library.json: "presets" must be an array')
    return { counts: {}, total: 0 }
  }

  const ids = new Set()
  const counts = {}
  const requirementRe = /^automation:[A-Za-z0-9.\-]+$/

  for (const [i, p] of data.presets.entries()) {
    const where = `library.json presets[${i}]${p && p.id ? ` (${p.id})` : ''}`

    if (!p || typeof p !== 'object') {
      warn(`${where}: preset must be an object`)
      continue
    }

    for (const field of ['id', 'title', 'subtitle', 'category', 'keywords', 'action', 'destructive', 'requires', 'apps']) {
      if (!(field in p)) warn(`${where}: missing required field "${field}"`)
    }

    if (typeof p.id === 'string') {
      if (ids.has(p.id)) warn(`${where}: duplicate id "${p.id}"`)
      ids.add(p.id)
    } else {
      warn(`${where}: "id" must be a string`)
    }

    checkStringField(p, 'title', where)
    checkStringField(p, 'subtitle', where)
    checkStringField(p, 'category', where)

    if (Array.isArray(p.keywords)) {
      p.keywords.forEach((k, ki) => checkStringField({ k }, 'k', `${where}.keywords[${ki}]`))
    } else if (p.keywords !== undefined) {
      warn(`${where}: "keywords" must be an array`)
    }

    let destructiveFromAction = false
    if (p.action !== undefined) {
      destructiveFromAction = validateAction(p.action, `${where}.action`)
    }

    if (typeof p.destructive !== 'boolean') {
      warn(`${where}: "destructive" must be a boolean`)
    } else if (destructiveFromAction && !p.destructive) {
      // One-directional: an action that is structurally destructive per PROTOCOL.md (app quit,
      // or a macro containing one) must be flagged. A curator may also flag other actions whose
      // real-world effect is consequential (e.g. leaving a call) even though the action kind
      // itself is "just a keystroke"; that additional caution is never an error.
      warn(`${where}: "destructive" is false but the action contains an app quit`)
    }

    if (Array.isArray(p.requires)) {
      for (const r of p.requires) {
        if (r !== 'accessibility' && !requirementRe.test(r)) {
          warn(`${where}: "requires" entry ${JSON.stringify(r)} must be "accessibility" or match "automation:<bundle id>"`)
        }
      }
    } else if (p.requires !== undefined) {
      warn(`${where}: "requires" must be an array`)
    }

    if (Array.isArray(p.apps)) {
      if (p.apps.length === 0) warn(`${where}: "apps" must not be empty`)
      for (const a of p.apps) {
        if (typeof a !== 'string' || a.length === 0) warn(`${where}: "apps" entries must be non-empty strings`)
      }
    } else if (p.apps !== undefined) {
      warn(`${where}: "apps" must be an array`)
    }

    if (typeof p.category === 'string') {
      counts[p.category] = (counts[p.category] || 0) + 1
    }
  }

  return { counts, total: data.presets.length }
}

// ---------------------------------------------------------------- layouts

function validateLayouts() {
  if (!fs.existsSync(LAYOUTS_DIR)) {
    warn(`missing ${LAYOUTS_DIR}`)
    return []
  }
  const files = fs.readdirSync(LAYOUTS_DIR).filter((f) => f.endsWith('.json')).sort()
  const summaries = []

  for (const file of files) {
    const full = path.join(LAYOUTS_DIR, file)
    let data
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch (e) {
      warn(`${file}: not valid JSON: ${e.message}`)
      continue
    }

    for (const field of ['id', 'name', 'description', 'bindings']) {
      if (!(field in data)) warn(`${file}: missing required field "${field}"`)
    }
    checkStringField(data, 'name', file)
    checkStringField(data, 'description', file)

    if (!Array.isArray(data.bindings)) {
      warn(`${file}: "bindings" must be an array`)
      continue
    }
    if (data.bindings.length < 8 || data.bindings.length > 14) {
      warn(`${file}: has ${data.bindings.length} bindings, layouts must bind 8 to 14 gestures`)
    }

    const bindingIds = new Set()
    for (const [i, b] of data.bindings.entries()) {
      const where = `${file} bindings[${i}]${b && b.id ? ` (${b.id})` : ''}`

      for (const field of ['id', 'enabled', 'gesture', 'zone', 'zones', 'modifiers', 'app', 'action', 'label']) {
        if (!(field in b)) warn(`${where}: missing required field "${field}"`)
      }

      if (typeof b.id === 'string') {
        if (bindingIds.has(b.id)) warn(`${where}: duplicate binding id "${b.id}" within ${file}`)
        bindingIds.add(b.id)
      } else {
        warn(`${where}: "id" must be a string`)
      }

      if (typeof b.enabled !== 'boolean') warn(`${where}: "enabled" must be a boolean`)

      if (!GESTURES.has(b.gesture)) {
        warn(`${where}: unknown gesture ${JSON.stringify(b.gesture)}`)
      }

      if (Array.isArray(b.modifiers)) {
        for (const m of b.modifiers) if (!MODIFIERS.has(m)) warn(`${where}: unknown modifier ${JSON.stringify(m)}`)
      } else {
        warn(`${where}: "modifiers" must be an array`)
      }

      if (typeof b.app !== 'string' || b.app.length === 0) warn(`${where}: "app" must be a non-empty string`)

      checkStringField(b, 'label', where)

      // zone / zones consistency with gesture
      if (GESTURES.has(b.gesture)) {
        if (b.gesture === 'sequence') {
          if (b.zone !== null) warn(`${where}: gesture "sequence" requires "zone" to be null`)
          if (!Array.isArray(b.zones) || b.zones.length !== 2) {
            warn(`${where}: gesture "sequence" requires "zones" to be an array of exactly two zone ids`)
          } else {
            for (const z of b.zones) if (!DEFAULT_ZONES.has(z)) warn(`${where}: unknown zone ${JSON.stringify(z)} in "zones"`)
          }
        } else if (ZONELESS_GESTURES.has(b.gesture)) {
          if (b.zone !== null) warn(`${where}: gesture ${JSON.stringify(b.gesture)} is zoneless, "zone" must be null`)
          if (b.zones !== null) warn(`${where}: gesture ${JSON.stringify(b.gesture)} is zoneless, "zones" must be null`)
        } else {
          // tap, double, triple, rhythm
          if (typeof b.zone !== 'string' || !DEFAULT_ZONES.has(b.zone)) {
            warn(`${where}: gesture ${JSON.stringify(b.gesture)} requires "zone" to be a known zone id, got ${JSON.stringify(b.zone)}`)
          }
          if (b.zones !== null) warn(`${where}: gesture ${JSON.stringify(b.gesture)} requires "zones" to be null`)

          // palm rests only take double taps
          if ((b.zone === 'left-palm' || b.zone === 'right-palm') && b.gesture !== 'double') {
            warn(`${where}: zone ${JSON.stringify(b.zone)} is a palm rest and may only be bound with the "double" gesture, got ${JSON.stringify(b.gesture)}`)
          }
        }
      }

      let destructive = false
      if (b.action !== undefined) {
        destructive = validateAction(b.action, `${where}.action`)
      }

      // destructive actions must never fire on a single tap
      if (destructive && b.gesture === 'tap') {
        warn(`${where}: destructive action is bound to a single "tap", which is not allowed in a layout`)
      }
    }

    summaries.push({ file, id: data.id, bindings: Array.isArray(data.bindings) ? data.bindings.length : 0 })
  }

  return summaries
}

// ---------------------------------------------------------------- run

const libResult = validateLibrary()
const layoutSummaries = validateLayouts()

console.log('Ghostkeys presets validation')
console.log('=============================')
console.log(`library.json: ${libResult.total} presets`)
for (const [cat, n] of Object.entries(libResult.counts).sort()) {
  console.log(`  ${cat}: ${n}`)
}
console.log('')
console.log('layouts:')
for (const s of layoutSummaries) {
  console.log(`  ${s.file} (${s.id}): ${s.bindings} bindings`)
}
console.log('')

if (errors.length > 0) {
  console.log(`FAILED: ${errors.length} problem(s)`)
  for (const e of errors) console.log(`  - ${e}`)
  process.exit(1)
} else {
  console.log('PASSED: no problems found')
  process.exit(0)
}
