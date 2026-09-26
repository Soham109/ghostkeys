import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Library } from '../shared/library'
import type { AppMessage, DaemonMessage } from '../shared/protocol'
import type { AppInfo, AppPrefs, ConnState, DaemonState, GhostkeysBridge, HudPayload } from '../shared/ipc'

function on<T>(channel: string, cb: (v: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const bridge: GhostkeysBridge = {
  info: () => ipcRenderer.invoke('info') as Promise<AppInfo>,
  onDaemonState: (cb) => on<DaemonState>('daemon-state', cb),
  restartDaemon: () => ipcRenderer.invoke('restart-daemon') as Promise<void>,
  setPrefs: (p) => ipcRenderer.invoke('set-prefs', p) as Promise<AppPrefs>,
  onHud: (cb) => on<HudPayload>('hud', cb),
  onNavigate: (cb) => on<string>('navigate', cb),
  library: () => ipcRenderer.invoke('library') as Promise<Library>,
  send: (msg: AppMessage) => ipcRenderer.send('daemon-send', msg),
  onMessage: (cb) => on<DaemonMessage>('daemon-message', cb),
  onConn: (cb) => on<ConnState>('daemon-conn', cb),
  reconnect: () => ipcRenderer.send('daemon-reconnect'),
  setLicense: (key) => ipcRenderer.invoke('set-license', key) as ReturnType<GhostkeysBridge['setLicense']>,
  pricing: () => ipcRenderer.invoke('pricing') as Promise<unknown>,
  approve: (actions, context) => ipcRenderer.invoke('approve', actions, context) as Promise<(string | null)[] | null>
}

contextBridge.exposeInMainWorld('gk', bridge)
