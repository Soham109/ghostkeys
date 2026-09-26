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
  IntegrationCatalog,
  RejectReason,
  SessionMsg,
  StatusMsg,
  TapMsg
} from '@shared/protocol'
import type { AppInfo, AppPrefs, DaemonState } from '@shared/ipc'
import { FREE_LICENSE, type LicenseState } from '@shared/license'

export type Route = 'live' | 'zones' | 'bindings' | 'calibration' | 'sensors' | 'settings'
export const ROUTES: Route[] = ['live', 'zones', 'bindings', 'calibration', 'sensors', 'settings']

export interface FeedItem {
  id: number
  at: number
  gesture: GestureMsg
  action?: ActionMsg
  /** Same gesture, zone and action within 3 s collapse into one row. */
  count: number
  tapType?: TapMsg['tapType']
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
  lastRejected: { reason: RejectReason; at: number } | null
  calibration: CalibrationMsg | null
  sessions: { sound: SessionMsg | null; air: SessionMsg | null }
  catalog: IntegrationCatalog | null
  license: LicenseState
  lastError: string | null
  tapsSeen: number
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
  windowFocused: boolean

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
  lastRejected: null,
  calibration: null,
  sessions: { sound: null, air: null },
  catalog: null,
  license: FREE_LICENSE,
  lastError: null,
  tapsSeen: 0,
  route: 'live',
  onboarding: !onboarded(),
  onboardingStep: 0,
  resolvedTheme: 'dark',
  themeOverride: null,
  paletteOpen: false,
  presetsOpen: false,
  editingBinding: null,
  editorSeed: null,
  windowFocused: true,

  navigate: (route) => set({ route, paletteOpen: false }),
  setDraft: (fn) => {
    const d = get().draft
    if (d) set({ draft: fn(structuredClone(d)) })
  },
  discardDraft: () => set({ draft: structuredClone(get().config) }),
  saveDraft: async () => {
    const draft = get().draft
    if (!draft) return
    const approved = await ensureApproved(draft, 'Saving your bindings. These actions run commands or open things:')
    if (!approved) return
    set({ draft: approved })
    if (client.send({ type: 'config_set', config: approved })) set({ saving: true })
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

/** 1-based position of a zone, its identity everywhere in the UI. */
export function zoneNumber(config: Config | null, id: string | null | undefined): number | null {
  if (!config || !id) return null
  const i = config.zones.findIndex((z) => z.id === id)
  return i < 0 ? null : i + 1
}

// ---------------------------------------------------------------- wire the client into the store

let feedSeq = 0
const lastTapType = new Map<string, { type: TapMsg['tapType']; at: number }>()

const sameGesture = (a: GestureMsg, b: GestureMsg): boolean =>
  a.gesture === b.gesture && a.zone === b.zone && JSON.stringify(a.zones) === JSON.stringify(b.zones)

export function wireClient(): void {
  client.onState((conn) => {
    useStore.setState((s) => ({ conn, everConnected: s.everConnected || conn === 'open' }))
    if (conn === 'open') client.send({ type: 'catalog_get' })
    else useStore.setState({ sessions: { sound: null, air: null } })
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
  client.on('tap', (t) => {
    if (t.tapType) lastTapType.set(t.zone, { type: t.tapType, at: Date.now() })
    useStore.setState((s) => ({ tapsSeen: s.tapsSeen + 1 }))
  })
  client.on('gesture', (gesture) => {
    const now = Date.now()
    const tt = gesture.zone ? lastTapType.get(gesture.zone) : undefined
    const tapType = tt && now - tt.at < 1500 ? tt.type : undefined
    useStore.setState((s) => {
      const top = s.feed[0]
      if (top && sameGesture(top.gesture, gesture) && now - top.at < 3000) {
        const merged: FeedItem = { ...top, at: now, gesture, count: top.count + 1, action: undefined, tapType: tapType ?? top.tapType }
        return { feed: [merged, ...s.feed.slice(1)] }
      }
      const item: FeedItem = { id: ++feedSeq, at: now, gesture, count: 1, tapType }
      return { feed: [item, ...s.feed].slice(0, 60) }
    })
  })
  client.on('action', (action) => {
    if (action.bindingId === null || action.bindingId === 'test') return
    useStore.setState((s) => {
      const i = s.feed.findIndex((f) => !f.action && Date.now() - f.at < 2000)
      if (i < 0) return s
      const feed = s.feed.slice()
      feed[i] = { ...feed[i]!, action }
      return { feed }
    })
  })
  client.on('rejected', (r) =>
    useStore.setState((s) => ({
      rejected: { ...s.rejected, [r.reason]: (s.rejected[r.reason] ?? 0) + 1 },
      lastRejected: { reason: r.reason, at: Date.now() }
    }))
  )
  client.on('calibration', (calibration) => useStore.setState({ calibration }))
  client.on('session', (m) => useStore.setState((s) => ({ sessions: { ...s.sessions, [m.kind === 'sound' ? 'sound' : 'air']: m } })))
  client.on('catalog', (m) => useStore.setState({ catalog: m.catalog }))
  client.on('error', (e) => useStore.setState({ lastError: e.message }))
}
