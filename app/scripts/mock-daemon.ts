/**
 * Mock ghostkeysd. Implements docs/PROTOCOL.md with simulated sensors, random taps and gestures,
 * a calibration flow and config round-trip. For development and screenshots only.
 *
 *   GK_PORT          port (default 47823)
 *   GK_FAMILY        macbook-pro-14 | macbook-pro-16 | macbook-air-13 | macbook-air-15
 *   GK_ACCESSIBILITY 1 to start with Accessibility already granted
 *   GK_CALIBRATED    0 to start uncalibrated
 *   GK_RATE          fast | normal | off (random events)
 *   GK_FAST          1 to speed up calibration (for scripted screenshots)
 *   GHOSTKEYS_TOKEN  session token; when set, clients must send it as X-Ghostkeys-Token
 *
 * Like the real daemon, it rejects any handshake with an Origin header (browsers always send one)
 * and only runs shell, AppleScript, Shortcut and open actions after approve_action.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import { approvalPayload, riskyParts } from '../src/shared/approval.ts'
import { defaultConfig } from '../src/shared/defaults.ts'
import { describeAction } from '../src/shared/actions.ts'
import type { Action } from '../src/shared/protocol.ts'
import {
  DEFAULT_PORT,
  ZONELESS_GESTURES,
  type AppMessage,
  type Config,
  type DaemonMessage,
  type DeviceFamily,
  type GestureKind,
  type Modifier,
  type RejectReason,
  type Stream,
  type Zone
} from '../src/shared/protocol.ts'

const port = Number(process.env.GK_PORT ?? DEFAULT_PORT)
const family = (process.env.GK_FAMILY ?? 'macbook-pro-14') as DeviceFamily
const rate = process.env.GK_RATE ?? 'normal'
const fast = process.env.GK_FAST === '1'

const MODEL: Record<DeviceFamily, { model: string; chip: string }> = {
  'macbook-pro-14': { model: 'Mac17,8', chip: 'Apple M5 Pro' },
  'macbook-pro-16': { model: 'Mac17,9', chip: 'Apple M5 Max' },
  'macbook-air-13': { model: 'Mac17,3', chip: 'Apple M5' },
  'macbook-air-15': { model: 'Mac17,4', chip: 'Apple M5' }
}

const start = performance.now()
const now = (): number => Math.round((performance.now() - start) * 10) / 10

let config: Config = defaultConfig(family)
let paused = false
let pausedReason: 'user' | 'rate_limit' = 'user'
let calibrated = process.env.GK_CALIBRATED !== '0'
let accessibility = process.env.GK_ACCESSIBILITY === '1'

const subs = new Map<WebSocket, Set<Stream>>()
const token = process.env.GHOSTKEYS_TOKEN ?? ''
const approved = new Set<string>()
/** Like the daemon: SHA-256 over the action without approvedHash, label and delayMs (canonical key order). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}
const hashOf = (a: Parameters<typeof approvalPayload>[0]): string => createHash('sha256').update(canonical(approvalPayload(a))).digest('hex')
const isApproved = (a: Action): boolean => riskyParts(a).every((p) => !!p.approvedHash && approved.has(p.approvedHash) && p.approvedHash === hashOf(p))
const catalog = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')) as unknown

function tokenOk(got: string | string[] | undefined): boolean {
  if (!token) return true
  if (typeof got !== 'string') return false
  const a = Buffer.from(got)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

const MAX_CLIENTS = 4
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port,
  verifyClient: (info, done) => {
    if (info.req.headers.origin) return done(false, 403, 'Origin not allowed')
    if (!tokenOk(info.req.headers['x-ghostkeys-token'])) return done(false, 401, 'Bad token')
    if (subs.size >= MAX_CLIENTS) return done(false, 503, 'Too many clients')
    done(true)
  }
})

function send(ws: WebSocket, msg: DaemonMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}
function broadcast(msg: DaemonMessage, stream?: Stream): void {
  for (const [ws, set] of subs) if (!stream || set.has(stream)) send(ws, msg)
}
const hello = (): DaemonMessage => ({
  type: 'hello',
  version: '0.1.0-mock',
  device: { ...MODEL[family], family },
  sensors: { imu: true, gyro: true, lid: true, light: true, sound: true, camera: true },
  permissions: { accessibility, microphone: 'authorized', camera: 'not_determined' }
})
const status = (): DaemonMessage => ({
  type: 'status',
  paused,
  pausedReason: paused ? pausedReason : null,
  calibrated,
  zones: config.zones.map((z) => z.id),
  imuHz: 797,
  detector: { noiseFloorMg: 1.4 + Math.random() * 0.3, thresholdMg: 17.5, level: 1.6 + tapEnergy * 40 }
})

// ---------------------------------------------------------------- sensor simulation

let tapEnergy = 0
let tiltTarget = 0
let tilt = 0
const lidAngle = 112
let lidOffset = 0
const light = 0.46
let lightCover = 0
let lastLid = -1
let lastLight = -1
const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const gauss = (): number => (Math.random() + Math.random() + Math.random() - 1.5) * 0.6

setInterval(() => {
  const t = now()
  const s = t / 1000
  tapEnergy *= 0.82
  tilt += (tiltTarget - tilt) * 0.12
  lidOffset *= 0.9
  lightCover *= 0.93
  const breathe = Math.sin(s * 0.7) * 0.004
  const a: [number, number, number] = [
    Math.sin(tilt) * 1 + gauss() * 0.004 + breathe + tapEnergy * gauss() * 0.8,
    -0.02 + gauss() * 0.004 + tapEnergy * gauss() * 0.6,
    -Math.cos(tilt) * 0.999 + gauss() * 0.003 - tapEnergy * 0.9
  ]
  const g: [number, number, number] = [
    gauss() * 0.3 + tapEnergy * gauss() * 40,
    gauss() * 0.3 + (tiltTarget - tilt) * 180,
    gauss() * 0.3 + tapEnergy * gauss() * 20
  ]
  broadcast({ type: 'imu', t, a, g }, 'imu')

  const angle = Math.round((lidAngle + Math.sin(s * 0.15) * 1.5 - lidOffset) * 2) / 2
  if (angle !== lastLid) {
    lastLid = angle
    broadcast({ type: 'lid', t, angle }, 'lid')
  }
  const lv = Math.round(Math.max(0, Math.min(1, (light + Math.sin(s * 0.3) * 0.03) * (1 - lightCover))) * 1000) / 1000
  if (Math.abs(lv - lastLight) > 0.002) {
    lastLight = lv
    broadcast({ type: 'light', t, value: lv }, 'light')
  }
}, 1000 / 60)

// ---------------------------------------------------------------- taps and gestures

function pointIn(z: Zone): { x: number; y: number } {
  return { x: z.rect.x + z.rect.w * rand(0.25, 0.75), y: z.rect.y + z.rect.h * rand(0.25, 0.75) }
}

function emitTap(zone: Zone): void {
  tapEnergy = rand(0.4, 1)
  if (paused) {
    broadcast({ type: 'rejected', t: now(), reason: 'paused' })
    return
  }
  const { x, y } = pointIn(zone)
  const tapType = sessions.sound.timer ? (Math.random() < 0.3 ? 'knuckle' : 'fingertip') : undefined
  broadcast({ type: 'tap', t: now(), zone: zone.id, confidence: rand(0.82, 0.99), x, y, strength: rand(0.3, 0.9), source: 'imu', ...(tapType ? { tapType } : {}) })
}

function emitGesture(gesture: GestureKind, zone: string | null, zones: string[] | null, modifiers: Modifier[] = []): void {
  if (paused) return
  const app = Math.random() < 0.3 ? 'com.microsoft.Excel' : 'com.apple.Safari'
  broadcast({ type: 'gesture', t: now(), gesture, zone, zones, modifiers, confidence: rand(0.84, 0.99), app })
  const candidates = config.bindings.filter(
    (b) =>
      b.enabled &&
      b.gesture === gesture &&
      (ZONELESS_GESTURES.includes(gesture) ||
        (gesture === 'sequence' ? JSON.stringify(b.zones) === JSON.stringify(zones) : b.zone === zone)) &&
      (b.app === '*' || b.app === app)
  )
  const binding = candidates.find((b) => b.app === app) ?? candidates.find((b) => b.app === '*')
  if (binding) {
    const ok = isApproved(binding.action)
    setTimeout(
      () =>
        broadcast({
          type: 'action',
          t: now(),
          bindingId: binding.id,
          label: binding.label || describeAction(binding.action),
          ok,
          error: ok ? null : 'Not approved in the app'
        }),
      40
    )
  }
}

const REASONS: RejectReason[] = ['typing', 'typing', 'typing', 'trackpad', 'trackpad', 'motion', 'low_confidence', 'burst']

function randomEvent(): void {
  if (calibrating) return
  const zones = config.zones
  const r = Math.random()
  const bound = config.bindings.filter((b) => b.enabled && b.zone && ['tap', 'double', 'triple'].includes(b.gesture))
  if (r < 0.4 && bound.length) {
    // Mostly act out gestures the user has bound, so the feed shows real actions.
    const b = bound[Math.floor(Math.random() * bound.length)]!
    const zone = zones.find((z) => z.id === b.zone)
    if (zone) {
      const n = b.gesture === 'tap' ? 1 : b.gesture === 'double' ? 2 : 3
      for (let i = 0; i < n; i++) setTimeout(() => emitTap(zone), i * 180)
      setTimeout(() => emitGesture(b.gesture, zone.id, [zone.id], b.modifiers), n * 180 + 350)
      return
    }
  }
  if (r < 0.62 && zones.length) {
    const zone = zones[Math.floor(Math.random() * zones.length)]!
    const kind: GestureKind = Math.random() < 0.55 ? 'tap' : Math.random() < 0.8 ? 'double' : 'triple'
    const n = kind === 'tap' ? 1 : kind === 'double' ? 2 : 3
    for (let i = 0; i < n; i++) setTimeout(() => emitTap(zone), i * 180)
    setTimeout(() => emitGesture(kind, zone.id, [zone.id], kind === 'triple' ? ['shift'] : []), n * 180 + 350)
  } else if (r < 0.66 && zones.length > 1) {
    const [a, b] = [zones[0]!, zones[1]!]
    emitTap(a)
    setTimeout(() => emitTap(b), 240)
    setTimeout(() => emitGesture('sequence', null, [a.id, b.id]), 600)
  } else if (r < 0.88) {
    broadcast({ type: 'rejected', t: now(), reason: REASONS[Math.floor(Math.random() * REASONS.length)]! })
  } else {
    const g = (['cover', 'cover_hold', 'lid_nudge', 'tilt_left', 'tilt_right'] as const)[Math.floor(Math.random() * 5)]!
    if (g === 'cover' || g === 'cover_hold') lightCover = 0.95
    if (g === 'lid_nudge') lidOffset = 9
    if (g === 'tilt_left') {
      tiltTarget = -0.18
      setTimeout(() => (tiltTarget = 0), 500)
    }
    if (g === 'tilt_right') {
      tiltTarget = 0.18
      setTimeout(() => (tiltTarget = 0), 500)
    }
    setTimeout(() => emitGesture(g, null, null), 700)
  }
}

function scheduleRandom(): void {
  if (rate === 'off') return
  const [lo, hi] = rate === 'fast' ? [350, 900] : [1600, 4200]
  setTimeout(() => {
    randomEvent()
    scheduleRandom()
  }, rand(lo, hi))
}
scheduleRandom()

// ---------------------------------------------------------------- calibration

let calibrating = false
let calZones: string[] = []
let calTarget = 20
let calCounts: Record<string, number> = {}
let calTimer: ReturnType<typeof setInterval> | null = null

function stopCalTimer(): void {
  if (calTimer) clearInterval(calTimer)
  calTimer = null
}

function captureZone(zoneId: string): void {
  stopCalTimer()
  const zone = config.zones.find((z) => z.id === zoneId)
  if (!zone) {
    broadcast({ type: 'error', message: `Unknown zone ${zoneId}` })
    return
  }
  calCounts[zoneId] = calCounts[zoneId] ?? 0
  broadcast({ type: 'calibration', phase: 'capturing', zone: zoneId, count: calCounts[zoneId]!, target: calTarget })
  calTimer = setInterval(
    () => {
      const count = (calCounts[zoneId] ?? 0) + 1
      calCounts[zoneId] = count
      const { x, y } = pointIn(zone)
      tapEnergy = rand(0.4, 1)
      broadcast({ type: 'tap', t: now(), zone: zoneId, confidence: rand(0.6, 0.95), x, y, strength: rand(0.3, 0.9) })
      broadcast({ type: 'calibration', phase: 'capturing', zone: zoneId, count, target: calTarget })
      if (count >= calTarget) stopCalTimer()
    },
    fast ? 90 : rand(380, 520)
  )
}

function negatives(seconds: number): void {
  stopCalTimer()
  let left = seconds
  broadcast({ type: 'calibration', phase: 'negatives', secondsLeft: left })
  calTimer = setInterval(
    () => {
      left -= 1
      if (Math.random() < 0.5) broadcast({ type: 'rejected', t: now(), reason: Math.random() < 0.6 ? 'typing' : 'trackpad' })
      broadcast({ type: 'calibration', phase: 'negatives', secondsLeft: Math.max(0, left) })
      if (left <= 0) stopCalTimer()
    },
    fast ? 60 : 1000
  )
}

function finish(): void {
  stopCalTimer()
  broadcast({ type: 'calibration', phase: 'training' })
  const labels = [...calZones, 'none']
  const accuracy: Record<string, number> = {}
  const weak = calZones.length > 2 ? calZones[calZones.length - 2] : undefined
  const confusion = labels.map((row, i) => {
    const acc = row === 'none' ? 0.985 : row === weak ? 0.78 : rand(0.91, 0.99)
    if (row !== 'none') accuracy[row] = Math.round(acc * 1000) / 1000
    const total = row === 'none' ? 200 : calTarget * 5
    const correct = Math.round(total * acc)
    const cells = labels.map(() => 0)
    cells[i] = correct
    let rest = total - correct
    // Most errors go to a neighbour, a few to "none".
    const neighbour = labels.length > 1 ? (i + 1) % (labels.length - 1 || 1) : i
    while (rest > 0) {
      const j = Math.random() < 0.7 && neighbour !== i ? neighbour : labels.length - 1 === i ? 0 : labels.length - 1
      cells[j]! += 1
      rest -= 1
    }
    return cells
  })
  const overall =
    Math.round((Object.values(accuracy).reduce((s, v) => s + v, 0) / Math.max(1, Object.keys(accuracy).length)) * 1000) / 1000
  setTimeout(
    () => {
      calibrating = false
      calibrated = true
      broadcast({ type: 'calibration', phase: 'done', accuracy, overall, confusion, labels })
      broadcast(status())
    },
    fast ? 200 : 1600
  )
}

// ---------------------------------------------------------------- sound and camera sessions (simulated)

const sessions: Record<'sound' | 'air', { left: number; timer: ReturnType<typeof setInterval> | null }> = {
  sound: { left: 0, timer: null },
  air: { left: 0, timer: null }
}
function sessionMsg(kind: 'sound' | 'air', reason?: string): DaemonMessage {
  const s = sessions[kind]
  return { type: 'session', kind, active: !!s.timer, secondsLeft: s.left, simulated: true, ...(reason ? { reason } : {}), ...(s.timer ? { trigger: 'request' } : {}) }
}
function startSession(kind: 'sound' | 'air', seconds?: number): void {
  const s = sessions[kind]
  if (s.timer) clearInterval(s.timer)
  s.left = Math.max(1, Math.min(120, seconds ?? config.settings[kind === 'sound' ? 'sound' : 'camera']?.sessionSeconds ?? 30))
  s.timer = setInterval(() => {
    s.left -= 1
    if (kind === 'air') simulateAir()
    if (s.left <= 0) stopSession(kind, 'timeout')
    else broadcast(sessionMsg(kind))
  }, 1000)
  broadcast(sessionMsg(kind))
}
function stopSession(kind: 'sound' | 'air', reason: string): void {
  const s = sessions[kind]
  if (s.timer) clearInterval(s.timer)
  s.timer = null
  s.left = 0
  broadcast(sessionMsg(kind, reason))
}
let airPhase = 0
function simulateAir(): void {
  airPhase += 1
  const x = 0.5 + Math.sin(airPhase / 2) * 0.25
  const y = 0.45 + Math.cos(airPhase / 3) * 0.15
  broadcast({ type: 'air', t: now(), phase: airPhase % 4 === 0 ? 'began' : 'changed', gesture: 'pinch_hold', x, y, dx: 0.02, dy: 0, hand: 'right', confidence: 0.9 }, 'air')
  if (airPhase % 5 === 0) emitGesture('air_tap', 'air', ['air'])
}

// ---------------------------------------------------------------- messages

function handle(ws: WebSocket, msg: AppMessage): void {
  const set = subs.get(ws)
  switch (msg.type) {
    case 'subscribe':
      msg.streams.forEach((s) => set?.add(s))
      if (msg.streams.includes('lid')) send(ws, { type: 'lid', t: now(), angle: lastLid })
      if (msg.streams.includes('light')) send(ws, { type: 'light', t: now(), value: lastLight })
      return
    case 'unsubscribe':
      msg.streams.forEach((s) => set?.delete(s))
      return
    case 'pause':
      paused = true
      pausedReason = 'user'
      broadcast(status())
      return
    case 'resume':
      paused = false
      broadcast(status())
      return
    case 'calibration_start':
      calibrating = true
      calZones = msg.zones
      calTarget = msg.target
      calCounts = {}
      broadcast({ type: 'calibration', phase: 'started', zones: calZones, target: calTarget })
      return
    case 'calibration_zone':
      captureZone(msg.zone)
      return
    case 'calibration_negatives':
      negatives(msg.seconds)
      return
    case 'calibration_finish':
      finish()
      return
    case 'calibration_cancel':
      stopCalTimer()
      calibrating = false
      broadcast({ type: 'calibration', phase: 'cancelled' })
      return
    case 'config_get':
      send(ws, { type: 'config', config })
      return
    case 'config_set':
      config = msg.config
      broadcast({ type: 'config', config })
      broadcast(status())
      return
    case 'test_action': {
      const error = paused ? 'Ghostkeys is paused' : isApproved(msg.action) ? null : 'action is not approved'
      setTimeout(() => send(ws, { type: 'action', t: now(), bindingId: null, label: describeAction(msg.action), ok: !error, error }), 120)
      return
    }
    case 'approve_action': {
      const h = hashOf(msg.action as Parameters<typeof hashOf>[0])
      approved.add(h)
      send(ws, { type: 'approved', hash: h, kind: msg.action.kind })
      return
    }
    case 'revoke_action': {
      const found = approved.delete(msg.hash)
      send(ws, { type: 'revoked', hash: msg.hash, found })
      return
    }
    case 'catalog_get':
      send(ws, { type: 'catalog', catalog: catalog as never })
      return
    case 'sound_session_start':
    case 'air_session_start':
      startSession(msg.type === 'sound_session_start' ? 'sound' : 'air', msg.seconds)
      return
    case 'sound_session_stop':
    case 'air_session_stop':
      stopSession(msg.type === 'sound_session_stop' ? 'sound' : 'air', 'requested')
      return
    case 'request_permission':
      setTimeout(() => {
        accessibility = true
        broadcast(hello())
      }, 1500)
      return
  }
}

wss.on('connection', (ws) => {
  subs.set(ws, new Set(['taps']))
  send(ws, hello())
  send(ws, status())
  send(ws, { type: 'config', config })
  send(ws, sessionMsg('sound'))
  send(ws, sessionMsg('air'))
  ws.on('message', (data) => {
    try {
      handle(ws, JSON.parse(String(data)) as AppMessage)
    } catch (e) {
      send(ws, { type: 'error', message: `Bad message: ${String(e)}` })
    }
  })
  ws.on('close', () => subs.delete(ws))
})

wss.on('listening', () =>
  console.log(`[mock ghostkeysd] ws://127.0.0.1:${port} (${family}, events ${rate}, ${token ? 'token required' : 'no token: any Origin-less client'})`)
)
wss.on('error', (e) => {
  console.error(`[mock ghostkeysd] ${e.message}`)
  process.exit(1)
})

// The detector level moves; send it now and then like the daemon's status updates.
setInterval(() => broadcast(status()), 2000)

const shutdown = (): void => {
  wss.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
