/** Load the preset library (../../presets/library.json from the package root). Absence is fine. */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ActionSchema } from './schema.js'
import type { Preset } from './types.js'

export const DEFAULT_LIBRARY_PATH = fileURLToPath(new URL('../../../presets/library.json', import.meta.url))

/** Accepts an array of presets or `{ presets: [...] }`. Entries without a valid action are skipped. */
export function parsePresetLibrary(raw: unknown): Preset[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { presets?: unknown }).presets)
      ? (raw as { presets: unknown[] }).presets
      : []
  const out: Preset[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    if (typeof p['id'] !== 'string' || typeof p['name'] !== 'string') continue
    const action = ActionSchema.safeParse(p['action'])
    if (!action.success) continue
    const kw = p['keywords']
    out.push({
      id: p['id'],
      name: p['name'],
      category: typeof p['category'] === 'string' ? p['category'] : undefined,
      keywords: Array.isArray(kw) ? kw.filter((k): k is string => typeof k === 'string') : typeof kw === 'string' ? kw.split(/\s+/).filter(Boolean) : [],
      app: typeof p['app'] === 'string' ? p['app'] : undefined,
      action: action.data
    })
  }
  return out
}

export function loadPresetLibrary(path: string = DEFAULT_LIBRARY_PATH): Preset[] {
  try {
    if (!existsSync(path)) return []
    return parsePresetLibrary(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return []
  }
}
