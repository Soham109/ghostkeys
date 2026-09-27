// Scripted states for `pnpm screenshots` (SCREENSHOT=1). Each shot resets the UI, then sets it up.
import { useStore } from './store'
import { client } from './client'
import { useWizard } from '@/screens/Calibration'
import type { Binding, GestureMsg, TapMsg } from '@shared/protocol'
import { armDrawIn, skipDrawIn } from '@/components/laptop/LaptopMap'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!pred() && Date.now() < end) await sleep(50)
}

function clickText(selector: string, text: string): void {
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.includes(text))
  el?.click()
}

async function reset(theme: 'dark' | 'light' = 'dark'): Promise<void> {
  useStore.setState({
    onboarding: false,
    paletteOpen: false,
    presetsOpen: false,
    forceOffline: false,
    themeOverride: theme,
    debugHands: false,
    debugFrames: false,
    route: 'live'
  })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(350)
}

// Daemon clock (ms since daemon start), from the motion stream, so injected events line up with the traces.
let daemonT = 0
let daemonAt = performance.now()
client.on('imu', (m) => {
  daemonT = m.t
  daemonAt = performance.now()
})
const dnow = (): number => daemonT + (performance.now() - daemonAt)

const zoneIds = (): string[] => useStore.getState().config?.zones.map((z) => z.id) ?? []

/** A tap on a zone, as the daemon would report it, landing somewhere inside the zone. */
function fakeTap(zoneId: string, jitter = 0.3): void {
  const z = useStore.getState().config?.zones.find((x) => x.id === zoneId)
  if (!z) return
  const r = z.rect
  const msg: TapMsg = {
    type: 'tap',
    t: dnow(),
    zone: zoneId,
    confidence: 0.94,
    x: r.x + r.w * (0.5 + (Math.random() - 0.5) * jitter * 2),
    y: r.y + r.h * (0.5 + (Math.random() - 0.5) * jitter * 2),
    strength: 0.6
  }
  client.inject(msg)
}

const openSeed = async (seed: Binding): Promise<void> => {
  useStore.getState().navigate('bindings')
  await sleep(300)
  useStore.setState({ editorSeed: seed })
  await sleep(700)
}

const SHOTS: Record<string, () => Promise<void>> = {
  'onboarding-1-welcome': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 0 })
    await sleep(1650)
  },
  'onboarding-2-device': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 1 })
    await sleep(1300)
  },
  'onboarding-3-accessibility': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 2 })
    await sleep(1300)
  },
  'onboarding-4-calibrate': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 3 })
    await sleep(1300)
  },
  live: async () => {
    useStore.getState().navigate('live')
    await waitFor(() => useStore.getState().feed.length >= 8, 8000)
    await sleep(1400)
    fakeTap('right-grille')
    await sleep(140)
  },
  'live-light': async () => {
    useStore.getState().navigate('live')
    await sleep(1800)
    fakeTap('left-palm')
    await sleep(140)
  },
  'live-notices': async () => {
    const st = useStore.getState().status
    if (st) useStore.setState({ status: { ...st, paused: true, pausedReason: 'rate_limit' } })
    useStore.getState().navigate('live')
    await sleep(900)
  },
  'live-session': async () => {
    client.send({ type: 'sound_session_start', seconds: 30 })
    useStore.getState().navigate('live')
    await sleep(1500)
    client.send({ type: 'sound_session_stop' })
  },
  zones: async () => {
    useStore.getState().navigate('zones')
    await sleep(500)
    clickText('aside button', 'Right palm rest')
    await sleep(500)
  },
  'zones-light': async () => {
    useStore.getState().navigate('zones')
    await sleep(500)
    clickText('aside button', 'Left grille')
    await sleep(500)
  },
  bindings: async () => {
    useStore.getState().navigate('bindings')
    await sleep(600)
  },
  'bindings-editor': async () => {
    useStore.getState().navigate('bindings')
    await sleep(400)
    const b = useStore.getState().draft?.bindings.find((x) => x.id === 'b4')
    if (b) useStore.setState({ editingBinding: b.id })
    await sleep(700)
  },
  'bindings-presets': async () => {
    useStore.getState().navigate('bindings')
    await sleep(300)
    useStore.setState({ presetsOpen: true })
    await sleep(700)
  },
  'library-layouts': async () => {
    useStore.getState().navigate('bindings')
    await sleep(300)
    useStore.setState({ presetsOpen: true })
    await sleep(500)
    clickText('[role=dialog] nav button', 'Ready-made layouts')
    await sleep(500)
  },
  'bindings-macro': async () => {
    await openSeed({
      id: 'b-macro',
      enabled: true,
      gesture: 'rhythm',
      zone: 'right-palm',
      zones: null,
      modifiers: ['option'],
      app: 'com.microsoft.VSCode',
      label: 'Save, format and run tests',
      action: {
        kind: 'macro',
        steps: [
          { kind: 'keystroke', key: 's', modifiers: ['command'] },
          { kind: 'keystroke', key: 'f', modifiers: ['option', 'shift'], delayMs: 120 },
          { kind: 'window', op: 'right', delayMs: 80 },
          { kind: 'shell', command: 'cd ~/code/app && npm test', delayMs: 250 }
        ]
      }
    })
    document.querySelector('[role=dialog] .overflow-y-auto')?.scrollTo({ top: 360 })
    await sleep(200)
  },
  'bindings-integration': async () => {
    await openSeed({
      id: 'b-int',
      enabled: true,
      gesture: 'double',
      zone: 'left-palm',
      zones: null,
      modifiers: [],
      app: 'com.microsoft.Excel',
      label: 'Wrap in IFERROR',
      action: { kind: 'integration', app: 'excel', command: 'wrap-iferror', args: { fallback: '0' } }
    })
  },
  'bindings-pinch': async () => {
    await openSeed({
      id: 'b-pinch',
      enabled: true,
      gesture: 'pinch_hold',
      zone: 'air',
      zones: null,
      modifiers: [],
      app: '*',
      label: 'Volume knob',
      knob: { axis: 'y', stepPx: 24, inverse: { kind: 'volume', step: -3 } },
      action: { kind: 'volume', step: 3 }
    })
  },
  'calibration-1-pick': async () => {
    useWizard.setState({ step: 'pick', picked: zoneIds().filter((id) => id !== 'lid') })
    useStore.getState().navigate('calibration')
    await sleep(700)
  },
  'calibration-2-capture': async () => {
    const ids = zoneIds()
    useWizard.setState({ step: 'capture', picked: ids, index: 2, target: 20, counts: { [ids[0]!]: 20, [ids[1]!]: 20, [ids[2]!]: 12 } })
    useStore.getState().navigate('calibration')
    await sleep(700)
    for (let i = 0; i < 13; i++) {
      fakeTap(ids[2]!, 0.42)
      await sleep(60)
    }
    useWizard.setState({ counts: { [ids[0]!]: 20, [ids[1]!]: 20, [ids[2]!]: 13 } })
    await sleep(1400)
    fakeTap(ids[2]!, 0.3)
    await sleep(160)
  },
  'calibration-3-negatives': async () => {
    useWizard.setState({ step: 'negatives', negLeft: 27, negSeconds: 45, heard: { typing: 38, trackpad: 11 } })
    useStore.getState().navigate('calibration')
    const unsub = client.subscribe(['imu'])
    for (let i = 0; i < 9; i++) {
      await sleep(260)
      client.inject({ type: 'rejected', t: dnow(), reason: i % 4 === 3 ? 'trackpad' : 'typing' })
    }
    unsub()
  },
  'calibration-4-results': async () => {
    const ids = zoneIds()
    const labels = [...ids, 'none']
    const acc: Record<string, number> = {}
    const confusion = labels.map((row, i) => {
      const a = row === 'none' ? 0.985 : row === 'right-grille' ? 0.81 : row === 'lid' ? 0.92 : 0.93 + ((i * 7) % 6) / 100
      if (row !== 'none') acc[row] = a
      const total = row === 'none' ? 200 : 100
      const cells = labels.map(() => 0)
      cells[i] = Math.round(total * a)
      const rest = total - cells[i]!
      const j = row === 'right-grille' ? labels.indexOf('top-strip') : (i + 1) % labels.length
      cells[j]! += Math.ceil(rest * 0.7)
      cells[labels.length - 1]! += rest - Math.ceil(rest * 0.7)
      return cells
    })
    const overall = Object.values(acc).reduce((s, v) => s + v, 0) / Object.keys(acc).length
    const recommendation = {
      keep: ids.filter((id) => id !== 'right-grille' && id !== 'lid'),
      drop: { lid: 'recognised 56% of the time (needs 80%)' },
      merge: [['right-grille', 'top-strip']] as [string, string][],
      expectedAccuracy: Object.fromEntries(ids.filter((id) => id !== 'lid').map((id) => [id, 0.96]))
    }
    useWizard.setState({ step: 'results', picked: ids, applied: null, merged: [], result: { type: 'calibration', phase: 'done', accuracy: acc, overall, confusion, labels, recommendation, peaks: Object.fromEntries(ids.map((id) => [id, { p10: 0.05, p50: 0.11, p90: 0.2 }])) } })
    useStore.getState().navigate('calibration')
    await sleep(1500)
  },
  sensors: async () => {
    useStore.getState().navigate('sensors')
    await sleep(8500)
  },
  'sensors-light': async () => {
    client.send({ type: 'air_session_start', seconds: 20 })
    useStore.getState().navigate('sensors')
    await sleep(4000)
    client.send({ type: 'air_session_stop' })
  },
  settings: async () => {
    useStore.getState().navigate('settings')
    await sleep(600)
  },
  'settings-sessions': async () => {
    useStore.getState().navigate('settings')
    await sleep(500)
    document.querySelector('[aria-label="Sound mode"]')?.scrollIntoView({ block: 'start' })
    await sleep(300)
  },
  'settings-license': async () => {
    useStore.getState().navigate('settings')
    await sleep(500)
    document.querySelector('[aria-label="License"]')?.scrollIntoView({ block: 'start' })
    await sleep(300)
  },
  'live-feed-enter': async () => {
    useStore.getState().navigate('live')
    await waitFor(() => useStore.getState().feed.length >= 6, 8000)
    await sleep(900)
    // A new gesture arrives; the capture lands mid-animation (see screenshots.ts).
    const g: GestureMsg = { type: 'gesture', t: dnow(), gesture: 'triple', zone: 'left-palm', zones: ['left-palm'], modifiers: [], confidence: 0.95, app: null }
    client.inject(g)
  },
  'first-launch-draw': async () => {
    useStore.getState().navigate('sensors')
    await sleep(200)
    armDrawIn()
    useStore.getState().navigate('live')
    await sleep(560)
  },
  guide: async () => {
    useStore.getState().navigate('guide')
    await sleep(1150)
  },
  'guide-light': async () => {
    useStore.getState().navigate('guide')
    await sleep(500)
    document.getElementById('g-sequence')?.scrollIntoView({ block: 'start' })
    await sleep(900)
  },
  'guide-camera': async () => {
    useStore.getState().navigate('guide')
    await sleep(300)
    clickText('nav[aria-label="Gesture groups"] button', 'Camera')
    await sleep(1300)
  },
  'guide-motion': async () => {
    useStore.getState().navigate('guide')
    await sleep(300)
    clickText('nav[aria-label="Gesture groups"] button', 'Motion')
    await sleep(1000)
  },
  'guide-sonar': async () => {
    useStore.getState().navigate('guide')
    await sleep(300)
    clickText('nav[aria-label="Gesture groups"] button', 'Sonar')
    await sleep(1400)
  },
  'calibration-merged': async () => {
    await SHOTS['calibration-4-results']!()
    useWizard.setState({
      applied: { type: 'calibration', phase: 'recommendation_applied', disabled: ['lid'], keep: [], mergeSuggested: [['right-grille', 'top-strip']], overall: 0.96, accuracy: {}, labels: [] },
      merged: [
        {
          type: 'calibration',
          phase: 'merge_applied',
          zone: 'right-grille-and-top-strip',
          name: 'Right grille and top strip',
          merged: ['right-grille', 'top-strip'],
          samples: 40,
          bindingsChanged: [
            { id: 'b2', label: 'Volume up', gesture: 'tap', from: 'right-grille', to: 'right-grille-and-top-strip' },
            { id: 'b8', label: 'Screenshot of an area', gesture: 'triple', from: 'top-strip', to: 'right-grille-and-top-strip' }
          ],
          conflicts: [],
          overall: 0.96,
          accuracy: {},
          labels: []
        }
      ]
    })
    await sleep(500)
  },
  'live-feedback': async () => {
    useStore.getState().navigate('live')
    await sleep(900)
    useStore.setState({ missedPickerOpen: true })
    await sleep(500)
  },
  'zones-disabled': async () => {
    const d = useStore.getState().draft
    if (d) useStore.setState({ draft: { ...d, zones: d.zones.map((z) => (z.id === 'lid' ? { ...z, enabled: false } : z)) } })
    useStore.getState().navigate('zones')
    await sleep(500)
    clickText('aside button', 'Lid')
    await sleep(500)
  },
  'settings-advanced': async () => {
    useStore.getState().navigate('settings')
    await sleep(400)
    clickText('button', 'Advanced')
    await sleep(300)
    document.querySelector('[aria-label="Feedback"]')?.scrollIntoView({ block: 'center' })
    await sleep(300)
  },
  'sensors-log': async () => {
    useStore.getState().navigate('sensors')
    await sleep(3500)
    clickText('aside button', 'Export last 10 s')
    await sleep(600)
  },
  'settings-sonar': async () => {
    useStore.getState().saveSettings({ sonar: { enabled: true, sessionSeconds: 30, autoApps: [] } })
    useStore.getState().navigate('settings')
    await sleep(500)
    document.querySelector('[aria-label="Sonar (in the air, no camera)"]')?.scrollIntoView({ block: 'start' })
    await sleep(300)
    clickText('button', 'Test sonar on this Mac')
    await sleep(400)
  },
  'sensors-sonar': async () => {
    // Sonar is a switch: turning it on starts it.
    useStore.getState().saveSettings({ sonar: { enabled: true, sessionSeconds: 30, autoApps: [] } })
    await sleep(200)
    useStore.getState().navigate('sensors')
    await sleep(2700)
  },
  'bindings-hover': async () => {
    await openSeed({
      id: 'b-hover',
      enabled: true,
      gesture: 'hover_level',
      zone: 'air',
      zones: null,
      modifiers: [],
      app: '*',
      label: 'Hover over a speaker for volume',
      action: { kind: 'volume', step: 6 },
      slider: { mode: 'relative', stepMm: 15, inverse: { kind: 'volume', step: -6 } }
    })
  },
  'bindings-needs': async () => {
    const d = useStore.getState().draft
    const c = useStore.getState().config
    const extra = [
      { id: 'n1', enabled: true, gesture: 'finger_slide_up', zone: 'right-grille', zones: null, modifiers: [], app: '*', label: 'Brightness up', action: { kind: 'brightness', step: 1 } },
      { id: 'n2', enabled: true, gesture: 'rub_left', zone: null, zones: null, modifiers: [], app: '*', label: 'Previous track', action: { kind: 'media', command: 'previous' } }
    ] as Binding[]
    if (d && c && !c.bindings.some((b) => b.id === 'n1')) {
      const off = { ...c.settings, sonar: { enabled: false, sessionSeconds: 30, autoApps: [] }, sound: { enabled: false, sessionSeconds: 30, autoApps: [] } }
      useStore.setState({ config: { ...c, settings: off, bindings: [...c.bindings, ...extra] }, draft: { ...d, settings: off, bindings: [...d.bindings, ...extra] } })
    }
    useStore.getState().navigate('bindings')
    await sleep(500)
  },
  'binding-needs-editor': async () => {
    await SHOTS['bindings-needs']!()
    useStore.setState({ editingBinding: 'n1' })
    await sleep(700)
  },
  'live-needs': async () => {
    await SHOTS['bindings-needs']!()
    useStore.getState().navigate('live')
    await sleep(700)
  },
  'demo-frames': async () => {
    useStore.setState({ debugFrames: true })
    await sleep(500)
  },
  'demo-editor': async () => {
    await openSeed({ id: 'b-demo', enabled: true, gesture: 'sequence', zone: null, zones: ['left-palm', 'right-palm'], modifiers: [], app: '*', label: 'Fill the screen', action: { kind: 'window', op: 'maximize' } })
    await sleep(400)
  },
  'demo-picker': async () => {
    await openSeed({ id: 'b-demo2', enabled: true, gesture: 'double', zone: 'right-palm', zones: null, modifiers: [], app: '*', label: 'Play or pause', action: { kind: 'media', command: 'playpause' } })
    ;(document.querySelector('[aria-label="Gesture"]') as HTMLElement | null)?.click()
    await sleep(300)
    const opt = document.getElementById('gp-knock_knuckle')
    opt?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    opt?.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    await sleep(900)
  },
  'demo-library': async () => {
    useStore.getState().navigate('bindings')
    await sleep(300)
    useStore.setState({ presetsOpen: true })
    await sleep(600)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    const input = document.querySelector('[role=dialog] [cmdk-input]') as HTMLElement | null
    input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await sleep(900)
  },
  'onboarding-gestures': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 0 })
    await sleep(3900)
  },
  hands: async () => {
    useStore.setState({ debugHands: true })
    await sleep(300)
  },
  'command-palette': async () => {
    useStore.getState().navigate('live')
    await sleep(300)
    useStore.setState({ paletteOpen: true })
    await sleep(500)
  },
  'service-offline': async () => {
    useStore.setState({ forceOffline: true, daemon: { kind: 'missing', searched: ['../daemon/.build/release/ghostkeysd', '../daemon/.build/debug/ghostkeysd'] } })
    await sleep(700)
  }
}

export function installShots(): void {
  skipDrawIn()
  window.__gk = {
    summary: () => {
      const s = useStore.getState()
      return {
        hello: s.hello ? { family: s.hello.device.family, chip: s.hello.device.chip, sensors: s.hello.sensors, permissions: s.hello.permissions } : null,
        status: s.status ? { paused: s.status.paused, calibrated: s.status.calibrated, imuHz: s.status.imuHz, detector: s.status.detector } : null,
        zones: s.config?.zones.length ?? null,
        bindings: s.config?.bindings.length ?? null,
        catalogCommands: s.catalog?.commands.length ?? 0,
        conn: s.conn
      }
    },
    ready: async () => {
      await waitFor(() => !!useStore.getState().config && !!useStore.getState().hello, 8000)
    },
    shot: async (name: string) => {
      const fn = SHOTS[name]
      if (!fn) throw new Error(`Unknown shot ${name}`)
      await reset(name.endsWith('-light') ? 'light' : 'dark')
      await fn()
    }
  }
}
