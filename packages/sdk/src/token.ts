/**
 * Resolves the `X-Ghostkeys-Token` handshake header (docs/PROTOCOL.md "Authentication"):
 * `GHOSTKEYS_TOKEN` from the environment if it's at least 32 characters (matching the daemon's own
 * acceptance rule in SessionToken.swift), otherwise the token the daemon wrote to
 * `~/Library/Application Support/Ghostkeys/token` on this launch.
 *
 * Node-only: both `process.env` and the token file need Node APIs, so this dynamically imports
 * `node:fs`/`node:os` instead of importing them at module scope. That keeps this file safe to pull
 * into a browser bundle (the dynamic imports simply reject there, which `readGhostkeysToken`
 * swallows) even though, per the daemon's own design, a browser page could never use a token
 * anyway - it has no API to set a custom handshake header in the first place.
 */
export async function readGhostkeysToken(): Promise<string | undefined> {
  try {
    const envToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.GHOSTKEYS_TOKEN
    const trimmed = envToken?.trim()
    if (trimmed && trimmed.length >= 32) return trimmed
  } catch {
    // no `process` (browser) - fall through to the file, which will also fail harmlessly.
  }
  try {
    const [{ readFile }, os, path] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')])
    const file = path.join(os.homedir(), 'Library', 'Application Support', 'Ghostkeys', 'token')
    const raw = await readFile(file, 'utf8')
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}
