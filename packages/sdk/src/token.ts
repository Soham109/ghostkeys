/**
 * Resolves the `X-Ghostkeys-Token` handshake header (docs/PROTOCOL.md "Authentication").
 *
 * Checked in order, first hit wins:
 *   1. `GHOSTKEYS_TOKEN` from the environment, if it's at least 32 characters (matching the
 *      daemon's own acceptance rule in SessionToken.swift).
 *   2. `$GHOSTKEYS_CONFIG_DIR/token`, when that variable is set - the daemon treats it as its
 *      whole config directory (ConfigStore.configure), overriding the default location entirely.
 *   3. `~/Library/Application Support/Ghostkeys/daemon/token` - the current default: the daemon's
 *      own files live one level down from the shared Electron profile directory.
 *   4. `~/Library/Application Support/Ghostkeys/token` - the pre-migration location, kept as a
 *      last resort for a daemon build old enough to still use it.
 *
 * Node-only: both `process.env` and the token files need Node APIs, so this dynamically imports
 * `node:fs`/`node:os`/`node:path` instead of importing them at module scope. That keeps this file
 * safe to pull into a browser bundle (the dynamic imports simply reject there, which
 * `readGhostkeysToken` swallows) even though, per the daemon's own design, a browser page could
 * never use a token anyway - it has no API to set a custom handshake header in the first place.
 */

function currentEnv(): Record<string, string | undefined> | undefined {
  try {
    return (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env
  } catch {
    return undefined
  }
}

/**
 * Pure: the ordered list of token file paths to try, given a home directory and an optional
 * `GHOSTKEYS_CONFIG_DIR` override. Exported separately from `readGhostkeysToken` so the ordering
 * and path construction can be tested without touching any real files or the real home directory.
 */
export function tokenFilePaths(homeDir: string, configDir: string | undefined, join: (...parts: string[]) => string): string[] {
  const paths: string[] = []
  const trimmedConfigDir = configDir?.trim()
  if (trimmedConfigDir) paths.push(join(trimmedConfigDir, 'token'))
  const legacyDirectory = join(homeDir, 'Library', 'Application Support', 'Ghostkeys')
  paths.push(join(legacyDirectory, 'daemon', 'token'))
  paths.push(join(legacyDirectory, 'token'))
  return paths
}

export async function readGhostkeysToken(): Promise<string | undefined> {
  const env = currentEnv()
  const envToken = env?.GHOSTKEYS_TOKEN?.trim()
  if (envToken && envToken.length >= 32) return envToken

  let readFile: typeof import('node:fs/promises').readFile
  let homedir: () => string
  let join: (...parts: string[]) => string
  try {
    const [fs, os, path] = await Promise.all([import('node:fs/promises'), import('node:os'), import('node:path')])
    readFile = fs.readFile
    homedir = os.homedir
    join = path.join
  } catch {
    return undefined
  }

  for (const file of tokenFilePaths(homedir(), env?.GHOSTKEYS_CONFIG_DIR, join)) {
    try {
      const raw = await readFile(file, 'utf8')
      const trimmed = raw.trim()
      if (trimmed.length > 0) return trimmed
    } catch {
      // this candidate doesn't exist (or isn't readable) - try the next one.
    }
  }
  return undefined
}
