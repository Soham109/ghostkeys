import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, screen, shell, Tray } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DaemonSupervisor } from './daemon'
import { DaemonBridge } from './bridge'
import { runScreenshots } from './screenshots'
import { loadLibrary } from './library'
import { DEFAULT_PORT, GESTURE_LABEL, ZONELESS_GESTURES, type AppMessage, type DaemonMessage, type SimpleAction } from '@shared/protocol'
import { APPROVAL_KINDS, approvalKey, approvalText } from '@shared/approval'
import type { AppInfo, AppPrefs, ConnState, DaemonState, HudPayload } from '@shared/ipc'

const PORT = Number(process.env.GK_PORT ?? DEFAULT_PORT)
const MOCK = process.env.GK_MOCK === '1'
const SCREENSHOT = process.env.SCREENSHOT === '1'
const APP_ROOT = app.getAppPath()
const RES_DIR = app.isPackaged ? process.resourcesPath : join(APP_ROOT, 'resources')

app.setName('Ghostkeys')

// ---------------------------------------------------------------- prefs

const DEFAULT_PREFS: AppPrefs = { theme: 'system', keepInMenuBar: true, showWindowOnLaunch: true, approved: [] }
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

/** Token for a daemon started elsewhere: it writes one to Application Support with mode 0600. */
function externalToken(): string | null {
  const dir = join(homedir(), 'Library', 'Application Support', 'Ghostkeys')
  for (const name of ['token', 'session-token']) {
    try {
      const t = readFileSync(join(dir, name), 'utf8').trim()
      if (t) return t
    } catch {
      // not there
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
    const title = msg.bindingId === 'test' ? 'Test' : (recent ?? 'Ghostkeys')
    showHud(title, msg.ok ? msg.label : `${msg.label} failed`, msg.ok)
  }
}

// ---------------------------------------------------------------- tray

function trayImage(paused = false): Electron.NativeImage {
  const base = paused && existsSync(join(RES_DIR, 'trayPausedTemplate.png')) ? 'trayPausedTemplate' : 'trayTemplate'
  const img = nativeImage.createFromPath(join(RES_DIR, `${base}.png`))
  const img2x = nativeImage.createFromPath(join(RES_DIR, `${base}@2x.png`))
  if (!img2x.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: img2x.toPNG() })
  img.setTemplateImage(true)
  return img
}

function refreshTray(): void {
  if (!tray) return
  const connected = bridge.connected
  const statusLabel = !connected ? 'Service not running' : bridge.paused ? 'Paused' : 'Listening for taps'
  tray.setToolTip(`Ghostkeys: ${statusLabel}`)
  tray.setImage(trayImage(connected && bridge.paused))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
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
  snapshot: bridge.snapshot()
}))

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
  'request_permission'
])

ipcMain.on('daemon-send', (e, msg: AppMessage) => {
  if (e.sender !== mainWindow?.webContents) return
  if (!msg || typeof msg !== 'object' || !RELAYABLE.has(msg.type)) return
  bridge.send(msg)
})
ipcMain.on('daemon-reconnect', () => bridge.reconnectNow())

ipcMain.handle('approve', async (e, actions: SimpleAction[], context: string): Promise<string[] | null> => {
  if (e.sender !== mainWindow?.webContents || !Array.isArray(actions) || actions.length === 0) return null
  const risky = actions.filter((a) => a && APPROVAL_KINDS.includes(a.kind))
  if (!risky.length) return prefs.approved
  const detail = risky
    .map((a, i) => `${risky.length > 1 ? `${i + 1}. ` : ''}${a.kind === 'applescript' ? 'AppleScript' : a.kind === 'shell' ? 'Shell command' : ''}${a.kind === 'applescript' || a.kind === 'shell' ? ':\n' : ''}${approvalText(a)}`)
    .join('\n\n')
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
  for (const a of risky) bridge.send({ type: 'approve_action', action: a })
  const keys = new Set(prefs.approved)
  risky.forEach((a) => keys.add(approvalKey(a)))
  prefs = { ...prefs, approved: [...keys].slice(-500) }
  savePrefs()
  return prefs.approved
})

ipcMain.handle('library', () => loadLibrary(app.isPackaged ? join(process.resourcesPath, 'presets') : join(APP_ROOT, '../presets')))

ipcMain.handle('restart-daemon', async () => {
  await supervisor.restart()
  bridge.reconnectNow()
})

ipcMain.handle('set-prefs', (_e, p: Partial<AppPrefs>) => {
  // approvals only change through the dialog
  const { approved: _ignored, ...rest } = p
  prefs = { ...prefs, ...rest }
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
      onDaemonMessage(msg)
      mainWindow?.webContents.send('daemon-message', msg)
    })
    bridge.on('conn', (s: ConnState) => mainWindow?.webContents.send('daemon-conn', s))

    await supervisor.start()
    bridge.start()

    mainWindow = createMainWindow()
    if (SCREENSHOT) {
      hudWindow = createHudWindow()
      await runScreenshots({ main: mainWindow, hud: hudWindow, outDir: join(APP_ROOT, 'screenshots'), showHud })
      quitting = true
      app.quit()
      return
    }

    tray = new Tray(trayImage())
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
