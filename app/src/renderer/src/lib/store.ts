import { create } from 'zustand'
import { client, type ConnState } from './client'
import { ensureApproved } from './approval'
import type {
  ActionMsg,
  Binding,
  CalibrationMsg,
  Config,
  GestureMsg,
  HelloMsg,
  RejectReason,
  StatusMsg
} from '@shared/protocol'
import type { AppInfo, AppPrefs, DaemonState, ThemeMode } from '@shared/ipc'

export type Route = 'live' | 'zones' | 'bindings' | 'calibration' | 'sensors' | 'settings'
export const ROUTES: Route[] = ['live', 'zones', 'bindings', 'calibration', 'sensors', 'settings']

export interface FeedItem {
  id: number
  at: number
  gesture: GestureMsg
  action?: ActionMsg
}

interface State {
  conn: ConnState
  everConnected: boolean
  forceOffline: boolean
  info: AppInfo | null
  daemon: DaemonState
  hello: HelloMsg | null
  status: StatusMsg | null
  config: Config | null
  draft: Config | null
  saving: boolean
  feed: FeedItem[]
  rejected: Record<RejectReason, number>
  calibration: CalibrationMsg | null
  lastError: string | null
  route: Route
  onboarding: boolean
  onboardingStep: number
  resolvedTheme: 'dark' | 'light'
  themeOverride: 'dark' | 'light' | null
  paletteOpen: boolean
  presetsOpen: boolean
  editingBinding: string | null
  /** A ready-made binding to open in the editor as new (used by scripted screenshots). */
  editorSeed: Binding | null

  navigate: (r: Route) => void
  setDraft: (fn: (c: Config) => Config) => void
  discardDraft: () => void
  saveDraft: () => Promise<void>
  saveSettings: (s: Partial<Config['settings']>) => void
  setPrefs: (p: Partial<AppPrefs>) => Promise<void>
  setPaused: (p: boolean) => void
  finishOnboarding: (to?: Route) => void
}

const ONBOARDED_KEY = 'gk.onboarded'
const onboarded = (): boolean => {
  try {
    return localStorage.getItem(ONBOARDED_KEY) === '1'
  } catch {
    return false
  }
}

export const useStore = create<State>()((set, get) => ({
  conn: 'connecting',
  everConnected: false,
  forceOffline: false,
  info: null,
  daemon: { kind: 'starting' },
  hello: null,
  status: null,
  config: null,
  draft: null,
  saving: false,
  feed: [],
  rejected: { typing: 0, trackpad: 0, motion: 0, low_confidence: 0, burst: 0, paused: 0 },
  calibration: null,
  lastError: null,
  route: 'live',
  onboarding: !onboarded(),
  onboardingStep: 0,
  resolvedTheme: 'dark',
  themeOverride: null,
  paletteOpen: false,
  presetsOpen: false,
  editingBinding: null,
  editorSeed: null,

  navigate: (route) => set({ route, paletteOpen: false }),
  setDraft: (fn) => {
    const d = get().draft
    if (d) set({ draft: fn(structuredClone(d)) })
  },
  discardDraft: () => set({ draft: structuredClone(get().config) }),
  saveDraft: async () => {
    const draft = get().draft
    if (!draft) return
    const ok = await ensureApproved(
      draft.bindings.filter((b) => b.enabled).map((b) => b.action),
      'Saving your bindings. These actions run commands or open things:'
    )
    if (!ok) return
    if (client.send({ type: 'config_set', config: draft })) set({ saving: true })
  },
  saveSettings: (s) => {
    const { config, draft } = get()
    if (!config) return
    const settings = { ...config.settings, ...s }
    client.send({ type: 'config_set', config: { ...config, settings } })
    // Keep any unsaved zone or binding edits; only the settings move.
    set({ config: { ...config, settings }, draft: draft ? { ...draft, settings } : draft })
  },
  setPrefs: async (p) => {
    const prefs = await window.gk.setPrefs(p)
    const info = get().info
    if (info) set({ info: { ...info, prefs } })
  },
  setPaused: (p) => {
    client.send({ type: p ? 'pause' : 'resume' })
  },
  finishOnboarding: (to = 'live') => {
    try {
      localStorage.setItem(ONBOARDED_KEY, '1')
    } catch {
      // storage can be unavailable; onboarding simply shows again next time
    }
    set({ onboarding: false, route: to })
  }
}))

export const isDirty = (s: Pick<State, 'config' | 'draft'>): boolean =>
  !!s.config && !!s.draft && JSON.stringify({ ...s.config, settings: null }) !== JSON.stringify({ ...s.draft, settings: null })

export function themeMode(): ThemeMode {
  return useStore.getState().info?.prefs.theme ?? 'system'
}

// ---------------------------------------------------------------- wire the client into the store

let feedSeq = 0

export function wireClient(): void {
  client.onState((conn) => {
    useStore.setState((s) => ({ conn, everConnected: s.everConnected || conn === 'open' }))
  })
  client.on('hello', (hello) => useStore.setState({ hello }))
  client.on('status', (status) => useStore.setState({ status }))
  client.on('config', (m) => {
    const s = useStore.getState()
    const wasSaving = s.saving
    const keepDraft = isDirty(s) && !wasSaving
    useStore.setState({
      config: m.config,
      draft: keepDraft ? s.draft : structuredClone(m.config),
      saving: false
    })
  })
  client.on('gesture', (gesture) => {
    const item: FeedItem = { id: ++feedSeq, at: Date.now(), gesture }
    useStore.setState((s) => ({ feed: [item, ...s.feed].slice(0, 40) }))
  })
  client.on('action', (action) => {
    if (action.bindingId === 'test') return
    useStore.setState((s) => {
      const i = s.feed.findIndex((f) => !f.action && Date.now() - f.at < 2000)
      if (i < 0) return s
      const feed = s.feed.slice()
      feed[i] = { ...feed[i]!, action }
      return { feed }
    })
  })
  client.on('rejected', (r) => useStore.setState((s) => ({ rejected: { ...s.rejected, [r.reason]: s.rejected[r.reason] + 1 } })))
  client.on('calibration', (calibration) => useStore.setState({ calibration }))
  client.on('error', (e) => useStore.setState({ lastError: e.message }))
}
