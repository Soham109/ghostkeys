// Loads the shared preset library (repo presets/library.json and presets/layouts/*.json) in a
// forgiving way: anything that does not look like a valid preset or binding is skipped.
import { ACTION_KINDS, GESTURES, MODIFIERS, SURFACES, type Action, type Binding, type GestureKind, type Modifier, type Zone } from './protocol'
import { PRESETS, describeAction, type Preset } from './actions'

export interface LibraryLayout {
  id: string
  name: string
  description: string
  family: string | null
  zones: Zone[] | null
  bindings: Binding[]
}

export interface Library {
  source: 'file' | 'builtin'
  presets: Preset[]
  layouts: LibraryLayout[]
  categories: string[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

function asAction(v: unknown): Action | null {
  if (!isObj(v) || typeof v.kind !== 'string' || !(ACTION_KINDS as string[]).includes(v.kind)) return null
  if (v.kind === 'macro') {
    const steps = Array.isArray(v.steps) ? v.steps.map(asAction).filter((s): s is Action => !!s && s.kind !== 'macro') : []
    return { kind: 'macro', steps: steps as never }
  }
  if (v.kind === 'keystroke') {
    const mods = Array.isArray(v.modifiers) ? v.modifiers.filter((m): m is Modifier => (MODIFIERS as string[]).includes(m as string)) : []
    const key = str(v.key)
    return key ? { kind: 'keystroke', key: key.toLowerCase(), modifiers: mods } : null
  }
  return v as unknown as Action
}

function listOf(raw: unknown, key: string): unknown[] {
  if (Array.isArray(raw)) return raw
  if (isObj(raw)) {
    const v = raw[key]
    if (Array.isArray(v)) return v
    // { "Media": [ ... ], "Window": [ ... ] }
    const groups = Object.entries(raw).filter(([, g]) => Array.isArray(g))
    if (groups.length) return groups.flatMap(([cat, g]) => (g as unknown[]).map((p) => (isObj(p) ? { category: cat, ...p } : p)))
  }
  return []
}

export function normalizePresets(raw: unknown): Preset[] {
  const out: Preset[] = []
  const ids = new Set<string>()
  for (const [i, item] of listOf(raw, 'presets').entries()) {
    if (!isObj(item)) continue
    const action = asAction(item.action)
    if (!action) continue
    let id = str(item.id) ?? `preset-${i}`
    while (ids.has(id)) id = `${id}-${i}`
    ids.add(id)
    const words = (v: unknown): string | undefined => (Array.isArray(v) ? v.filter((t) => typeof t === 'string').join(' ') : str(v))
    const tags = [words(item.tags), words(item.keywords)].filter(Boolean).join(' ') || undefined
    const apps = Array.isArray(item.apps) ? item.apps.filter((a): a is string => typeof a === 'string' && a !== '*') : []
    const description = str(item.description) ?? str(item.subtitle)
    out.push({
      id,
      name: str(item.name) ?? str(item.title) ?? str(item.label) ?? describeAction(action),
      category: str(item.category) ?? str(item.group) ?? 'Other',
      action,
      app: str(item.app) ?? str(item.bundleId) ?? str(item.appLayer) ?? apps[0],
      keywords: [tags, description].filter(Boolean).join(' ') || undefined,
      description
    })
  }
  return out
}

function asZone(v: unknown): Zone | null {
  if (!isObj(v) || !str(v.id) || !isObj(v.rect) || !(SURFACES as string[]).includes(v.surface as string)) return null
  const r = v.rect as Obj
  if (![r.x, r.y, r.w, r.h].every((n) => typeof n === 'number')) return null
  return v as unknown as Zone
}

export function normalizeLayout(raw: unknown, fallbackId: string, presets: Preset[]): LibraryLayout | null {
  if (!isObj(raw)) return null
  const bindingsRaw = Array.isArray(raw.bindings) ? raw.bindings : []
  const bindings: Binding[] = []
  for (const [i, b] of bindingsRaw.entries()) {
    if (!isObj(b)) continue
    const presetId = str(b.preset) ?? str(b.presetId)
    const preset = presetId ? presets.find((p) => p.id === presetId) : undefined
    const action = asAction(b.action) ?? preset?.action
    const gesture = (GESTURES as string[]).includes(b.gesture as string) ? (b.gesture as GestureKind) : null
    if (!action || !gesture) continue
    bindings.push({
      id: str(b.id) ?? `${fallbackId}-${i + 1}`,
      enabled: b.enabled !== false,
      gesture,
      zone: str(b.zone) ?? null,
      zones: Array.isArray(b.zones) ? (b.zones.filter((z) => typeof z === 'string') as string[]) : null,
      modifiers: Array.isArray(b.modifiers) ? (b.modifiers.filter((m) => (MODIFIERS as string[]).includes(m as string)) as Modifier[]) : [],
      app: str(b.app) ?? preset?.app ?? '*',
      action,
      label: str(b.label) ?? preset?.name ?? describeAction(action)
    })
  }
  if (!bindings.length) return null
  const zones = Array.isArray(raw.zones) ? raw.zones.map(asZone).filter((z): z is Zone => !!z) : null
  return {
    id: str(raw.id) ?? fallbackId,
    name: str(raw.name) ?? str(raw.title) ?? fallbackId,
    description: str(raw.description) ?? '',
    family: str(raw.family) ?? null,
    zones: zones?.length ? zones : null,
    bindings
  }
}

export function builtinLibrary(): Library {
  return { source: 'builtin', presets: PRESETS, layouts: [], categories: categoriesOf(PRESETS) }
}

export function categoriesOf(presets: Preset[]): string[] {
  const seen: string[] = []
  for (const p of presets) if (!seen.includes(p.category)) seen.push(p.category)
  return seen
}
