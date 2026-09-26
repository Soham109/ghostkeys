import * as React from 'react'
import { builtinLibrary, type Library } from '@shared/library'

let cache: Library | null = null
let pending: Promise<Library> | null = null

function load(): Promise<Library> {
  pending ??= window.gk
    .library()
    .catch(() => builtinLibrary())
    .then((l) => (cache = l))
  return pending
}

/** The preset library from presets/library.json, or the built-in fallback. */
export function useLibrary(): Library {
  const [lib, setLib] = React.useState<Library>(() => cache ?? builtinLibrary())
  React.useEffect(() => {
    let alive = true
    void load().then((l) => alive && setLib(l))
    return () => {
      alive = false
    }
  }, [])
  return lib
}
