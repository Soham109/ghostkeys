import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } from 'electron'
import { execFile } from 'node:child_process'
import type { ContextItem, MenuCommand } from '@shared/ipc'

// ---------------------------------------------------------------- app icons (NSWorkspace, via Spotlight + getFileIcon)

const iconCache = new Map<string, string | null>()

function appPath(bundleId: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) return resolve(null)
    execFile('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null)
      const first = stdout.split('\n').find((l) => l.endsWith('.app'))
      resolve(first ?? null)
    })
  })
}

export interface FeedbackHooks {
  missed: () => void
  falseTap: () => void
  shortcuts: () => { missed: string; falseTap: string }
}

export function registerNativeIpc(getMain: () => BrowserWindow | null, fb: FeedbackHooks): void {
  buildMenu(getMain, fb)
  registerIpcOnce(getMain)
}

let ipcDone = false
function registerIpcOnce(_getMain: () => BrowserWindow | null): void {
  if (ipcDone) return
  ipcDone = true
  ipcMain.handle('app-icon', async (_e, bundleId: string) => {
    if (iconCache.has(bundleId)) return iconCache.get(bundleId)
    let url: string | null = null
    try {
      const p = await appPath(bundleId)
      if (p) {
        // QuickLook gives the real app icon; getFileIcon can return the generic bundle icon for some apps.
        let img = await nativeImage.createThumbnailFromPath(p, { width: 64, height: 64 }).catch(() => null)
        if (!img || img.isEmpty()) img = await app.getFileIcon(p, { size: 'normal' })
        url = img.resize({ width: 32, height: 32 }).toDataURL()
      }
    } catch {
      url = null
    }
    iconCache.set(bundleId, url)
    return url
  })

  ipcMain.handle('context-menu', (e, items: ContextItem[]) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null
      const menu = Menu.buildFromTemplate(
        items.map((it) =>
          it.type === 'separator'
            ? { type: 'separator' as const }
            : { label: it.label ?? '', enabled: it.enabled !== false, accelerator: it.accelerator, click: () => (chosen = it.id ?? null) }
        )
      )
      menu.popup({ window: win ?? undefined, callback: () => setTimeout(() => resolve(chosen), 0) })
    })
  })

}

/** The native menu bar. Rebuilt when the feedback shortcuts change. */
export function buildMenu(getMain: () => BrowserWindow | null, fb: FeedbackHooks): void {
  const sc = fb.shortcuts()
  const send = (cmd: MenuCommand) => () => {
    const w = getMain()
    if (!w) return
    w.show()
    w.webContents.send('menu', cmd)
  }
  const go = (route: string, label: string, n: number): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator: `CommandOrControl+${n}`,
    click: send(`go:${route}`)
  })
  const dev = !app.isPackaged
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CommandOrControl+,', click: send('go:settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Binding', accelerator: 'CommandOrControl+N', click: send('new-binding') },
        { label: 'Action Library', accelerator: 'CommandOrControl+Shift+L', click: send('library') },
        { type: 'separator' },
        { label: 'Save Changes', accelerator: 'CommandOrControl+S', click: send('save') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        go('live', 'Live', 1),
        go('zones', 'Zones', 2),
        go('bindings', 'Gestures and Actions', 3),
        go('calibration', 'Calibration', 4),
        go('sensors', 'Sensors', 5),
        go('settings', 'Settings', 6),
        go('guide', 'Gesture Guide', 7),
        { type: 'separator' },
        { label: 'Search and Commands', accelerator: 'CommandOrControl+K', click: send('palette') },
        { label: 'Pause or Resume Ghostkeys', accelerator: 'CommandOrControl+Shift+P', click: send('pause-toggle') },
        { type: 'separator' },
        { label: 'Missed a Tap', accelerator: sc.missed, registerAccelerator: false, click: () => fb.missed() },
        { label: 'That Wasn\u2019t Me', accelerator: sc.falseTap, registerAccelerator: false, click: () => fb.falseTap() },
        ...(dev ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as Electron.MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Gesture Guide', click: send('go:guide') },
        { label: 'Welcome Tour', click: send('tour') },
        { label: 'Privacy and Safety', click: send('go:settings') },
        ...(dev ? [{ label: 'Open the Guide Folder', click: () => void shell.openPath(`${app.getAppPath()}/../docs/guide`) }] : [])
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
