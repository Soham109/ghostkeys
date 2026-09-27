// End-to-end release scenario: drives a simulated ghostkeysd through @ghostkeys/sdk.
//
// Safe next to the user's running app: the daemon it starts uses --simulate-sensors --no-hardware-sessions
// --dry-run, a fresh temp --config-dir and a private port. No sensor, mic, camera or speaker is opened and no
// action executes.
//
// Usage (from the repo root, after `swift build --scratch-path .build-release-qa` in daemon/ and
// `pnpm build` in packages/sdk):
//   node tests/e2e/sdk_scenario.mjs [--binary daemon/.build-release-qa/debug/ghostkeysd] [--port 47962] [--json out.json]
// Exit status 0 when every step passed.

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const sdkDir = join(repo, 'packages/sdk')
const sdk = await import(pathToFileURL(join(sdkDir, 'dist/index.js')).href)
const WS = createRequire(join(sdkDir, 'package.json'))('ws')
const { GhostkeysClient, ConfigConflictError } = sdk

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : dflt
}
const binary = resolve(repo, arg('--binary', 'daemon/.build-release-qa/debug/ghostkeysd'))
const port = Number(arg('--port', '47962'))
const jsonOut = arg('--json', null)
if (port === 47823) throw new Error('47823 is the app daemon port; use a spare one')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const findings = []
function record(step, ok, detail = '') {
  results.push({ step, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`)
}
async function step(name, fn) {
  try {
    const detail = await fn()
    record(name, true, typeof detail === 'string' ? detail : '')
  } catch (e) {
    record(name, false, e?.message ?? String(e))
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// ---------------------------------------------------------------- daemon
const configDir = mkdtempSync(join(tmpdir(), 'gk-release-qa-'))
const daemonArgs = ['--simulate-sensors', '--no-hardware-sessions', '--dry-run', '--verbose',
  '--config-dir', configDir, '--port', String(port), '--parent-pid', String(process.pid)]
const proc = spawn(binary, daemonArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
const stderr = []
proc.stderr.setEncoding('utf8').on('data', (d) => stderr.push(...d.split('\n')))
proc.stdout.setEncoding('utf8').on('data', (d) => stderr.push(...d.split('\n')))
{
  const deadline = Date.now() + 15000
  while (!stderr.some((l) => l.includes(`listening on ws://127.0.0.1:${port}/`))) {
    if (proc.exitCode !== null) throw new Error(`daemon exited ${proc.exitCode}\n${stderr.join('\n')}`)
    if (Date.now() > deadline) throw new Error(`daemon did not start\n${stderr.join('\n')}`)
    await sleep(50)
  }
}
const token = readFileSync(join(configDir, 'token'), 'utf8').trim()
const url = `ws://127.0.0.1:${port}/`

// A raw observer socket: sees every broadcast frame unfiltered by the SDK's schemas.
const raw = []
const observer = new WS(url, { headers: { 'X-Ghostkeys-Token': token } })
observer.on('message', (d) => raw.push(JSON.parse(d.toString())))
await new Promise((r, j) => { observer.once('open', r); observer.once('error', j) })
observer.send(JSON.stringify({ type: 'subscribe', streams: ['taps', 'air'] }))

// Frames the SDK refused (unknown type or failed schema), by type.
const dropped = []
const newClient = (extra = {}) => new GhostkeysClient({ url, token, webSocket: WS, reconnect: false, ...extra })
const client = newClient()
client.on('protocolError', (e) => { try { dropped.push(JSON.parse(e.raw)) } catch { dropped.push({ raw: e.raw }) } })
const seen = [] // everything the SDK delivered, in order
for (const t of ['gesture', 'action', 'tap', 'rejected', 'calibration', 'session', 'status', 'error', 'air', 'config']) {
  client.on(t, (m) => seen.push(m))
}

/** Waits for a frame on the SDK client (delivered or dropped) or the observer that matches. */
async function waitFrame(pred, what, timeoutMs = 5000, from = 'any', mark = null) {
  const deadline = Date.now() + timeoutMs
  const startSeen = mark?.s ?? seen.length, startDropped = mark?.d ?? dropped.length, startRaw = mark?.r ?? raw.length
  while (Date.now() < deadline) {
    const pools = []
    if (from !== 'raw') pools.push(seen.slice(startSeen), dropped.slice(startDropped))
    if (from !== 'sdk') pools.push(raw.slice(startRaw))
    for (const p of pools) { const m = p.find(pred); if (m) return m }
    await sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}
const marks = () => ({ s: seen.length, d: dropped.length, r: raw.length })
const since = (m) => ({ seen: seen.slice(m.s), dropped: dropped.slice(m.d), raw: raw.slice(m.r) })

// ---------------------------------------------------------------- scenario
let hello
await step('auth: wrong token is rejected', async () => {
  const bad = newClient({ token: 'x'.repeat(64) })
  let rejected = false
  try { await bad.connect() } catch { rejected = true }
  bad.disconnect()
  assert(rejected, 'a wrong token connected')
})
await step('auth: connect with token, hello validates', async () => {
  hello = await client.connect()
  client.subscribe(['taps'])
  await sleep(300)
  return `version ${hello.version}, sensors ${JSON.stringify(hello.sensors)}`
})

let cfg, rev, zones
await step('config_get', async () => {
  ;({ config: cfg, revision: rev } = await client.getConfig())
  zones = cfg.zones.map((z) => z.id)
  assert(zones.length >= 2, `need 2+ zones, got ${zones}`)
  return `${zones.length} zones, ${cfg.bindings.length} bindings`
})

// Calibration with synthetic live spikes.
const TARGET = 6
const calZones = zones.slice(0, 3)
let done
await step(`calibration: start + ${TARGET} sim taps x ${calZones.length} zones + finish`, async () => {
  const flow = await client.startCalibration(calZones, TARGET, { timeoutMs: 20000 })
  for (const z of calZones) {
    const captured = flow.captureZone(z, 30000)
    await sleep(150)
    for (let i = 0; i < TARGET + 2; i++) {
      client.send({ type: 'sim_spike', live: true })
      await sleep(450)
    }
    const r = await captured
    assert(r.count >= TARGET, `${z}: ${r.count}/${TARGET}`)
  }
  const m = marks()
  done = await flow.finish()
  const rawDone = await waitFrame((f) => f.type === 'calibration' && f.phase === 'done', 'raw done', 15000, 'raw', m)
  done.__raw = rawDone
  if (rawDone.recommendation && !('recommendation' in done)) {
    findings.push('SDK strips calibration done.recommendation and done.peaks (zod z.object drops unknown keys)')
  }
  return `overall ${done.overall}, recommendation ${JSON.stringify(rawDone.recommendation ?? null)}`
})

await step('calibration_apply_recommendation', async () => {
  client.send({ type: 'calibration_apply_recommendation' })
  const f = await waitFrame((x) => x.type === 'calibration' && ['recommendation_applied', 'failed'].includes(x.phase) || x.type === 'error', 'recommendation_applied', 15000)
  assert(f.type !== 'error', `error: ${f.message}`)
  assert(f.phase === 'recommendation_applied', JSON.stringify(f))
  if (dropped.some((d) => d.phase === 'recommendation_applied')) findings.push('SDK drops calibration phase "recommendation_applied" as a protocol error')
  return `disabled ${JSON.stringify(f.disabled)}, keep ${JSON.stringify(f.keep)}`
})

await step('calibration_apply_merge', async () => {
  const pair = done?.__raw?.recommendation?.merge?.[0] ?? calZones.slice(0, 2)
  client.send({ type: 'calibration_apply_merge', zones: pair, name: 'QA merged' })
  const f = await waitFrame((x) => (x.type === 'calibration' && ['merge_applied', 'failed'].includes(x.phase)) || x.type === 'error', 'merge_applied', 15000)
  assert(f.type !== 'error', `error: ${f.message}`)
  assert(f.phase === 'merge_applied', JSON.stringify(f))
  if (dropped.some((d) => d.phase === 'merge_applied')) findings.push('SDK drops calibration phase "merge_applied" as a protocol error')
  return `merged ${JSON.stringify(pair)} into ${f.zone}`
})

// Bindings for tap / double / sequence.
let A, B
await step('binding create: tap, double, sequence (config_set with ifRevision)', async () => {
  ;({ config: cfg, revision: rev } = await client.getConfig())
  const enabled = cfg.zones.filter((z) => z.enabled !== false).map((z) => z.id)
  A = enabled.find((z) => z !== 'air') ?? cfg.zones[0].id
  B = enabled.find((z) => z !== A && z !== 'air') ?? cfg.zones[1].id
  const b = (id, gesture, extra, action, label) => ({ id, enabled: true, gesture, zone: A, zones: null, modifiers: [], app: '*', action, label, ...extra })
  cfg.bindings = [
    b('qa-tap', 'tap', { zone: B }, { kind: 'volume', step: 6 }, 'QA tap'),
    ...cfg.zones.map((z) => b(`qa-double-${z.id}`, 'double', { zone: z.id }, { kind: 'mute' }, `QA double ${z.id}`)),
    b('qa-seq', 'sequence', { zone: null, zones: [A, B] }, { kind: 'media', command: 'playpause' }, 'QA sequence')
  ]
  const saved = await client.setConfig(cfg, { ifRevision: rev })
  rev = saved.revision
  const back = await client.getConfig()
  assert(back.config.bindings.length === cfg.bindings.length, `saved ${back.config.bindings.length} of ${cfg.bindings.length} bindings`)
  const onDisk = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
  assert(onDisk.bindings.some((x) => x.id === 'qa-seq'), 'config.json on disk lacks the new binding')
  return `A=${A} B=${B}`
})

async function simTapExpect(zonesToTap, bindingId, gap = 120, live = false) {
  const m = marks()
  for (const z of zonesToTap) { client.send(live ? { type: 'sim_spike', live: true } : { type: 'sim_tap', zone: z }); await sleep(gap) }
  const act = await waitFrame((x) => x.type === 'action' && (bindingId instanceof RegExp ? bindingId.test(x.bindingId ?? '') : x.bindingId === bindingId), `action for ${bindingId}`, 3000, 'any', m)
    .catch((e) => {
      const f = since(m)
      const brief = [...f.raw, ...f.dropped].map((x) => `${x.type}${x.gesture ? ':' + x.gesture : ''}${x.zone ? '@' + x.zone : ''}${x.bindingId ? '#' + x.bindingId : ''}${x.error ? '!' + x.error : ''}${x.reason ? '~' + x.reason : ''}${typeof x.confidence === 'number' ? '%' + x.confidence.toFixed(2) : ''}${x.message ? '!' + x.message : ''}`)
      throw new Error(`${e.message}; frames: ${brief.join(' ') || 'none'}`)
    })
  await sleep(500)
  return { act, frames: since(m) }
}
await step('sim_tap fires tap binding (dry-run action ok)', async () => {
  const { act } = await simTapExpect([B], 'qa-tap')
  assert(act.ok === true, JSON.stringify(act))
  await sleep(400)
})
await step('two live sim spikes fire a double binding (through the gesture grammar)', async () => {
  // sim_tap emits a single "tap" gesture directly, bypassing the grammar, so double/triple/sequence need live spikes.
  // The simulated daemon still reads this Mac's real keyboard / trackpad idle time, so live spikes are rejected
  // (reason typing / trackpad) while someone uses the machine. Retry a few times before calling it a failure.
  let act, frames, lastErr
  for (let attempt = 1; attempt <= 8 && !act; attempt++) {
    try { ({ act, frames } = await simTapExpect([A, A], /^qa-double-/, 180, true)) } catch (e) { lastErr = e; await sleep(1500) }
  }
  if (!act) throw lastErr
  assert(act.ok === true, JSON.stringify(act))
  const g = frames.raw.filter((x) => x.type === 'gesture').map((x) => `${x.gesture}@${x.zone}`)
  await sleep(400)
  return `gestures ${JSON.stringify(g)}`
})
await step('tap frame fields survive the SDK', async () => {
  const sdkTap = seen.filter((x) => x.type === 'tap').at(-1)
  const rawTap = raw.filter((x) => x.type === 'tap').at(-1)
  assert(sdkTap && rawTap, 'no tap frames seen')
  const lost = Object.keys(rawTap).filter((k) => !(k in sdkTap))
  if (lost.length) findings.push(`SDK strips tap fields: ${lost.join(', ')}`)
  return lost.length ? `SDK drops ${lost.join(', ')}` : 'all fields kept'
})

// Feedback loop.
await step('feedback_missed with a sim spike', async () => {
  await sleep(2100)
  client.send({ type: 'sim_spike', ago: 2.0 })
  await sleep(100)
  client.send({ type: 'feedback_missed', zone: A })
  const f = await waitFrame((x) => (x.type === 'feedback' && x.kind === 'missed') || x.type === 'error', 'feedback missed', 8000)
  assert(f.type === 'feedback', `error: ${f.message}`)
  assert(f.diagnostic && existsSync(f.diagnostic), `diagnostic file missing: ${f.diagnostic}`)
  assert(f.diagnostic.startsWith(configDir), 'diagnostic written outside the config dir')
  if (dropped.some((d) => d.type === 'feedback')) findings.push('SDK drops "feedback" frames (no schema)')
  return `found ${f.found}, retrained ${f.retrained}${f.reason ? `, reason ${f.reason}` : ''}`
})
await step('feedback rate limit (second within 2 s is refused)', async () => {
  client.send({ type: 'feedback_false' })
  const f = await waitFrame((x) => x.type === 'error' || x.type === 'feedback', 'feedback limiter', 3000)
  assert(f.type === 'error' && /at most one every 2 s/.test(f.message), JSON.stringify(f))
})
await step('feedback_false after a sim tap', async () => {
  await sleep(2100)
  client.send({ type: 'sim_tap', zone: A, strengthScale: 0.3 })
  await sleep(900)
  client.send({ type: 'feedback_false' })
  const f = await waitFrame((x) => (x.type === 'feedback' && x.kind === 'false') || x.type === 'error', 'feedback false', 8000)
  assert(f.type === 'feedback', `error: ${f.message}`)
  return `zone ${f.zone}, retrained ${f.retrained}${f.reason ? `, reason ${f.reason}` : ''}`
})

// Approvals.
const shell = { kind: 'shell', command: 'echo ghostkeys-release-qa' }
let hash
await step('approvals: unapproved shell action is refused', async () => {
  await sleep(600)
  const r = await client.testAction(shell)
  assert(r.ok === false, JSON.stringify(r))
  return r.error
})
await step('approvals: approve_action then run with approvedHash (dry-run ok)', async () => {
  await sleep(600)
  ;({ hash } = await client.approveAction(shell))
  assert(/^[0-9a-f]{64}$/.test(hash), hash)
  const approved = JSON.parse(readFileSync(join(configDir, 'approved.json'), 'utf8'))
  assert(JSON.stringify(approved).includes(hash), 'hash not in approved.json')
  const r = await client.testAction({ ...shell, approvedHash: hash })
  assert(r.ok === true, JSON.stringify(r))
})
await step('approvals: changed command invalidates the hash', async () => {
  await sleep(600)
  const r = await client.testAction({ kind: 'shell', command: 'echo changed', approvedHash: hash })
  assert(r.ok === false, JSON.stringify(r))
  return r.error
})
await step('approvals: dangerous command refused even when approved', async () => {
  await sleep(600)
  const bad = { kind: 'shell', command: 'sudo ls' }
  let h
  try { ({ hash: h } = await client.approveAction(bad)) } catch (e) { return `approve refused: ${e.message}` }
  const r = await client.testAction({ ...bad, approvedHash: h })
  assert(r.ok === false, `sudo ran: ${JSON.stringify(r)}`)
  return r.error
})
await step('approvals: revoke_action', async () => {
  await sleep(600)
  const r = await client.revokeAction(hash)
  assert(r.found === true, JSON.stringify(r))
  const t = await client.testAction({ ...shell, approvedHash: hash })
  assert(t.ok === false, 'revoked action still ran')
})

// Sessions (simulated).
await step('sound session start/stop (simulated)', async () => {
  const s = await client.startSoundSession(5)
  assert(s.active && s.simulated === true, JSON.stringify(s))
  await sleep(300)
  const e = await client.stopSoundSession()
  assert(!e.active, JSON.stringify(e))
})
await step('air session start/stop (simulated) + sim_air', async () => {
  const s = await client.startAirSession(5, 'front')
  assert(s.active && s.simulated === true, JSON.stringify(s))
  client.send({ type: 'sim_air', phase: 'began', dx: 0.05, dy: 0 })
  await sleep(300)
  const e = await client.stopAirSession()
  assert(!e.active, JSON.stringify(e))
})
await step('sonar session refused while settings.sonar is off', async () => {
  const m = marks()
  client.send({ type: 'sonar_session_start', seconds: 5 })
  await sleep(1000)
  const f = [...since(m).raw, ...since(m).dropped, ...since(m).seen]
  const on = f.find((x) => x.type === 'session' && x.kind === 'sonar' && x.active)
  assert(!on, `sonar session started with sonar disabled: ${JSON.stringify(on)}`)
  const why = f.find((x) => x.type === 'error' || (x.type === 'session' && x.kind === 'sonar'))
  return why ? JSON.stringify(why).slice(0, 160) : 'no reply'
})
await step('sonar session start/stop (simulated) + sim_sonar', async () => {
  ;({ config: cfg, revision: rev } = await client.getConfig())
  cfg.settings.sonar = { ...(cfg.settings.sonar ?? {}), enabled: true, sessionSeconds: 30, autoApps: [] }
  ;({ revision: rev } = await client.setConfig(cfg, { ifRevision: rev }))
  const m = marks()
  client.send({ type: 'sonar_session_start', seconds: 5 })
  const s = await waitFrame((x) => (x.type === 'session' && x.kind === 'sonar') || x.type === 'error', 'sonar session', 4000)
  assert(s.type === 'session' && s.active && s.simulated === true, JSON.stringify(s))
  client.send({ type: 'sim_sonar', gesture: 'push', side: 'left' })
  client.send({ type: 'sim_sonar', air: { gesture: 'hover_level', phase: 'changed', displacementMm: 40 } })
  await sleep(600)
  client.send({ type: 'sonar_session_stop' })
  const e = await waitFrame((x) => x.type === 'session' && x.kind === 'sonar' && !x.active, 'sonar stop', 4000)
  if (since(m).dropped.some((x) => x.type === 'session' && x.kind === 'sonar')) findings.push('SDK drops session frames with kind "sonar" (schema allows only sound|air)')
  const air = since(m).raw.filter((x) => x.type === 'air').length
  return `stop reason ${e.reason}, ${air} sonar air frames`
})

// Pause is honoured.
await step('pause blocks actions, resume restores', async () => {
  const st = await client.pause()
  assert(st.paused && st.pausedReason === 'user', JSON.stringify(st))
  await sleep(400)
  client.send({ type: 'sim_tap', zone: B })
  const a = await waitFrame((x) => x.type === 'action' && x.bindingId === 'qa-tap', 'paused action', 3000).catch(() => null)
  assert(!a || a.ok === false, `action ran while paused: ${JSON.stringify(a)}`)
  const r = await client.resume()
  assert(!r.paused && r.pausedReason === null, JSON.stringify(r))
  return a ? `action reported ok:false (${a.error})` : 'no action emitted'
})

// Rate limiter: 3 clients x 2 test_action in one burst > 5/s global.
await step('rate limiter auto-pause (pausedReason rate_limit) and resume', async () => {
  await sleep(1200)
  const extra = [newClient(), newClient(), newClient()]
  await Promise.all(extra.map((c) => c.connect()))
  const paused = waitFrame((x) => x.type === 'status' && x.paused && x.pausedReason === 'rate_limit', 'rate_limit pause', 4000)
  const act = { kind: 'volume', step: 1 }
  for (const c of extra) { c.send({ type: 'test_action', action: act }); c.send({ type: 'test_action', action: act }) }
  const st = await paused
  const r = await client.resume()
  extra.forEach((c) => c.disconnect())
  assert(!r.paused, JSON.stringify(r))
  return `paused ${st.pausedReason}, resumed`
})

await step('diagnostics_export', async () => {
  client.send({ type: 'diagnostics_export' })
  const f = await waitFrame((x) => x.type === 'diagnostics' || x.type === 'error', 'diagnostics', 5000)
  assert(f.type === 'diagnostics', `error: ${f.message}`)
  assert(existsSync(f.path) && f.path.startsWith(configDir), f.path)
  assert(f.samples > 0, `samples ${f.samples}`)
  if (dropped.some((d) => d.type === 'diagnostics')) findings.push('SDK drops "diagnostics" frames (no schema)')
  client.send({ type: 'diagnostics_export' })
  const g = await waitFrame((x) => x.type === 'error' || x.type === 'diagnostics', 'diagnostics limiter', 3000)
  assert(g.type === 'error', 'second export within 5 s was not refused')
  return `${f.samples} samples, ${f.seconds} s`
})

await step('config round trip byte-stable (get -> set -> get)', async () => {
  const a = await client.getConfig()
  const s = await client.setConfig(a.config, { ifRevision: a.revision })
  const b = await client.getConfig()
  assert(a.revision === s.revision && s.revision === b.revision, `${a.revision} ${s.revision} ${b.revision}`)
})

await step('SDK: setConfig with ifRevision on a fresh connection (Raycast pattern)', async () => {
  const { config, revision } = await client.getConfig()
  const c2 = newClient()
  await c2.connect()
  try {
    await c2.setConfig(config, { ifRevision: revision })
    return 'ok'
  } catch (e) {
    if (e instanceof ConfigConflictError) {
      findings.push('SDK: connect() resolves on hello before the greeting config, so setConfig(ifRevision) right after connect throws ConfigConflictError (breaks Raycast Bind Preset / Apply Layout)')
    }
    throw e
  } finally { c2.disconnect() }
})

await step('SDK dropped no frames except known gaps', async () => {
  const types = [...new Set(dropped.map((d) => `${d.type}${d.phase ? ':' + d.phase : ''}${d.kind ? ':' + d.kind : ''}`))]
  return types.length ? `dropped: ${types.join(', ')}` : 'none'
})

// ---------------------------------------------------------------- shutdown
client.disconnect()
observer.close()
await step('daemon exits cleanly on SIGTERM', async () => {
  proc.kill('SIGTERM')
  const code = await Promise.race([new Promise((r) => proc.once('exit', (c) => r(c))), sleep(6000).then(() => 'timeout')])
  assert(code === 0, `exit ${code}`)
})
const errLines = stderr.filter((l) => /error|fatal|crash/i.test(l) && !/sendError|"error"/.test(l))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} steps passed`)
if (findings.length) console.log('Findings:\n' + [...new Set(findings)].map((f) => '  - ' + f).join('\n'))
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ dropped: dropped.slice(0, 40), zonesAfter: cfg?.zones, results, findings: [...new Set(findings)], daemonErrorLines: errLines.slice(0, 50), configDir }, null, 2))
if (proc.exitCode === null) proc.kill('SIGKILL')
if (!failed.length) rmSync(configDir, { recursive: true, force: true })
process.exit(failed.length ? 1 : 0)
