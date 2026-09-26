import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { builtinLibrary, categoriesOf, normalizeLayout, normalizePresets, type Library, type LibraryLayout } from '@shared/library'

/** Reads presets/library.json and presets/layouts/*.json; falls back to the built-in list. */
export function loadLibrary(dir: string): Library {
  const fallback = builtinLibrary()
  const file = join(dir, 'library.json')
  let presets = fallback.presets
  let source: Library['source'] = 'builtin'
  if (existsSync(file)) {
    try {
      const parsed = normalizePresets(JSON.parse(readFileSync(file, 'utf8')))
      if (parsed.length) {
        presets = parsed
        source = 'file'
      }
    } catch (e) {
      console.error('[library] could not read', file, e)
    }
  }
  const layouts: LibraryLayout[] = []
  const layoutDir = join(dir, 'layouts')
  if (existsSync(layoutDir)) {
    for (const f of readdirSync(layoutDir).filter((n) => n.endsWith('.json')).sort()) {
      try {
        const l = normalizeLayout(JSON.parse(readFileSync(join(layoutDir, f), 'utf8')), basename(f, '.json'), presets)
        if (l) layouts.push(l)
      } catch (e) {
        console.error('[library] bad layout', f, e)
      }
    }
  }
  return { source, presets, layouts, categories: categoriesOf(presets) }
}
