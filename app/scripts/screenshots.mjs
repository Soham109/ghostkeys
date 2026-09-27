import { join } from 'node:path'
// Captures every screen to app/screenshots/*.png against the mock daemon.
// Windows render offscreen (webContents.capturePage); nothing is drawn on your display.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const root = new URL('..', import.meta.url).pathname
const bin = (name) => `${root}node_modules/.bin/${name}`
const port = process.env.GK_PORT ?? '47911'
const env = {
  ...process.env,
  GK_PORT: port,
  GK_MOCK: '1',
  GK_RATE: 'fast',
  GK_FAST: '1',
  SCREENSHOT: '1',
  GHOSTKEYS_TOKEN: randomBytes(32).toString('hex')
}
// Electron's caches go to a scratch folder, never the user's Library.
env.GK_USERDATA = process.env.GK_USERDATA ?? join(process.env.GK_SCRATCH ?? join(root, '.cache'), 'ghostkeys-app-userdata')
delete env.ELECTRON_RENDERER_URL

const mock = spawn(bin('tsx'), ['scripts/mock-daemon.ts'], { cwd: root, env, stdio: 'inherit' })
const kill = () => {
  if (mock.exitCode === null) mock.kill('SIGTERM')
}
process.on('exit', kill)
process.on('SIGINT', () => process.exit(1))

await new Promise((r) => setTimeout(r, 900))
const app = spawn(bin('electron'), ['.'], { cwd: root, env, stdio: 'inherit' })
const code = await new Promise((r) => app.on('exit', r))
kill()
process.exit(code ?? 0)
