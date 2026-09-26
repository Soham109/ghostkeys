import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Action } from '@ghostkeys/sdk'

/**
 * One entry in presets/library.json. Field names and shapes match presets/schema.json exactly
 * (the "preset" definition there): title/subtitle rather than name/description, keywords and apps
 * as arrays, and destructive/requires/verify as metadata alongside the action itself.
 */
export interface Preset {
  id: string
  title: string
  subtitle: string
  category: string
  keywords: string[]
  action: Action
  destructive: boolean
  requires: string[]
  /** "*" for every app, or one or more bundle ids. */
  apps: string[]
  verify?: boolean
}

interface PresetLibraryFile {
  version: number
  presets: Preset[]
}

function packageRoot(): string {
  // src/presets.ts and dist/presets.js are both one level under the package root.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  return path.join(moduleDir, '..')
}

/** "reads ../../presets/library.json if present" - resolved relative to this package's root. */
export function presetsLibraryPath(): string {
  return path.join(packageRoot(), '../../presets/library.json')
}

/** Returns null (not an error) if no library file exists at presetsLibraryPath(). */
export async function loadPresets(): Promise<Preset[] | null> {
  const file = presetsLibraryPath()
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf8')
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`)
  }
  if (Array.isArray(data)) return data as Preset[]
  if (data && typeof data === 'object' && Array.isArray((data as Partial<PresetLibraryFile>).presets)) {
    return (data as PresetLibraryFile).presets
  }
  throw new Error(`${file} is not a preset library: expected a JSON array, or { "version": ..., "presets": [...] }`)
}

export function searchPresets(presets: Preset[], query: string): Preset[] {
  const q = query.trim().toLowerCase()
  if (!q) return presets
  return presets.filter((p) => {
    const haystack = [p.id, p.title, p.subtitle, p.category, p.keywords.join(' '), p.apps.join(' ')].join(' ').toLowerCase()
    return haystack.includes(q)
  })
}

export function findPreset(presets: Preset[], id: string): Preset | undefined {
  const needle = id.trim().toLowerCase()
  return presets.find((p) => p.id.toLowerCase() === needle)
}
