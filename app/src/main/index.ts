import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DaemonSupervisor } from './daemon'
import { DaemonBridge } from './bridge'
import { runScreenshots } from './screenshots'
import { runSelfTest } from './selftest'
import { registerNativeIpc } from './native'
import { loadLibrary } from './library'
import { DEFAULT_PORT, GESTURE_LABEL, ZONELESS_GESTURES, type AppMessage, type DaemonMessage, type SimpleAction } from '@shared/protocol'
import { APPROVAL_KINDS, approvalPayload, approvalText } from '@shared/approval'
import type { AppInfo, AppPrefs, ConnState, DaemonState, HudPayload } from '@shared/ipc'
import { licenseState, parseLicense } from '@shared/license'

const PORT = Number(process.env.GK_PORT ?? DEFAULT_PORT)
const MOCK = process.env.GK_MOCK === '1'
const SELFTEST = process.env.SELFTEST === '1'
/** Offscreen scripted runs: screenshots, or the self-test against a real daemon. */
const SCREENSHOT = process.env.SCREENSHOT === '1' || SELFTEST
const APP_ROOT = app.getAppPath()
const RES_DIR = app.isPackaged ? process.resourcesPath : join(APP_ROOT, 'resources')

app.setName('Ghostkeys')

// Electron's own files (caches, local storage, prefs) live in Ghostkeys/app; the daemon owns Ghostkeys/daemon.
// Must run before the app is ready. Idempotent: prefs from the old shared folder are copied once.
const GK_SUPPORT = join(app.getPath('appData'), 'Ghostkeys')
const APP_DATA = join(GK_SUPPORT, 'app')
try {
  mkdirSync(APP_DATA, { recursive: true })
  const oldPrefs = join(GK_SUPPORT, 'app-prefs.json')
  const newPrefs = join(APP_DATA, 'app-prefs.json')
  if (existsSync(oldPrefs) && !existsSync(newPrefs)) copyFileSync(oldPrefs, newPrefs)
} catch (e) {
  console.error('[paths] could not prepare', APP_DATA, e)
}
app.setPath('userData', APP_DATA)

// ---------------------------------------------------------------- prefs

const DEFAULT_PREFS: AppPrefs = { theme: 'system', keepInMenuBar: true, showWindowOnLaunch: true }
const prefsFile = (): string => join(app.getPath('userData'), 'app-prefs.json')

function loadPrefs(): AppPrefs {
  if (SCREENSHOT) return { ...DEFAULT_PREFS, theme: 'dark' }
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(readFileSync(prefsFile(), 'utf8')) as Partial<AppPrefs>) }
  } catch {
    return { ...DEFAULT_PREFS }
  }
}
let prefs: AppPrefs = DEFAULT_PREFS

function savePrefs(): void {
  if (SCREENSHOT) return
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2))
  } catch (e) {
    console.error('Could not save prefs', e)
  }
}

// ---------------------------------------------------------------- windows

let mainWindow: BrowserWindow | null = null
let hudWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

// ---------------------------------------------------------------- session token (SAFETY_AUDIT C1)

/** Per-launch secret handed to the daemon we spawn. GHOSTKEYS_TOKEN lets the mock (or a test) share one. */
const SESSION_TOKEN = process.env.GHOSTKEYS_TOKEN || randomBytes(32).toString('hex')

/** Token for a daemon started elsewhere: it writes one (mode 0600) into its config folder on every launch. */
function externalToken(): string | null {
  const support = join(homedir(), 'Library', 'Application Support', 'Ghostkeys')
  const dirs = [process.env.GHOSTKEYS_CONFIG_DIR, join(support, 'daemon'), support].filter((d): d is string => !!d)
  for (const dir of dirs) {
    for (const name of ['token', 'session-token']) {
      try {
        const t = readFileSync(join(dir, name), 'utf8').trim()
        if (t) return t
      } catch {
        // not there
      }
    }
  }
  return null
}

const supervisor = new DaemonSupervisor(APP_ROOT, PORT, MOCK, SESSION_TOKEN)
const bridge = new DaemonBridge(PORT, () =>
  supervisor.state.kind === 'external' ? (externalToken() ?? SESSION_TOKEN) : SESSION_TOKEN
)

function rendererUrl(page: 'index' | 'hud', query: Record<string, string> = {}): { url?: string; file?: string; query: Record<string, string> } {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    const qs = new URLSearchParams(query).toString()
    return { url: `${devUrl}/${page}.html${qs ? `?${qs}` : ''}`, query }
  }
  return { file: join(__dirname, `../renderer/${page}.html`), query }
}

function load(win: BrowserWindow, page: 'index' | 'hud', query: Record<string, string> = {}): Promise<void> {
  const target = rendererUrl(page, query)
  return target.url ? win.loadURL(target.url) : win.loadFile(target.file!, { query })
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: SCREENSHOT ? 1240 : 1180,
    height: SCREENSHOT ? 800 : 760,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Ghostkeys',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: SCREENSHOT ? undefined : 'under-window',
    visualEffectState: 'followWindow',
    backgroundColor: SCREENSHOT ? '#0A0A0B' : '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      offscreen: SCREENSHOT ? { deviceScaleFactor: 2 } : false
    }
  })
  win.on('ready-to-show', () => {
    if (!SCREENSHOT && prefs.showWindowOnLaunch) win.show()
  })
  win.on('close', (e) => {
    if (quitting || SCREENSHOT) return
    if (prefs.keepInMenuBar) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('x-apple.systempreferences:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  void load(win, 'index', SCREENSHOT ? { screenshot: '1' } : {})
  return win
}

function showMain(route?: string): void {
  if (!mainWindow) mainWindow = createMainWindow()
  if (route) mainWindow.webContents.send('navigate', route)
  mainWindow.show()
  mainWindow.focus()
}

const HUD_W = 560
const HUD_H = 72

function createHudWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: HUD_W,
    height: HUD_H,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      offscreen: SCREENSHOT ? { deviceScaleFactor: 2 } : false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void load(win, 'hud', SCREENSHOT ? { backdrop: '1' } : {})
  return win
}

function positionHud(): void {
  if (!hudWindow) return
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width } = display.workArea
  hudWindow.setBounds({ x: Math.round(x + (width - HUD_W) / 2), y: y + 10, width: HUD_W, height: HUD_H })
}

// ---------------------------------------------------------------- HUD

let hudSeq = 0
let hudHideTimer: NodeJS.Timeout | null = null
let lastGesture: { title: string; at: number } | null = null
const HUD_HOLD_MS = 1100
const HUD_EXIT_MS = 240

function zoneName(id: string | null): string | null {
  if (!id) return null
  if (id === 'air') return 'In the air'
  return bridge.config?.zones.find((z) => z.id === id)?.name ?? id
}

function showHud(title: string, detail: string | null, ok = true): void {
  if (bridge.config && !bridge.config.settings.hud) return
  if (!hudWindow) hudWindow = createHudWindow()
  const payload: HudPayload = { id: ++hudSeq, title, detail, ok }
  if (!SCREENSHOT) {
    positionHud()
    hudWindow.showInactive()
  }
  hudWindow.webContents.send('hud', payload)
  if (hudHideTimer) clearTimeout(hudHideTimer)
  hudHideTimer = setTimeout(() => {
    if (!SCREENSHOT) hudWindow?.hide()
  }, HUD_HOLD_MS + HUD_EXIT_MS + 120)
}

function onDaemonMessage(msg: DaemonMessage): void {
  if (msg.type === 'gesture') {
    const title = ZONELESS_GESTURES.includes(msg.gesture)
      ? GESTURE_LABEL[msg.gesture]
      : msg.gesture === 'sequence' && msg.zones
        ? msg.zones.map((z) => zoneName(z)).join(' then ')
        : (zoneName(msg.zone) ?? GESTURE_LABEL[msg.gesture])
    lastGesture = { title, at: Date.now() }
    showHud(title, ZONELESS_GESTURES.includes(msg.gesture) ? null : GESTURE_LABEL[msg.gesture])
  } else if (msg.type === 'action') {
    const recent = lastGesture && Date.now() - lastGesture.at < 1500 ? lastGesture.title : null
    const title = msg.bindingId === 'test' || msg.bindingId === null ? 'Test' : (recent ?? 'Ghostkeys')
    showHud(title, msg.label, msg.ok)
  }
}

// ---------------------------------------------------------------- tray

function trayImage(state: 'normal' | 'paused' | 'session'): Electron.NativeImage {
  const want = state === 'paused' ? 'trayPausedTemplate' : state === 'session' ? 'trayActive' : 'trayTemplate'
  const base = existsSync(join(RES_DIR, `${want}.png`)) ? want : 'trayTemplate'
  const img = nativeImage.createFromPath(join(RES_DIR, `${base}.png`))
  const img2x = nativeImage.createFromPath(join(RES_DIR, `${base}@2x.png`))
  if (!img2x.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: img2x.toPNG() })
  // The active icon carries the one colored dot; the others follow the menu bar's appearance.
  img.setTemplateImage(base !== 'trayActive')
  return img
}

let traySig = ''

function refreshTray(): void {
  if (!tray) return
  const connected = bridge.connected
  const rateLimited = bridge.paused && bridge.pausedReason === 'rate_limit'
  const statusLabel = !connected
    ? 'Service not running'
    : rateLimited
      ? 'Paused: too many actions in a row'
      : bridge.paused
        ? 'Paused'
        : 'Listening for taps'
  const sessions = (['sound', 'air'] as const).filter((k) => bridge.sessions[k]?.active)
  const sessionLabel = (k: 'sound' | 'air'): string =>
    `${k === 'sound' ? 'Microphone' : 'Camera'} on, ${Math.max(0, Math.round(bridge.sessions[k]?.secondsLeft ?? 0))} s left`
  const sig = JSON.stringify([statusLabel, sessions.map(sessionLabel), bridge.paused])
  if (sig === traySig) return
  traySig = sig
  tray.setToolTip(`Ghostkeys: ${statusLabel}`)
  tray.setImage(trayImage(sessions.length ? 'session' : connected && bridge.paused ? 'paused' : 'normal'))
  tray.setTitle(sessions.length ? (sessions.includes('air') ? ' CAM' : ' MIC') : '', { fontType: 'monospacedDigit' })
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      ...sessions.flatMap((k): Electron.MenuItemConstructorOptions[] => [
        { label: sessionLabel(k), enabled: false },
        { label: k === 'sound' ? 'Turn off the microphone' : 'Turn off the camera', click: () => bridge.send({ type: k === 'sound' ? 'sound_session_stop' : 'air_session_stop' }) }
      ]),
      { type: 'separator' },
      {
        label: bridge.paused ? 'Resume' : 'Pause',
        enabled: connected,
        click: () => bridge.send({ type: bridge.paused ? 'resume' : 'pause' })
      },
      { label: 'Open Ghostkeys', click: () => showMain() },
      { type: 'separator' },
      { label: 'Quit Ghostkeys', accelerator: 'Command+Q', click: () => app.quit() }
    ])
  )
}

// ---------------------------------------------------------------- IPC

function broadcastDaemonState(s: DaemonState): void {
  mainWindow?.webContents.send('daemon-state', s)
}

ipcMain.handle('info', (): AppInfo => ({
  port: PORT,
  mock: MOCK,
  screenshot: SCREENSHOT,
  version: app.getVersion(),
  daemon: supervisor.state,
  conn: bridge.state,
  prefs,
  snapshot: bridge.snapshot(),
  packaged: app.isPackaged,
  license: licenseState(prefs.licenseKey, __DEMO_UNLOCK__)
}))

ipcMain.handle('set-license', (_e, key: string | null) => {
  if (key === null || key.trim() === '') {
    prefs = { ...prefs, licenseKey: null }
    savePrefs()
    return { license: licenseState(null, __DEMO_UNLOCK__), error: null }
  }
  const parsed = parseLicense(key)
  if (!parsed.ok) return { license: licenseState(prefs.licenseKey, __DEMO_UNLOCK__), error: parsed.error }
  prefs = { ...prefs, licenseKey: key.trim() }
  savePrefs()
  return { license: licenseState(prefs.licenseKey, __DEMO_UNLOCK__), error: null }
})

ipcMain.handle('pricing', () => {
  for (const p of [join(RES_DIR, 'features.json'), join(APP_ROOT, '../docs/pricing/features.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as unknown
    } catch {
      // try the next place
    }
  }
  return null
})

/** Messages the renderer may relay. approve_action is deliberately missing: only the dialog below sends it. */
const RELAYABLE = new Set<AppMessage['type']>([
  'subscribe',
  'unsubscribe',
  'pause',
  'resume',
  'calibration_start',
  'calibration_zone',
  'calibration_negatives',
  'calibration_finish',
  'calibration_cancel',
  'config_get',
  'config_set',
  'test_action',
  'request_permission',
  'revoke_action',
  'catalog_get',
  'sound_session_start',
  'sound_session_stop',
  'air_session_start',
  'air_session_stop'
])

ipcMain.on('daemon-send', (e, msg: AppMessage) => {
  if (e.sender !== mainWindow?.webContents) return
  if (!msg || typeof msg !== 'object' || !RELAYABLE.has(msg.type)) return
  bridge.send(msg)
})
ipcMain.on('daemon-reconnect', () => bridge.reconnectNow())

/** Replies to approve_action arrive in order on our single connection. */
const approvalWaiters: ((hash: string | null) => void)[] = []

function awaitApproval(): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = approvalWaiters.indexOf(done)
      if (i >= 0) approvalWaiters.splice(i, 1)
      resolve(null)
    }, 4000)
    const done = (h: string | null): void => {
      clearTimeout(timer)
      resolve(h)
    }
    approvalWaiters.push(done)
  })
}

ipcMain.handle('approve', async (e, actions: SimpleAction[], context: string): Promise<(string | null)[] | null> => {
  if (e.sender !== mainWindow?.webContents || !Array.isArray(actions) || actions.length === 0) return null
  const risky = actions.filter((a) => a && APPROVAL_KINDS.includes(a.kind)) as Parameters<typeof approvalPayload>[0][]
  if (!risky.length || !bridge.connected) return null
  const label = (a: SimpleAction): string =>
    a.kind === 'applescript' ? 'AppleScript:\n' : a.kind === 'shell' ? 'Shell command:\n' : ''
  const detail = risky.map((a, i) => `${risky.length > 1 ? `${i + 1}. ` : ''}${label(a)}${approvalText(a)}`).join('\n\n')
  const opts: Electron.MessageBoxOptions = {
    type: 'warning',
    message: risky.length > 1 ? `Allow Ghostkeys to run these ${risky.length} actions?` : 'Allow Ghostkeys to run this action?',
    detail: `${context}\n\n${detail}\n\nIt runs as you, without asking again, whenever the gesture happens. Only allow what you understand. Changing the text asks again.`,
    buttons: ['Cancel', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
  const { response } = mainWindow ? await dialog.showMessageBox(mainWindow, opts) : await dialog.showMessageBox(opts)
  if (response !== 1) return null
  return sendApprovals(risky)
})

/** Only ever called after the user said Allow in the native dialog (or by the self-test, which never shows UI). */
async function sendApprovals(risky: Parameters<typeof approvalPayload>[0][]): Promise<(string | null)[]> {
  const hashes: (string | null)[] = []
  for (const a of risky) {
    const wait = awaitApproval()
    bridge.send({ type: 'approve_action', action: approvalPayload(a) })
    hashes.push(await wait)
  }
  return hashes
}

ipcMain.handle('library', () => loadLibrary(app.isPackaged ? join(process.resourcesPath, 'presets') : join(APP_ROOT, '../presets')))

ipcMain.handle('restart-daemon', async () => {
  await supervisor.restart()
  bridge.reconnectNow()
})

ipcMain.handle('set-prefs', (_e, p: Partial<AppPrefs>) => {
  prefs = { ...prefs, ...p }
  nativeTheme.themeSource = prefs.theme
  savePrefs()
  return prefs
})

// ---------------------------------------------------------------- lifecycle

const gotLock = SCREENSHOT || app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMain())

  void app.whenReady().then(async () => {
    prefs = loadPrefs()
    nativeTheme.themeSource = prefs.theme
    registerNativeIpc(() => mainWindow)
    if (SCREENSHOT) app.dock?.hide()
    if (process.platform === 'darwin' && !app.isPackaged && !SCREENSHOT) {
      app.dock?.setIcon(join(RES_DIR, 'icon.png'))
    }

    supervisor.on('state', (s: DaemonState) => {
      broadcastDaemonState(s)
      bridge.reconnectNow()
    })
    bridge.on('change', refreshTray)
    bridge.on('message', (msg: DaemonMessage) => {
      if (msg.type === 'approved') approvalWaiters.shift()?.(msg.hash)
      else if (msg.type === 'error' && msg.message.startsWith('approve_action')) approvalWaiters.shift()?.(null)
      onDaemonMessage(msg)
      mainWindow?.webContents.send('daemon-message', msg)
    })
    bridge.on('conn', (s: ConnState) => mainWindow?.webContents.send('daemon-conn', s))

    await supervisor.start()
    bridge.start()

    mainWindow = createMainWindow()
    if (SELFTEST) {
      const code = await runSelfTest({ main: mainWindow, bridge, supervisor, sendApprovals, outDir: join(APP_ROOT, 'screenshots') })
      quitting = true
      supervisor.stop()
      setTimeout(() => app.exit(code), 1500)
      return
    }
    if (SCREENSHOT) {
      hudWindow = createHudWindow()
      await runScreenshots({ main: mainWindow, hud: hudWindow, outDir: join(APP_ROOT, 'screenshots'), showHud })
      quitting = true
      app.quit()
      return
    }

    tray = new Tray(trayImage('normal'))
    refreshTray()
  })

  app.on('activate', () => showMain())
  app.on('before-quit', () => {
    quitting = true
    bridge.stop()
    supervisor.stop()
  })
  app.on('window-all-closed', () => {
    if (SCREENSHOT) app.quit()
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      supervisor.stop()
      app.exit(0)
    })
  }
}
