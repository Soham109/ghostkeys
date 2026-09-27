// 60-second sonar check against the running Ghostkeys daemon (read only: it changes no setting).
// Usage, from the repo root, with the Ghostkeys app running and Sonar turned on:
//   node docs/review/sonar-check.mjs            (60 s)
//   node docs/review/sonar-check.mjs 90 out.jsonl  (90 s, and keep every message in out.jsonl)
// Prints one line a second and every sonar gesture. See docs/review/SONAR_REPORT.md.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require(path.join(path.dirname(new URL(import.meta.url).pathname), '../../packages/sdk/node_modules/ws'))

const seconds = Number(process.argv[2] ?? 60)
const keep = process.argv[3] ? fs.createWriteStream(process.argv[3]) : null
const port = Number(process.env.GHOSTKEYS_PORT ?? 47823)
const dirs = [process.env.GHOSTKEYS_CONFIG_DIR, path.join(os.homedir(), 'Library/Application Support/Ghostkeys/daemon'),
  path.join(os.homedir(), 'Library/Application Support/Ghostkeys')].filter(Boolean)
const token = process.env.GHOSTKEYS_TOKEN ?? dirs.map((d) => { try { return fs.readFileSync(path.join(d, 'token'), 'utf8').trim() } catch { return null } }).find(Boolean)
if (!token) { console.log('No daemon token found: is the Ghostkeys app running?'); process.exit(1) }

const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { 'X-Ghostkeys-Token': token } })
let win = []
let gestures = 0
const start = Date.now()
const f = (v, d = 0) => (typeof v === 'number' ? v.toFixed(d) : '?')
ws.on('error', (e) => { console.log('Could not reach the daemon:', e.message); process.exit(1) })
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', streams: ['debug', 'air'] }))
  console.log(`Listening for ${seconds} s. Hold a hand 10 to 20 cm above the keyboard, then: push down, pull up, sweep across, slowly raise and lower.`)
})
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  keep?.write(JSON.stringify(m) + '\n')
  const t = ((Date.now() - start) / 1000).toFixed(1).padStart(5)
  if (m.type === 'sonar_debug') {
    win.push(m)
    if (win.length >= 10) {
      const last = win[win.length - 1], g = last.gates ?? {}, i = last.input ?? {}
      const ready = win.filter((x) => x.gates?.ready).length
      const over = (s) => Math.max(...win.map((x) => x[s]?.overFloorDb ?? -99))
      const moved = (s) => win.reduce((a, x) => a + Math.abs(x[s]?.pathDeltaMm ?? 0), 0)
      console.log(`${t}s ready ${ready}/10  volume ${Math.round((i.outputVolume ?? 0) * 100)}%  pilot L ${f(last.left?.pilotDbfs)} R ${f(last.right?.pilotDbfs)} dBFS` +
        `  echo over noise L ${f(over('left'))} R ${f(over('right'))} dB  tracked L ${f(moved('left'))} R ${f(moved('right'))} mm` +
        `${g.interference ? '  interference ' + g.interferenceReason : ''}${g.toneProblem ? '  tones: ' + g.toneProblem : ''}${g.volumeHint ? '  (' + g.volumeHint + ')' : ''}`)
      win = []
    }
  } else if (m.type === 'gesture' && ['push', 'pull', 'sweep_left', 'sweep_right'].includes(m.gesture)) {
    gestures++
    console.log(`${t}s  >>> ${m.gesture}${m.side ? ' (' + m.side + ')' : ''}`)
  } else if (m.type === 'air' && m.source === 'sonar' && (m.phase === 'began' || m.phase === 'ended')) {
    if (m.phase === 'began') gestures++
    console.log(`${t}s  >>> ${m.gesture} ${m.phase}${m.side ? ' (' + m.side + ')' : ''}${m.phase === 'ended' ? ', moved ' + f(m.displacementMm) + ' mm' : ''}`)
  }
})
setTimeout(() => {
  console.log(`Done: ${gestures} sonar gesture(s) seen.`)
  keep?.end()
  ws.close()
  process.exit(0)
}, seconds * 1000)
