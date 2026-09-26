/**
 * A small, dependency-free, non-cryptographic string hash (FNV-1a, 32-bit, hex-encoded). Used only
 * to give a `Config` snapshot a short "revision" fingerprint for optimistic concurrency; it does
 * not need to be collision-proof against an adversary, only good enough to notice "this config
 * object is not byte-for-byte the one I last read."
 */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Stable-ish stringify: sorts object keys so key order doesn't change the hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeysDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

export function configRevision(config: unknown): string {
  return fnv1a(stableStringify(config))
}
