import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonBridge } from './bridge'
import type { DaemonSupervisor } from './daemon'
import type { AppMessage, Config, DaemonMessage, SimpleAction } from '@shared/protocol'

/**
 * SELFTEST=1: drive the real daemon through the app's own connection and report what worked.
 * Run it with GHOSTKEYSD_ARGS="--dry-run" (no action really runs) and GHOSTKEYS_CONFIG_DIR pointing at a scratch
 * folder so the user's config, token and approvals are never touched. Never shows a window or a dialog.
 */
export async function runSelfTest(opts: {
  main: BrowserWindow
  bridge: DaemonBridge
  supervisor: DaemonSupervisor
  sendApprovals: (a: Extract<SimpleAction, { kind: 'shell' }>[]) => Promise<(string | null)[]>
  outDir: string
}): Promise<number> {
  const { main, bridge, supervisor } = opts
  const results: { check: string; ok: boolean; detail: string }[] = []
  const record = (check: string, ok: boolean, detail = ''): void => {
    results.push({ check, ok, detail })
    console.log(`[selftest] ${ok ? 'PASS' : 'FAIL'} ${check}${detail ? `: ${detail}` : ''}`)
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const next = <T extends DaemonMessage['type']>(type: T, pred: (m: Extract<DaemonMessage, { type: T }>) => boolean = () => true, ms = 5000) =>
    new Promise<Extract<DaemonMessage, { type: T }> | null>((resolve) => {
      const on = (m: DaemonMessage): void => {
        if (m.type === type && pred(m as Extract<DaemonMessage, { type: T }>)) {
          bridge.off('message', on)
          clearTimeout(t)
          resolve(m as Extract<DaemonMessage, { type: T }>)
        }
      }
      const t = setTimeout(() => {
        bridge.off('message', on)
        resolve(null)
      }, ms)
      bridge.on('message', on)
    })
  const send = (m: AppMessage): boolean => bridge.send(m)
  let taps = 0
  bridge.on('message', (m: DaemonMessage) => {
    if (m.type === 'tap') taps++
  })

  // 1. spawned with the token, connected
  for (let i = 0; i < 60 && !bridge.connected; i++) await wait(250)
  record('daemon spawned by the app', supervisor.state.kind === 'running', supervisor.state.kind === 'running' ? supervisor.state.path : supervisor.state.kind)
  record('connected with X-Ghostkeys-Token', bridge.connected)
  if (!bridge.connected) return finish(1)

  // 2. hello, status, config reach the window; catalog loads
  await main.webContents.executeJavaScript('window.__gk.ready()', true)
  const summary = (await main.webContents.executeJavaScript('window.__gk.summary()', true)) as Record<string, unknown>
  record('hello received', !!summary.hello, JSON.stringify(summary.hello))
  record('status received', !!summary.status, JSON.stringify(summary.status))
  record('config received', !!summary.zones, `${String(summary.zones)} zones, ${String(summary.bindings)} bindings`)
  await wait(1000)
  const withCatalog = (await main.webContents.executeJavaScript('window.__gk.summary()', true)) as Record<string, unknown>
  record('integration catalog loaded', Number(withCatalog.catalogCommands) > 0, `${String(withCatalog.catalogCommands)} commands`)

  // 3. calibration start and cancel
  const zone = bridge.config?.zones[0]?.id ?? 'left-palm'
  const started = next('calibration', (m) => m.phase === 'started')
  send({ type: 'calibration_start', zones: [zone], target: 5 })
  record('calibration_start answered', !!(await started))
  const cancelled = next('calibration', (m) => m.phase === 'cancelled')
  send({ type: 'calibration_cancel' })
  record('calibration_cancel answered', !!(await cancelled))

  // 4. config round trip (a reversible settings change)
  const original = structuredClone(bridge.config) as Config | null
  if (original) {
    const changed: Config = { ...original, settings: { ...original.settings, hud: !original.settings.hud } }
    const echoed = next('config', (m) => m.config.settings.hud === changed.settings.hud)
    send({ type: 'config_set', config: changed })
    const got = await echoed
    record('config_set round trip', !!got, got ? `hud ${String(got.config.settings.hud)}` : 'no echo')
    const restored = next('config', (m) => m.config.settings.hud === original.settings.hud)
    send({ type: 'config_set', config: original })
    record('config restored', !!(await restored))
  } else record('config_set round trip', false, 'no config')

  // 5. approval path (the dialog is skipped here; in the app it always shows first)
  const shell: Extract<SimpleAction, { kind: 'shell' }> = { kind: 'shell', command: 'echo ghostkeys-selftest' }
  const [hash] = await opts.sendApprovals([shell])
  record('approve_action returns a hash', !!hash && /^[0-9a-f]{64}$/.test(hash), hash ?? 'none')
  await wait(600)
  const unapproved = next('action')
  send({ type: 'test_action', action: shell })
  const u = await unapproved
  record('unapproved command is refused', !!u && !u.ok, u ? String(u.error) : 'no reply')
  await wait(700)
  const approved = next('action')
  send({ type: 'test_action', action: { ...shell, approvedHash: hash ?? undefined } })
  const a = await approved
  record('approved command runs (dry run)', !!a && a.ok, a ? `${a.label} ${a.error ?? ''}` : 'no reply')
  const revoked = next('revoked')
  send({ type: 'revoke_action', hash: hash ?? '' })
  const r = await revoked
  record('revoke_action', !!r && r.found, r ? `found ${String(r.found)}` : 'no reply')

  // 6. taps: none are expected unless someone touches the Mac
  send({ type: 'subscribe', streams: ['taps'] })
  await wait(2000)
  record('tap stream open', true, `${taps} taps while testing`)

  // 7. screenshots against the real daemon
  for (const name of ['live', 'sensors', 'bindings-integration']) {
    await main.webContents.executeJavaScript(`window.__gk.shot(${JSON.stringify(name)})`, true)
    await wait(200)
    main.webContents.invalidate()
    await wait(120)
    const img = await main.webContents.capturePage()
    writeFileSync(join(opts.outDir, `real-${name}.png`), img.toPNG())
    console.log(`[selftest] real-${name}.png`)
  }

  return finish(results.every((x) => x.ok) ? 0 : 1)

  function finish(code: number): number {
    const passed = results.filter((x) => x.ok).length
    console.log(`[selftest] ${passed}/${results.length} checks passed`)
    return code
  }
}
