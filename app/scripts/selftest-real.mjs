// Runs the app offscreen against the REAL daemon (built at ../daemon/.build-app) and checks the protocol end to end.
// The daemon runs with --dry-run (no action really happens) and a scratch config folder, so your config is untouched.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const configDir = mkdtempSync(join(process.env.GK_SCRATCH ?? tmpdir(), 'ghostkeys-selftest-'))
const env = {
  ...process.env,
  SELFTEST: '1',
  GK_PORT: process.env.GK_PORT ?? '47932',
  GHOSTKEYSD_PATH: join(root, '../daemon/.build-app/debug/ghostkeysd'),
  GHOSTKEYSD_ARGS: '--dry-run --no-hardware-sessions',
  GHOSTKEYS_CONFIG_DIR: configDir
}
delete env.GK_MOCK
delete env.GHOSTKEYS_TOKEN
delete env.ELECTRON_RENDERER_URL

const app = spawn(`${root}node_modules/.bin/electron`, ['.'], { cwd: root, env, stdio: 'inherit' })
const code = await new Promise((r) => app.on('exit', r))
rmSync(configDir, { recursive: true, force: true })
process.exit(code ?? 1)
