// End-to-end UI check against a REAL (simulated-sensor) daemon.
//   pnpm build && node scripts/verify/verify-app.mjs
// Starts ghostkeysd with synthetic sensors, no hardware sessions, dry-run actions and a scratch config folder, then
// runs the app offscreen with scripts/verify/driver.mjs in the main process. Nothing touches the user's config,
// Library, sensors, microphone or camera, and no action really runs. Screenshots: screenshots/verify/.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'

const root = new URL('../..', import.meta.url).pathname
const scratch = process.env.GK_SCRATCH ?? join(root, '.cache')
mkdirSync(scratch, { recursive: true })
const configDir = mkdtempSync(join(scratch, 'ghostkeys-verify-config-'))
const userData = mkdtempSync(join(scratch, 'ghostkeys-verify-userdata-'))
const port = process.env.GK_PORT ?? '47985'
const token = randomBytes(32).toString('hex')
const bin = process.env.GHOSTKEYSD_PATH ?? join(root, '../daemon/.build-app/debug/ghostkeysd')
if (!existsSync(bin)) {
  console.error(`[verify] no daemon at ${bin}; build it or set GHOSTKEYSD_PATH`)
  process.exit(2)
}
// A stale daemon build fails checks for features the app now relies on: warn when any daemon source is newer.
{
  const newest = (dir) =>
    readdirSync(dir, { withFileTypes: true }).reduce((m, e) => Math.max(m, e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs), 0)
  const src = join(root, '../daemon/Sources')
  if (existsSync(src) && newest(src) > statSync(bin).mtimeMs)
    console.warn(`[verify] warning: ${bin} is older than daemon/Sources; rebuild it or set GHOSTKEYSD_PATH to a current build`)
}

const daemonArgs = ['--simulate-sensors', '--no-hardware-sessions', '--dry-run', '--config-dir', configDir, '--port', port, '--parent-pid', String(process.pid)]
const daemon = spawn(bin, daemonArgs, { env: { ...process.env, GHOSTKEYS_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] })
const log = []
daemon.stdout.on('data', (d) => log.push(String(d)))
daemon.stderr.on('data', (d) => log.push(String(d)))

const open = () =>
  new Promise((r) => {
    const s = createConnection({ port: Number(port), host: '127.0.0.1' })
    s.on('connect', () => (s.destroy(), r(true)))
    s.on('error', () => r(false))
  })
let up = false
for (let i = 0; i < 80 && !up; i++) {
  up = await open()
  if (!up) await new Promise((r) => setTimeout(r, 250))
}
if (!up) {
  console.error('[verify] daemon did not open its port\n' + log.join(''))
  daemon.kill('SIGTERM')
  process.exit(2)
}

const env = {
  ...process.env,
  GK_PORT: port,
  GHOSTKEYS_TOKEN: token,
  GK_USERDATA: userData,
  // The app reads an external daemon's token from its config folder: point it at the scratch one, never the Library.
  GHOSTKEYS_CONFIG_DIR: configDir,
  GK_VERIFY_DRIVER: join(root, 'scripts/verify/driver.mjs')
}
delete env.GK_MOCK
delete env.SELFTEST
delete env.SCREENSHOT
delete env.ELECTRON_RENDERER_URL
const app = spawn(`${root}node_modules/.bin/electron`, ['.'], { cwd: root, env, stdio: 'inherit' })
const code = await new Promise((r) => app.on('exit', r))
daemon.kill('SIGTERM')
await new Promise((r) => setTimeout(r, 800))
if (process.env.GK_VERIFY_DAEMON_LOG) console.log(log.join(''))
rmSync(configDir, { recursive: true, force: true })
rmSync(userData, { recursive: true, force: true })
process.exit(code ?? 1)
