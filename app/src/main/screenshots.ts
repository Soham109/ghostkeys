import type { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Named states the renderer knows how to set up (see renderer/src/lib/shots.ts). */
export const SHOTS = [
  'onboarding-1-welcome',
  'onboarding-2-device',
  'onboarding-3-accessibility',
  'onboarding-4-calibrate',
  'live',
  'live-light',
  'zones',
  'zones-light',
  'bindings',
  'bindings-editor',
  'bindings-presets',
  'bindings-macro',
  'calibration-1-pick',
  'calibration-2-capture',
  'calibration-3-negatives',
  'calibration-4-results',
  'sensors',
  'sensors-light',
  'settings',
  'settings-sessions',
  'settings-license',
  'bindings-integration',
  'bindings-pinch',
  'live-notices',
  'live-session',
  'library-layouts',
  'command-palette',
  'service-offline'
] as const

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitForLoad(win: BrowserWindow): Promise<void> {
  if (!win.webContents.isLoading()) return
  await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
}

/**
 * Drives the offscreen windows through every screen and writes PNGs. Nothing is shown on the
 * user's display: both windows render offscreen and are captured with webContents.capturePage.
 */
export async function runScreenshots(opts: {
  main: BrowserWindow
  hud: BrowserWindow
  outDir: string
  showHud: (title: string, detail: string | null, ok?: boolean) => void
}): Promise<void> {
  const { main, hud, outDir } = opts
  mkdirSync(outDir, { recursive: true })
  const only = process.env.SHOTS?.split(',').filter(Boolean)
  await waitForLoad(main)
  await main.webContents.executeJavaScript('window.__gk.ready()', true)
  await wait(800)

  for (const name of SHOTS) {
    if (only && !only.includes(name)) continue
    try {
      await main.webContents.executeJavaScript(`window.__gk.shot(${JSON.stringify(name)})`, true)
      await wait(120)
      main.webContents.invalidate()
      await wait(120)
      const img = await main.webContents.capturePage()
      writeFileSync(join(outDir, `${name}.png`), img.toPNG())
      console.log(`[screenshots] ${name}.png`)
    } catch (e) {
      console.error(`[screenshots] ${name} failed:`, e)
    }
  }

  if (!only || only.includes('hud')) {
    await waitForLoad(hud)
    await wait(300)
    opts.showHud('Right palm rest', 'Play or pause')
    await wait(450)
    hud.webContents.invalidate()
    await wait(100)
    const img = await hud.webContents.capturePage()
    writeFileSync(join(outDir, 'hud.png'), img.toPNG())
    console.log('[screenshots] hud.png')
  }
}
