// Offline license keys. Format (placeholder until real signing ships):
//
//   GK1.<base64url(JSON payload)>.<base64url(64-byte Ed25519 signature)>
//
// payload: { "product": "ghostkeys", "tier": "pro" | "teams", "holder": "Name", "email"?: "...", "issued": "YYYY-MM-DD",
//            "seats"?: number }
//
// TODO(license): verify the Ed25519 signature against the embedded public key before trusting the payload.
// Today only the shape is checked, which is fine for the hackathon demo (DEMO_UNLOCK) and never blocks anything.

export type Tier = 'free' | 'pro' | 'teams'

export interface LicenseState {
  tier: Tier
  holder: string | null
  issued: string | null
  /** 'key' when a well-formed key is stored, 'none' otherwise. */
  source: 'key' | 'none'
  /** True while the build flag DEMO_UNLOCK is on: nothing is ever gated. */
  demoUnlock: boolean
  /** Signature verification is not implemented yet. */
  verified: false
}

export const FREE_LICENSE: LicenseState = { tier: 'free', holder: null, issued: null, source: 'none', demoUnlock: true, verified: false }

function b64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return null
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  try {
    const bin = atob(pad)
    return Uint8Array.from(bin, (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

export type ParsedLicense = { ok: true; tier: Exclude<Tier, 'free'>; holder: string; issued: string } | { ok: false; error: string }

export function parseLicense(raw: string): ParsedLicense {
  const key = raw.trim().replace(/\s+/g, '')
  const parts = key.split('.')
  if (parts.length !== 3 || parts[0] !== 'GK1') return { ok: false, error: 'That is not a Ghostkeys license key. Keys start with GK1.' }
  const payloadBytes = b64urlDecode(parts[1]!)
  const sig = b64urlDecode(parts[2]!)
  if (!payloadBytes) return { ok: false, error: 'The key is damaged. Copy it again from your receipt.' }
  if (!sig || sig.length !== 64) return { ok: false, error: 'The key is missing its signature. Copy it again from your receipt.' }
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes))
  } catch {
    return { ok: false, error: 'The key is damaged. Copy it again from your receipt.' }
  }
  const p = payload as Record<string, unknown>
  if (p.product !== 'ghostkeys') return { ok: false, error: 'This key is for a different product.' }
  if (p.tier !== 'pro' && p.tier !== 'teams') return { ok: false, error: 'This key does not name a Pro or Teams license.' }
  if (typeof p.holder !== 'string' || !p.holder.trim()) return { ok: false, error: 'This key has no license holder.' }
  const issued = typeof p.issued === 'string' ? p.issued : ''
  // TODO(license): Ed25519 verify(sig, parts[1], PUBLIC_KEY). Until then the shape is all we check.
  return { ok: true, tier: p.tier, holder: p.holder.trim(), issued }
}

export function licenseState(key: string | null | undefined, demoUnlock: boolean): LicenseState {
  if (!key) return { ...FREE_LICENSE, demoUnlock }
  const r = parseLicense(key)
  if (!r.ok) return { ...FREE_LICENSE, demoUnlock }
  return { tier: r.tier, holder: r.holder, issued: r.issued || null, source: 'key', demoUnlock, verified: false }
}

/** A well-formed sample key for the demo and tests (its signature is zeros, so it will fail real verification). */
export function sampleKey(holder = 'Demo User'): string {
  const enc = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = new TextEncoder().encode(JSON.stringify({ product: 'ghostkeys', tier: 'pro', holder, issued: '2026-09-26' }))
  return `GK1.${enc(payload)}.${enc(new Uint8Array(64))}`
}
