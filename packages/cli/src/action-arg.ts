import { actionSchema, type Action } from '@ghostkeys/sdk'
import { findPreset, presetsLibraryPath, type Preset } from './presets.js'

export class ActionArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActionArgError'
  }
}

function looksLikeJSON(s: string): boolean {
  const t = s.trim()
  return t.startsWith('{') || t.startsWith('[')
}

/** Resolves a `gk bind` action argument: inline JSON, or a preset id looked up in `presets`. */
export function resolveActionArg(arg: string, presets: Preset[] | null): { action: Action; label?: string } {
  if (looksLikeJSON(arg)) {
    let raw: unknown
    try {
      raw = JSON.parse(arg)
    } catch (error) {
      throw new ActionArgError(`invalid action JSON: ${(error as Error).message}`)
    }
    const result = actionSchema.safeParse(raw)
    if (!result.success) {
      throw new ActionArgError(`invalid action: ${result.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    }
    return { action: result.data as Action }
  }

  if (!presets) {
    throw new ActionArgError(
      `"${arg}" isn't inline JSON, and no preset library was found at ${presetsLibraryPath()}. ` +
        'Pass an action object instead, e.g. \'{"kind":"volume","step":6}\'.'
    )
  }
  const preset = findPreset(presets, arg)
  if (!preset) {
    throw new ActionArgError(`no preset "${arg}" found. Try: gk presets search ${arg}`)
  }
  return { action: preset.action, label: preset.title }
}
