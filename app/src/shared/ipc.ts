// Types shared by main, preload and renderer for Electron IPC.
import type { Library } from './library'
import type { LicenseState } from './license'
import type { AppMessage, DaemonMessage, SimpleAction } from './protocol'

export type DaemonState =
  | { kind: 'starting' }
  | { kind: 'mock' }
  | { kind: 'external' }
  | { kind: 'running'; path: string; pid: number }
  | { kind: 'missing'; searched: string[] }
  | { kind: 'exited'; path: string; code: number | null; signal: string | null; message?: string; gaveUp?: boolean }

export type ConnState = 'connecting' | 'open' | 'closed'

export type ThemeMode = 'system' | 'light' | 'dark'

export interface AppInfo {
  port: number
  mock: boolean
  screenshot: boolean
  version: string
  daemon: DaemonState
  conn: ConnState
  prefs: AppPrefs
  /** Last hello, status and config the main process saw, so a freshly loaded window starts complete. */
  snapshot: DaemonMessage[]
  packaged: boolean
  license: LicenseState
}

export interface AppPrefs {
  theme: ThemeMode
  /** Keep running in the menu bar when the window is closed. */
  keepInMenuBar: boolean
  /** Open the main window when Ghostkeys starts. */
  showWindowOnLaunch: boolean
  /** Offline license key (see shared/license.ts). */
  licenseKey?: string | null
}

export interface HudPayload {
  id: number
  title: string
  detail: string | null
  ok: boolean
}

/**
 * Everything the renderer can do. The renderer never opens the WebSocket itself: the main process
 * holds the only connection (with the session token) and relays messages both ways.
 */
export interface GhostkeysBridge {
  info(): Promise<AppInfo>
  onDaemonState(cb: (s: DaemonState) => void): () => void
  restartDaemon(): Promise<void>
  setPrefs(p: Partial<AppPrefs>): Promise<AppPrefs>
  onHud(cb: (p: HudPayload) => void): () => void
  onNavigate(cb: (route: string) => void): () => void
  library(): Promise<Library>
  send(msg: AppMessage): void
  onMessage(cb: (m: DaemonMessage) => void): () => void
  onConn(cb: (s: ConnState) => void): () => void
  reconnect(): void
  /** Native dialog with the exact text; on approval sends approve_action for each. Resolves to the daemon's hashes in order, or null if declined. */
  approve(actions: SimpleAction[], context: string): Promise<(string | null)[] | null>
  setLicense(key: string | null): Promise<{ license: LicenseState; error: string | null }>
  /** docs/pricing/features.json, copied into the app at build time. */
  pricing(): Promise<unknown>
}
