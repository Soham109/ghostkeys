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
  'live-feed-enter',
  'first-launch-draw',
  'command-palette',
  'service-offline',
  'hands',
  'guide',
  'guide-light',
  'guide-camera',
  'guide-motion',
  'guide-sonar',
  'demo-editor',
  'demo-picker',
  'demo-library',
  'onboarding-gestures',
  'demo-frames',
  'calibration-merged',
  'live-feedback',
  'zones-disabled',
  'settings-advanced',
  'sensors-log',
  'settings-sonar',
  'sensors-sonar',
  'bindings-hover',
  'bindings-needs',
  'binding-needs-editor',
  'live-needs'
] as const

/** Shots captured mid-animation: grab the frame right away. */
const MID_ANIMATION = new Set<string>(['live-feed-enter'])

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
      const mid = MID_ANIMATION.has(name)
      await wait(mid ? 70 : 120)
      main.webContents.invalidate()
      await wait(mid ? 30 : 120)
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
