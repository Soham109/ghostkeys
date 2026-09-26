// Scripted states for `pnpm screenshots` (SCREENSHOT=1). Each shot resets the UI, then sets it up.
import { useStore } from './store'
import { useWizard } from '@/screens/Calibration'

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
    route: 'live'
  })
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(350)
}

const zoneIds = (): string[] => useStore.getState().config?.zones.map((z) => z.id) ?? []

const SHOTS: Record<string, () => Promise<void>> = {
  'onboarding-1-welcome': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 0 })
    await sleep(1900)
  },
  'onboarding-2-device': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 1 })
    await sleep(900)
  },
  'onboarding-3-accessibility': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 2 })
  },
  'onboarding-4-calibrate': async () => {
    useStore.setState({ onboarding: true, onboardingStep: 3 })
  },
  live: async () => {
    useStore.getState().navigate('live')
    await waitFor(() => useStore.getState().feed.length >= 6)
    await sleep(300)
  },
  'live-light': async () => {
    useStore.getState().navigate('live')
    await sleep(900)
  },
  zones: async () => {
    useStore.getState().navigate('zones')
    await sleep(400)
    clickText('aside button', 'Right palm rest')
  },
  'zones-light': async () => {
    useStore.getState().navigate('zones')
    await sleep(400)
    clickText('aside button', 'Left grille')
  },
  bindings: async () => {
    useStore.getState().navigate('bindings')
  },
  'bindings-editor': async () => {
    useStore.getState().navigate('bindings')
    await sleep(400)
    const b = useStore.getState().draft?.bindings.find((x) => x.id === 'b4')
    if (b) useStore.setState({ editingBinding: b.id })
  },
  'bindings-presets': async () => {
    useStore.getState().navigate('bindings')
    await sleep(300)
    useStore.setState({ presetsOpen: true })
  },
  'bindings-macro': async () => {
    useStore.getState().navigate('bindings')
    await sleep(300)
    useStore.setState({
      editorSeed: {
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
      }
    })
    await sleep(300)
    document.querySelector('[role=dialog] .overflow-y-auto')?.scrollTo({ top: 420 })
  },
  'calibration-1-pick': async () => {
    useWizard.setState({ step: 'pick', picked: zoneIds().filter((id) => id !== 'lid') })
    useStore.getState().navigate('calibration')
  },
  'calibration-2-capture': async () => {
    const ids = zoneIds()
    useWizard.setState({ step: 'capture', picked: ids, index: 2, target: 20, counts: { [ids[0]!]: 20, [ids[1]!]: 20, [ids[2]!]: 13 } })
    useStore.getState().navigate('calibration')
    await sleep(500)
  },
  'calibration-3-negatives': async () => {
    useWizard.setState({ step: 'negatives', negLeft: 27, negSeconds: 45, heard: { typing: 38, trackpad: 11 } })
    useStore.getState().navigate('calibration')
  },
  'calibration-4-results': async () => {
    const ids = zoneIds()
    const labels = [...ids, 'none']
    const acc: Record<string, number> = {}
    const confusion = labels.map((row, i) => {
      const a = row === 'none' ? 0.985 : row === 'right-grille' ? 0.81 : row === 'lid' ? 0.9 + (i % 3) * 0.02 : 0.93 + ((i * 7) % 6) / 100
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
    useWizard.setState({ step: 'results', picked: ids, result: { type: 'calibration', phase: 'done', accuracy: acc, overall, confusion, labels } })
    useStore.getState().navigate('calibration')
    await sleep(900)
  },
  sensors: async () => {
    useStore.getState().navigate('sensors')
    await sleep(3200)
  },
  'sensors-light': async () => {
    useStore.getState().navigate('sensors')
    await sleep(3200)
  },
  settings: async () => {
    useStore.getState().navigate('settings')
  },
  'command-palette': async () => {
    useStore.getState().navigate('live')
    await sleep(300)
    useStore.setState({ paletteOpen: true })
  },
  'service-offline': async () => {
    useStore.setState({ forceOffline: true, daemon: { kind: 'missing', searched: ['../daemon/.build/release/ghostkeysd', '../daemon/.build/debug/ghostkeysd'] } })
  }
}

export function installShots(): void {
  window.__gk = {
    ready: async () => {
      await waitFor(() => !!useStore.getState().config && !!useStore.getState().hello, 8000)
    },
    shot: async (name: string) => {
      const fn = SHOTS[name]
      if (!fn) throw new Error(`Unknown shot ${name}`)
      await reset(name.endsWith('-light') ? 'light' : 'dark')
      await fn()
      await sleep(600)
    }
  }
}
