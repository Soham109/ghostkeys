// Runs the mock daemon and the app together. The app is told not to spawn the real daemon.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const bin = (name) => new URL(`../node_modules/.bin/${name}`, import.meta.url).pathname
// One session token shared by the mock and the app, like the app does with the real daemon.
const env = { ...process.env, GK_MOCK: '1', GHOSTKEYS_TOKEN: randomBytes(32).toString('hex') }
const children = []

const run = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env })
  children.push(child)
  child.on('exit', () => shutdown())
  return child
}

let down = false
function shutdown() {
  if (down) return
  down = true
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run(bin('tsx'), ['scripts/mock-daemon.ts'])
setTimeout(() => run(bin('electron-vite'), ['dev']), 400)
