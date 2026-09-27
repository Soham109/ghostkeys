// Verify driver: runs INSIDE the Electron main process (GK_VERIFY_DRIVER, dev builds only), against a simulated
// ghostkeysd started by verify-app.mjs. It drives the real UI (clicks, keyboard), injects sensor events through the
// daemon's test hooks (sim_spike, sim_tap, sim_sonar), and checks what the user would see.
// Writes screenshots to app/screenshots/verify/ and a JSON result file next to them.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export default async function run(ctx) {
  const { main, bridge, dialog } = ctx
  const outDir = join(ctx.outDir, 'verify')
  mkdirSync(outDir, { recursive: true })
  const results = []
  const notes = []
  const a11y = {}
  const record = (area, check, ok, detail = '') => {
    results.push({ area, check, ok, detail: String(detail) })
    console.log(`[verify] ${ok === null ? 'N/A ' : ok ? 'PASS' : 'FAIL'} ${area}: ${check}${detail ? ` -- ${detail}` : ''}`)
  }
  const note = (s) => {
    notes.push(s)
    console.log(`[verify] note: ${s}`)
  }

  // ------------------------------------------------------------ helpers
  const js = (code) => main.webContents.executeJavaScript(code, true)
  const S = (expr) => js(`(() => { const st = window.__gk.stores; return ${expr} })()`)
  const bodyText = () => js('document.body.innerText')
  const daemon = (m) => bridge.send(m)
  const msgs = []
  bridge.on('message', (m) => msgs.push({ at: Date.now(), m }))
  const since = (t, type) => msgs.filter((x) => x.at >= t && (!type || x.m.type === type)).map((x) => x.m)
  const next = (type, pred = () => true, ms = 5000) =>
    new Promise((resolve) => {
      const on = (m) => {
        if (m.type === type && pred(m)) {
          bridge.off('message', on)
          clearTimeout(t)
          resolve(m)
        }
      }
      const t = setTimeout(() => {
        bridge.off('message', on)
        resolve(null)
      }, ms)
      bridge.on('message', on)
    })
  const waitFor = async (fn, ms = 8000, step = 150) => {
    const end = Date.now() + ms
    for (;;) {
      const v = await fn()
      if (v) return v
      if (Date.now() > end) return null
      await sleep(step)
    }
  }
  const waitText = (s, ms = 8000) => waitFor(async () => ((await bodyText()).includes(s) ? true : null), ms)
  /** Click the first visible button (or [role=button]/[role=radio]/[role=tab]) whose text matches. */
  const click = (text, exact = false) =>
    js(`(() => {
      const want = ${JSON.stringify(text)}
      const els = [...document.querySelectorAll('button, [role=button], [role=radio], [role=tab], [role=menuitem], a')]
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }
      const el = els.find((e) => vis(e) && (${exact} ? e.textContent.trim() === want : e.textContent.trim().includes(want)))
      if (!el) return false
      if (el.disabled) return 'disabled'
      el.click()
      return true
    })()`)
  const buttons = () =>
    js(`[...document.querySelectorAll('button')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' }).map((e) => e.textContent.trim() || e.getAttribute('aria-label') || '(unnamed)')`)
  let shotN = 0
  const shot = async (name) => {
    await sleep(250)
    main.webContents.invalidate()
    await sleep(150)
    const img = await main.webContents.capturePage()
    const file = `${String(++shotN).padStart(2, '0')}-${name}.png`
    writeFileSync(join(outDir, file), img.toPNG())
    console.log(`[verify] shot ${file}`)
  }
  // An offscreen window never has OS focus, so :focus-visible would never match: emulate a focused page.
  let focusEmulated = false
  const key = async (keyCode, modifiers = []) => {
    main.webContents.focus()
    if (!focusEmulated) {
      focusEmulated = true
      try {
        main.webContents.debugger.attach('1.3')
        await main.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
      } catch (e) {
        note(`focus emulation unavailable: ${e.message}`)
      }
    }
    main.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode.length === 1 || keyCode === 'Return') main.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : keyCode, modifiers })
    main.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(80)
  }
  const focused = () =>
    js(`(() => { const e = document.activeElement; if (!e || e === document.body) return null; const cs = getComputedStyle(e); return { tag: e.tagName, text: (e.textContent || '').trim().slice(0, 60), label: e.getAttribute('aria-label'), ring: e.matches(':focus-visible') && (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 || (cs.boxShadow && cs.boxShadow !== 'none')) } })()`)
  /** Tab through the page; returns the focus order (up to n stops). */
  const tabOrder = async (n = 25) => {
    await js('document.activeElement && document.activeElement.blur && document.activeElement.blur()')
    const out = []
    for (let i = 0; i < n; i++) {
      await key('Tab')
      const f = await focused()
      if (!f) {
        out.push('(nothing)')
        continue
      }
      const name = f.label || f.text || f.tag
      if (out.length && out[0] === name && i > 2) break
      out.push(`${name}${f.ring ? '' : ' [NO VISIBLE FOCUS]'}`)
    }
    return out
  }
  /** Static accessibility audit of what is on screen now. */
  const audit = (label) =>
    js(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 }
      const issues = []
      for (const b of document.querySelectorAll('button, [role=button], a, input, textarea, select, [role=radio], [role=switch], [role=slider], [role=tab]')) {
        if (!vis(b)) continue
        const name = (b.getAttribute('aria-label') || b.getAttribute('aria-labelledby') && document.getElementById(b.getAttribute('aria-labelledby'))?.textContent || b.textContent || b.getAttribute('title') || b.getAttribute('placeholder') || '').trim()
        const lab = b.id && document.querySelector('label[for="' + b.id + '"]')
        if (!name && !lab) issues.push('no accessible name: <' + b.tagName.toLowerCase() + ' class="' + (b.className || '').toString().slice(0, 50) + '">')
      }
      for (const s of document.querySelectorAll('svg')) {
        if (!vis(s)) continue
        const r = s.getBoundingClientRect()
        if (r.width < 60) continue
        if (!s.getAttribute('aria-label') && !s.getAttribute('aria-hidden') && !s.closest('[aria-hidden=true]') && !s.querySelector('title')) issues.push('large svg without label or aria-hidden (' + Math.round(r.width) + 'x' + Math.round(r.height) + ')')
      }
      // Contrast of visible text against the nearest opaque background.
      const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) { const o = c.match(/oklch|color\\(/); return null } const p = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 } }
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b) }
      const bgOf = (e) => { for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0.9) return c } return parse(getComputedStyle(document.body).backgroundColor) || { r: 10, g: 10, b: 11, a: 1 } }
      const low = new Map()
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      let unparsed = 0
      while (walker.nextNode()) {
        const t = walker.currentNode
        const txt = t.textContent.trim()
        if (!txt || txt.length < 2) continue
        const e = t.parentElement
        if (!e || !vis(e) || e.closest('[aria-hidden=true]') || e.closest('svg')) continue
        const cs = getComputedStyle(e)
        let fg = parse(cs.color)
        if (!fg) { unparsed++; continue }
        const bg = bgOf(e)
        const op = parseFloat(cs.opacity) * (fg.a ?? 1)
        fg = { r: fg.r * op + bg.r * (1 - op), g: fg.g * op + bg.g * (1 - op), b: fg.b * op + bg.b * (1 - op) }
        const L1 = lum(fg), L2 = lum(bg)
        const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
        const size = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight) >= 700
        const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5
        if (ratio < need) { const k = txt.slice(0, 40) + ' (' + ratio.toFixed(2) + ':1, ' + size + 'px)'; if (!low.has(k)) low.set(k, 1) }
      }
      return { issues: [...new Set(issues)], lowContrast: [...low.keys()].slice(0, 25), lowContrastCount: low.size, unparsedColors: unparsed }
    })()`).then((r) => {
      a11y[label] = r
      return r
    })
  // Toasts are never removed from the DOM here (React owns them); instead, only toasts new since the last mark count.
  let toastMark = new Set()
  const allToasts = () => js(`[...document.querySelectorAll('[data-sonner-toast]')].map((t) => (t.dataset.gkId ||= Math.random().toString(36).slice(2)) + '\\u0000' + t.innerText.replace(/\\n+/g, ' | '))`)
  const toasts = async () => (await allToasts()).filter((x) => !toastMark.has(x.split('\u0000')[0])).map((x) => x.split('\u0000')[1])
  const clearToasts = async () => {
    toastMark = new Set((await allToasts()).map((x) => x.split('\u0000')[0]))
  }
  const cfg = () => bridge.config
  const spike = () => daemon({ type: 'sim_spike', live: true })

  // ------------------------------------------------------------ 0. startup
  for (let i = 0; i < 60 && !bridge.connected; i++) await sleep(250)
  record('startup', 'app connected to the simulated daemon', bridge.connected)
  if (!bridge.connected) return finish()
  await js('window.__gk.ready()')
  await sleep(1200)
  const hello = await S('st.useStore.getState().hello')
  record('startup', 'hello received', !!hello, hello ? `${hello.device.family}, accessibility=${hello.permissions.accessibility}` : '')
  record('startup', 'fresh profile opens onboarding', await S('st.useStore.getState().onboarding'))

  // ------------------------------------------------------------ 1. onboarding
  await sleep(1400)
  await shot('onboarding-1-welcome')
  await audit('onboarding-1-welcome')
  // Keyboard: can Tab reach "Get started" and does Enter activate it?
  const order0 = await tabOrder(8)
  a11y['onboarding-1-welcome'].tabOrder = order0
  record('a11y', 'onboarding step 1: Tab reaches "Get started"', order0.some((x) => x.startsWith('Get started')), order0.join(' > '))
  // focus it and press Enter
  await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Get started')?.focus()`)
  await shot('onboarding-1-focus-ring')
  await key('Return')
  await sleep(500)
  let step = await S('st.useStore.getState().onboardingStep')
  record('a11y', 'Enter on focused "Get started" advances', step === 1, `step=${step}`)
  if (step !== 1) await click('Get started', true)

  await waitText('OK', 4000)
  await sleep(900)
  await shot('onboarding-2-device')
  await audit('onboarding-2-device')
  const devText = await bodyText()
  record('onboarding', 'step 2 lists this Mac and its sensors', /Motion sensor/.test(devText), devText.match(/MacBook[^\n]*/)?.[0] ?? '')
  await click('Continue', true)
  await sleep(700)

  const acc = !!hello?.permissions.accessibility
  await shot('onboarding-3-accessibility')
  await audit('onboarding-3-accessibility')
  const b3 = await buttons()
  record('onboarding', 'step 3 offers a way on without Accessibility', acc || b3.includes('Continue without it'), b3.join(', '))
  // Never click "Allow Accessibility": it would raise a real macOS prompt on the user's screen.
  await click(acc ? 'Continue' : 'Continue without it', true)
  await sleep(700)

  // Step 4: quick calibration of the palm rests with live synthetic taps.
  await shot('onboarding-4-quick-intro')
  await audit('onboarding-4-quick-intro')
  record('onboarding', 'step 4 shows "Teach it your palm rests"', (await bodyText()).includes('Teach it your palm rests'))
  const t4 = Date.now()
  await click('Start', true)
  await sleep(600)
  const qzones = await S('st.useQuickCal.getState().zones')
  record('onboarding', 'quick calibration starts on the two palm rests', JSON.stringify(qzones) === JSON.stringify(['left-palm', 'right-palm']), JSON.stringify(qzones))
  let spikes = 0
  let midShot = false
  const quickDeadline = Date.now() + 90_000
  while (Date.now() < quickDeadline) {
    const q = await S('st.useQuickCal.getState()')
    if (q.phase !== 'capture') break
    spike()
    spikes++
    await sleep(650)
    if (!midShot && (q.counts[q.zones[0]] ?? 0) >= 4) {
      midShot = true
      await shot('onboarding-4-quick-capture')
      await audit('onboarding-4-quick-capture')
    }
  }
  const qAfter = await S('st.useQuickCal.getState()')
  record('onboarding', 'palm-rest taps are counted and it moves to typing', qAfter.phase === 'typing' || qAfter.phase === 'training' || qAfter.phase === 'done', `${spikes} spikes, counts ${JSON.stringify(qAfter.counts)}, phase ${qAfter.phase}`)
  await shot('onboarding-4-quick-typing')
  await audit('onboarding-4-quick-typing')
  const qDone = await waitFor(async () => ((await S('st.useQuickCal.getState().phase')) === 'done' ? true : null), 60_000, 500)
  const q2 = await S('st.useQuickCal.getState()')
  const doneMsg = since(t4, 'calibration').find((m) => m.phase === 'done')
  record('onboarding', 'quick calibration trains and says it is ready', !!qDone, `overall ${q2.overall}; daemon done=${!!doneMsg}`)
  await shot('onboarding-4-quick-done')
  const doneText = await bodyText()
  if (/recognised 0%|recognised \d%/.test(doneText)) note(`Quick calibration end screen: "${doneText.match(/Ghostkeys recognised[^.]*\./)?.[0]}" (synthetic taps are identical, so a low score is expected here; but the copy still says "ready" and "Let's try one for real" whatever the score).`)
  await click('Try it', true)
  await sleep(900)

  // Step 5: first real gesture.
  await shot('onboarding-5-first-gesture')
  await audit('onboarding-5-first-gesture')
  const first = cfg()?.bindings.find((b) => b.id === 'first' || (b.gesture === 'double' && b.zone === 'right-palm'))
  record('onboarding', 'a harmless double-tap binding exists for the first try', !!first, first ? `${first.gesture} ${first.zone} -> ${first.label ?? first.action.kind}` : 'missing')
  const t5 = Date.now()
  // Two live taps 250 ms apart: the gesture grammar should make a double tap.
  let success = false
  for (let attempt = 0; attempt < 4 && !success; attempt++) {
    spike()
    await sleep(260)
    spike()
    await sleep(1600)
    success = (await bodyText()).includes('That’s it.')
  }
  const rej5 = since(t5, 'rejected')
  const ges5 = since(t5, 'gesture')
  const act5 = since(t5, 'action')
  note(`First gesture with the 2-zone quick model: gestures ${JSON.stringify(ges5.map((g) => `${g.gesture}@${g.zone}`))}, rejections ${JSON.stringify(rej5.map((r) => `${r.reason}${r.zone ? '@' + r.zone : ''}${r.confidence !== undefined ? ' ' + r.confidence : ''}`))}, actions ${JSON.stringify(act5.map((a) => `${a.label} ok=${a.ok}`))}`)
  if (success) {
    record('onboarding', 'double tap on the palm rest fires and the step says "That’s it."', true)
    await shot('onboarding-5-success')
  } else {
    record('onboarding', 'double tap success path (2-zone model, identical synthetic taps)', null, 'not reachable in simulation: see notes')
    // Wait for the "taking a while" helper (20 s after the step opened).
    await waitFor(async () => ((await buttons()).includes('Open the Tap test') ? true : null), 25_000, 500)
    const helpText = await bodyText()
    const sentence = helpText.split('\n').find((l) => /tap|Ghostkeys/.test(l) && l.length > 60 && !l.startsWith('Two quick')) ?? ''
    record('onboarding', 'after 20 s the step explains why nothing happened, with a way out', (await buttons()).includes('Open the Tap test'), sentence)
    await shot('onboarding-5-why')
    await audit('onboarding-5-why')
  }
  await click(success ? 'Finish' : 'Skip for now', true)
  await sleep(900)
  record('onboarding', 'finishing lands on the Live page', (await S('st.useStore.getState().onboarding')) === false && (await S('st.useStore.getState().route')) === 'live')
  await shot('live-after-onboarding')
  await audit('live')
  a11y.live.tabOrder = await tabOrder(30)

  // ------------------------------------------------------------ 1b. success path with a one-zone model
  // Identical synthetic taps cannot tell two zones apart, so prove the gesture path with one zone.
  {
    const c0 = structuredClone(cfg())
    const only = { ...c0, zones: c0.zones.map((z) => ({ ...z, enabled: z.id === 'right-palm' })) }
    daemon({ type: 'config_set', config: only })
    await next('config', () => true, 3000)
    daemon({ type: 'calibration_start', zones: ['right-palm'], target: 8 })
    await sleep(200)
    daemon({ type: 'calibration_zone', zone: 'right-palm' })
    for (let i = 0; i < 12; i++) {
      spike()
      await sleep(600)
      const c = since(Date.now() - 700, 'calibration').pop()
      if (c && c.count >= 8) break
    }
    daemon({ type: 'calibration_negatives', seconds: 2 })
    await next('calibration', (m) => m.phase === 'negatives' && m.secondsLeft <= 0, 6000)
    daemon({ type: 'calibration_finish' })
    const d = await next('calibration', (m) => m.phase === 'done', 30000)
    const tS = Date.now()
    let fired = null
    for (let attempt = 0; attempt < 5 && !fired; attempt++) {
      spike()
      await sleep(260)
      spike()
      fired = await next('action', () => true, 1800)
    }
    const g = since(tS, 'gesture').map((x) => `${x.gesture}@${x.zone}`)
    const rj = since(tS, 'rejected').map((x) => `${x.reason}${x.confidence !== undefined ? ' ' + x.confidence : ''}`)
    record('gesture', 'one-zone model: two live taps make a double tap that runs play/pause (dry run)', !!fired && fired.ok, `done=${!!d}; gestures ${JSON.stringify(g)}; rejected ${JSON.stringify(rj)}; action ${fired ? `${fired.label} ok=${fired.ok}` : 'none'}`)
    // Put both palm rests back for the rest of the run (and re-teach them so low-confidence rejections happen).
    daemon({ type: 'config_set', config: { ...cfg(), zones: c0.zones } })
    await next('config', () => true, 3000)
  }

  // ------------------------------------------------------------ 2. Why didn't that work?
  const openWhy = async () => {
    const open = await js(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Why didn'))?.getAttribute('aria-expanded')`)
    if (open === 'true') {
      await click('Why didn')
      await sleep(350)
    }
    await click('Why didn')
    await sleep(500)
    const t = await bodyText()
    const i = t.indexOf('Why didn')
    return t.slice(i, i + 400).split('\n').slice(1).join(' ').trim()
  }
  await S('st.useStore.getState().navigate("live")')
  await sleep(600)
  record('why', 'the Live page shows "Why didn’t that work?"', (await bodyText()).includes('Why didn'))

  // paused (real daemon: pause, then a tap)
  {
    daemon({ type: 'pause' })
    await next('status', (m) => m.paused, 3000)
    daemon({ type: 'sim_tap', zone: 'right-palm' })
    const r = await next('rejected', (m) => m.reason === 'paused', 3000)
    record('why', 'daemon reports a paused rejection', !!r)
    const txt = await openWhy()
    const btn = await buttons()
    record('why', 'paused: plain sentence + "Resume"', /paused/i.test(txt) && btn.includes('Resume'), txt.slice(0, 160))
    await shot('why-paused')
    await audit('why-open')
    await click('Resume', true)
    const st = await next('status', (m) => !m.paused, 3000)
    record('why', 'paused: "Resume" really resumes the daemon', !!st)
  }

  // low_confidence (real daemon: the two palm rests learned identical taps)
  {
    // Re-teach both palms so the model is two-zone again.
    daemon({ type: 'calibration_start', zones: ['left-palm', 'right-palm'], target: 6 })
    await sleep(200)
    for (const z of ['left-palm', 'right-palm']) {
      daemon({ type: 'calibration_zone', zone: z })
      for (let i = 0; i < 9; i++) {
        spike()
        await sleep(600)
        const c = since(Date.now() - 700, 'calibration').pop()
        if (c && c.zone === z && c.count >= 6) break
      }
    }
    daemon({ type: 'calibration_negatives', seconds: 2 })
    await next('calibration', (m) => m.phase === 'negatives' && m.secondsLeft <= 0, 6000)
    daemon({ type: 'calibration_finish' })
    await next('calibration', (m) => m.phase === 'done', 30000)
    await sleep(500)
    let r = null
    for (let i = 0; i < 4 && !r; i++) {
      spike()
      r = await next('rejected', (m) => m.reason === 'low_confidence', 2000)
    }
    record('why', 'daemon reports a low_confidence rejection with a zone guess', !!r && !!r.zone, r ? `${r.zone} ${r.confidence}` : 'none')
    const txt = await openWhy()
    const btn = await buttons()
    const teach = btn.find((b) => b.startsWith('Where did you tap'))
    record('why', 'low confidence: plain sentence and asks "Where did you tap?" instead of trusting the guess', !!teach && /couldn.t tell/.test(txt), `${txt.slice(0, 180)} [${teach ?? 'no button'}]`)
    await shot('why-low-confidence')
    await sleep(900) // feedback_missed wants the tap 0.7 to 5 s old
    await clearToasts()
    await click('Where did you tap?')
    await sleep(300)
    const zoneName = cfg().zones.find((z) => z.id === r?.zone)?.name ?? cfg().zones.find((z) => z.enabled !== false)?.name
    await click(zoneName, true)
    const fb = await next('feedback', () => true, 6000)
    await sleep(500)
    const tt = await toasts()
    record('why', 'low confidence: picking the zone sends feedback_missed and the daemon answers', !!fb, fb ? `found=${fb.found} retrained=${fb.retrained} reason=${fb.reason ?? ''}; toast: ${tt.join(' / ')}` : 'no reply')
    await shot('why-teach-toast')
  }

  // burst (try: several live taps in quick succession)
  {
    const tb = Date.now()
    for (let i = 0; i < 5; i++) {
      spike()
      await sleep(90)
    }
    await sleep(1200)
    const reasons = since(tb, 'rejected').map((m) => m.reason)
    const taps = since(tb, 'tap').length
    const r = reasons.includes('burst')
    record('why', 'daemon reports a burst rejection for rapid taps', r ? true : null, `reasons ${JSON.stringify(reasons)}, taps ${taps}`)
    if (r) {
      const txt = await openWhy()
      record('why', 'burst: plain sentence', /knocked|bumps/.test(txt), txt.slice(0, 160))
    }
  }

  // typing, trackpad, motion, burst: the simulated daemon cannot produce these without real keyboard/trackpad
  // input or motion, so the daemon-shaped message is fed into the renderer as if it had arrived.
  for (const reason of ['typing', 'trackpad', 'motion', 'burst']) {
    await js(`window.__gk.stores.client.inject({ type: 'rejected', t: 0, reason: ${JSON.stringify(reason)}, zone: 'right-palm', confidence: 0.9, strength: 0.4 })`)
    await sleep(150)
    const txt = await openWhy()
    const btn = await buttons()
    record('why', `${reason} (injected in the app): one plain sentence${reason === 'typing' ? ' + "Shorten typing pause"' : ''}`, txt.length > 30 && (reason !== 'typing' || btn.includes('Shorten typing pause')), txt.slice(0, 170))
    if (reason === 'typing') {
      await shot('why-typing')
      const before = cfg().settings.typingGateMs
      await click('Shorten typing pause', true)
      const c = await next('config', (m) => m.config.settings.typingGateMs !== before, 3000)
      record('why', 'typing: "Shorten typing pause" really lowers the daemon setting', !!c, c ? `${before} -> ${c.config.settings.typingGateMs} ms` : `still ${before}`)
    }
  }
  // no rejection in the last 30 s
  {
    await sleep(31_000)
    const txt = await openWhy()
    const btn = await buttons()
    record('why', 'nothing felt: sentence + "Raise sensitivity"', btn.includes('Raise sensitivity'), txt.slice(0, 160))
    await shot('why-nothing-felt')
    const before = cfg().settings.sensitivity
    await click('Raise sensitivity', true)
    const c = await next('config', (m) => m.config.settings.sensitivity !== before, 3000)
    record('why', '"Raise sensitivity" really raises it in the daemon', !!c, c ? `${before} -> ${c.config.settings.sensitivity}` : `still ${before}`)
    if (c && c.config.settings.sensitivity >= 1) note('Raise sensitivity can be pressed repeatedly up to 1.0 (the maximum) with no warning.')
  }

  // ------------------------------------------------------------ 3. Tap test
  await S('st.useStore.getState().navigate("calibration")')
  await sleep(700)
  await click('Tap test', true)
  await sleep(700)
  await shot('tap-test-intro')
  await audit('tap-test-intro')
  a11y['tap-test-intro'].tabOrder = await tabOrder(20)
  const enabledZones = cfg().zones.filter((z) => z.enabled !== false)
  const calibratedZones = new Set((since(0, 'calibration').filter((m) => m.phase === 'done').pop()?.zones ?? []).map((z) => z.zone ?? z.id ?? z))
  note(`Tap test covers ${enabledZones.length} switched-on zones: ${enabledZones.map((z) => z.id).join(', ')}. Zones calibrated so far: ${[...calibratedZones].join(', ') || 'unknown'}.`)
  {
    const tT = Date.now()
    await click('Start the test', true)
    await sleep(400)
    const plan = []
    let taught = 0
    let expectedHits = 0
    const modes = []
    for (let k = 0; k < 40; k++) {
      const st = await S('st.useTapTest.getState()')
      if (st.phase !== 'running') break
      const target = st.prompts[st.index]
      const mode = k % 4 === 1 ? 'wrong' : k % 4 === 2 ? 'spike' : k === 3 ? 'nothing' : 'hit'
      plan.push(`${target}:${mode}`)
      modes[st.index] = mode
      if (mode === 'hit') {
        expectedHits++
        daemon({ type: 'sim_tap', zone: target })
      } else if (mode === 'wrong') daemon({ type: 'sim_tap', zone: enabledZones.find((z) => z.id !== target).id })
      else if (mode === 'spike') spike()
      // wait for the outcome
      const o = await waitFor(async () => (await S(`st.useTapTest.getState().results[${st.index}] || null`)) ?? null, 7000, 150)
      if (k === 1 || k === 2 || k === 3) {
        await shot(`tap-test-${o?.kind ?? 'none'}`)
        await audit(`tap-test-${o?.kind ?? 'none'}`)
      }
      if (o && o.kind === 'wrong') {
        const b = await buttons()
        record('tap test', 'wrong zone: no "Teach it" button (the daemon only learns taps it dropped)', !b.includes('Teach it this tap'), b.filter((x) => /Teach|Next/.test(x)).join(', '))
        await click('Next', true)
      } else if (o && o.kind !== 'hit') {
        if (taught < 2) {
          await sleep(800)
          await click('Teach it this tap', true)
          const fb = await next('feedback', () => true, 4000)
          taught++
          record('tap test', `miss "${o.kind}${o.reason ? ' ' + o.reason : ''}": "Teach it this tap" gets a daemon answer`, !!fb, fb ? `found=${fb.found} retrained=${fb.retrained} ${fb.reason ?? ''}` : 'no reply')
          await sleep(2300) // feedback is limited to one every 2 s
        } else await click('Next', true)
      }
      await sleep(900)
    }
    const st = await S('st.useTapTest.getState()')
    const hits = st.results.filter((r) => r && r.kind === 'hit').length
    const kinds = st.results.map((r) => (r ? `${r.kind}${r.reason ? ':' + r.reason : ''}${r.heardAs ? '>' + r.heardAs : ''}` : '-'))
    // A spike is a real (synthetic) tap to the daemon: it may land on the target zone by chance, so it can score either way.
    const scoredRight = st.results.every((r, i) => (modes[i] === 'hit' ? r?.kind === 'hit' : modes[i] === 'spike' ? true : r?.kind !== 'hit'))
    record('tap test', 'runs to the end and scores hits correctly', st.phase === 'done' && scoredRight, `phase ${st.phase}, ${hits} hits (${expectedHits} sure hits, spikes may add more) of ${st.results.length}: ${kinds.join(' ')}`)
    const acts = since(tT, 'action')
    // The app does not suppress actions during the test (the intro says so); only report what ran.
    note(`Actions that ran during the Tap test: ${acts.length ? acts.map((a) => a.label).join(', ') : 'none (no single-tap binding existed)'}`)
    await shot('tap-test-done')
    await audit('tap-test-done')
    const doneText = await bodyText()
    record('tap test', 'result screen offers a next step (recalibrate weak zones or test again)', /Recalibrate|Test again/.test(doneText), (doneText.match(/(needs|need) more practice\.|Every tap landed[^\n]*|Most taps landed[^\n]*/) ?? [''])[0])
  }

  // ------------------------------------------------------------ 4. Training session
  await click('Training session', true)
  await sleep(700)
  await shot('training-intro')
  await audit('training-intro')
  {
    const ids = cfg().zones.filter((z) => z.enabled !== false).map((z) => z.id)
    const tTr = Date.now()
    // Posture first, then single taps (interleaved, soft and firm), doubles, everyday-use negatives, then it trains.
    await click('On a desk', true)
    await sleep(500)
    let rounds = 0
    const seen = new Set()
    let stuck = 0
    let lastKey = ''
    let shotSingles = false
    for (let i = 0; i < 400 && stuck < 12; i++) {
      const st = await S('st.useTraining.getState()')
      if (st.phase !== 'running') break
      if (!seen.has(st.stage)) {
        seen.add(st.stage)
        rounds++
        await shot(`training-${st.stage}`)
        await audit(`training-${st.stage}`)
      }
      if (st.stage === 'finishing') break
      if (st.stage === 'negatives') {
        await sleep(1000)
        stuck = 0
        continue
      }
      if (st.stage === 'singles' && !shotSingles && st.index === 2) {
        shotSingles = true
        await shot('training-singles-3')
      }
      const key = `${st.stage}:${st.index}:${st.doubleIndex}:${st.doubleCount}`
      stuck = key === lastKey ? stuck + 1 : 0
      lastKey = key
      if (st.stage === 'singles' && !st.showing) {
        await sleep(400)
        stuck = 0
        continue
      }
      spike()
      if (st.stage === 'doubles') {
        await sleep(220)
        spike()
      }
      await sleep(600)
    }
    if (stuck >= 12) {
      const st = await S('st.useTraining.getState()')
      record('training', 'each stage progresses with one tap per prompt', false, `stuck in ${st.stage} at ${st.index}/${st.prompts.length}, counts ${JSON.stringify(st.counts)}`)
    }
    record('training', 'posture, taps, doubles and everyday-use stages all ran', ['singles', 'doubles', 'negatives'].every((x) => seen.has(x)), [...seen].join(', '))
    record('training', 'stages seen', rounds >= 3, `${rounds} stages over up to ${ids.length} zones`)
    const fin = await waitFor(async () => ((await S('st.usePractice.getState().mode')) === 'calibrate' ? true : null), 60_000, 500)
    const done = since(tTr, 'calibration').find((m) => m.phase === 'done')
    record('training', 'finishes, trains and hands over to the calibration results', !!fin && !!done, done ? `overall ${done.overall}` : 'no done')
    await sleep(800)
    await shot('training-after')
    await audit('calibration-results')
    const w = await S('st.useWizard.getState().step')
    record('training', 'the results page is shown after training', w === 'results', `wizard step ${w}`)
  }

  // ------------------------------------------------------------ 5. Sonar
  await S('st.useStore.getState().navigate("sonar")')
  await sleep(800)
  await shot('sonar-off')
  await audit('sonar-off')
  {
    const b = await buttons()
    record('sonar', 'sonar page, sonar off: there is a way to turn it on', b.includes('Turn on') || b.includes('Start sonar'), b.join(', '))
    await click('Turn on', true)
    await sleep(600)
    const b2 = await buttons()
    await shot('sonar-turn-on-ask')
    // SessionNote may ask first (explain once)
    const confirm = b2.find((x) => /^(Turn on sonar|Turn on|Continue|Allow|OK)$/i.test(x) && x !== 'Turn on')
    if (confirm) await click(confirm, true)
    else if (b2.includes('Turn on')) await click('Turn on', true)
    const s = await next('session', (m) => m.kind === 'sonar' && m.active, 8000)
    record('sonar', 'turning sonar on starts a (simulated) sonar session', !!s, s ? JSON.stringify({ active: s.active, secondsLeft: s.secondsLeft, continuous: s.continuous }) : `buttons: ${b2.join(', ')}`)
    await sleep(800)
    const head = await js(`document.querySelector('header')?.innerText ?? ''`)
    record('sonar', 'header subtitle makes sense for continuous sonar', !/NaN|undefined|\b0s left/i.test(head), head.replace(/\n/g, ' | '))
    await shot('sonar-on')
    await audit('sonar-on')
    daemon({ type: 'sim_sonar', gesture: 'push', side: 'left' })
    await sleep(500)
    const t1 = await bodyText()
    record('sonar', 'a simulated push shows as the last sonar gesture', /Push[^\n]*left speaker/i.test(t1), t1.match(/Last sonar gesture\n[^\n]*/)?.[0]?.replace('\n', ': ') ?? '')
    await shot('sonar-push')
    daemon({ type: 'sim_sonar', air: { gesture: 'hover_level', phase: 'changed', value: 0.6, side: 'right', displacementMm: 40 } })
    await sleep(400)
    const hv = await js(`(() => { const st = window.__gk.stores; return null })()`)
    void hv
    // Sonar test
    await click('Sonar test', true)
    await sleep(500)
    await shot('sonar-test-start')
    await audit('sonar-test')
    const plan = [
      { say: 'Hover', send: { air: { gesture: 'hover_level', phase: 'changed', value: 0.7, side: 'left', displacementMm: 50 } } },
      { say: 'Push', send: { gesture: 'push', side: 'left' } },
      { say: 'Pull', send: null },
      { say: 'Sweep right to left', send: { gesture: 'sweep_left' } },
      { say: 'Sweep left to right', send: { gesture: 'sweep_right' } },
      { say: 'Slide up', send: { gesture: 'finger_slide_up', side: 'right' } }
    ]
    for (const p of plan) {
      await click('Go', true)
      await sleep(400)
      if (p.send) daemon({ type: 'sim_sonar', ...p.send })
      const got = await waitText(p.send ? 'Recognised.' : 'Not recognised', p.send ? 3000 : 9000)
      const t = await bodyText()
      const line = t.match(/(Recognised\.|Not recognised\.[^\n]*)/)?.[0] ?? ''
      record('sonar test', `${p.say}: ${p.send ? 'recognised' : 'miss explained'}`, !!got, line)
      if (!p.send) await shot('sonar-test-miss')
      await click('Next', true)
      await sleep(400)
    }
    const end = await bodyText()
    record('sonar test', 'summary shows the score', /5 of 6 recognised/.test(end), end.match(/\d of \d recognised/)?.[0] ?? '')
    await shot('sonar-test-done')
    await click('Watch', true)
    await sleep(300)
    await click('Stop sonar', true)
    const st = await next('session', (m) => m.kind === 'sonar' && !m.active, 5000)
    await sleep(600)
    const b3 = await buttons()
    record('sonar', '"Stop sonar" stops it and the page still offers a way back on', !!st && (b3.includes('Turn on') || b3.includes('Start sonar')), `stop reason ${st?.reason ?? 'none'}; buttons: ${b3.join(', ')}`)
    await shot('sonar-stopped')
  }

  // ------------------------------------------------------------ 6. Approvals
  {
    const seen = []
    let answer = 0
    const orig = dialog.showMessageBox
    dialog.showMessageBox = async (...args) => {
      const opts = args.length > 1 ? args[1] : args[0]
      seen.push(opts)
      return { response: answer, checkboxChecked: false }
    }
    const shell = { kind: 'shell', command: 'echo ghostkeys-verify' }
    answer = 0
    const r0 = await js(`window.gk.approve([${JSON.stringify(shell)}], 'Double tap on the right palm rest')`)
    record('approvals', 'Cancel in the native dialog approves nothing', r0 === null, JSON.stringify(r0))
    answer = 1
    const r1 = await js(`window.gk.approve([${JSON.stringify(shell)}], 'Double tap on the right palm rest')`)
    const hash = Array.isArray(r1) ? r1[0] : null
    record('approvals', 'Allow returns a daemon approval hash', !!hash && /^[0-9a-f]{64}$/.test(hash), hash ?? JSON.stringify(r1))
    const d = seen[seen.length - 1]
    record('approvals', 'the dialog shows the exact command and a plain warning', !!d && d.detail.includes(shell.command), d ? `${d.message} / ${d.detail.replace(/\n+/g, ' | ')} / buttons ${d.buttons.join(',')} default=${d.buttons[d.defaultId]}` : 'no dialog')
    await clearToasts()
    daemon({ type: 'test_action', action: shell })
    const u = await next('action', () => true, 3000)
    record('approvals', 'unapproved command is refused by the daemon', !!u && !u.ok, u?.error ?? '')
    // the app's own test path (renderer sends test_action and shows a toast)
    await js(`window.__gk.stores.client.send({ type: 'test_action', action: ${JSON.stringify({ ...shell, command: 'echo other' })} })`)
    await sleep(900)
    const tt = await toasts()
    record('errors', 'refused test action shows a plain toast', tt.some((x) => /approval|didn’t run/i.test(x)), tt.join(' / '))
    await shot('error-unapproved-toast')
    daemon({ type: 'test_action', action: { ...shell, approvedHash: hash } })
    const a = await next('action', () => true, 3000)
    record('approvals', 'approved command runs (dry run)', !!a && a.ok, a ? `${a.label} ${a.error ?? ''}` : 'none')
    daemon({ type: 'revoke_action', hash })
    const rv = await next('revoked', () => true, 3000)
    record('approvals', 'revoke works', !!rv && rv.found)
    dialog.showMessageBox = orig
  }

  // ------------------------------------------------------------ 7. Errors in plain words
  {
    await clearToasts()
    await js(`window.__gk.stores.client.send({ type: 'feedback_missed', zone: 'right-palm' })`)
    await sleep(150)
    await js(`window.__gk.stores.client.send({ type: 'feedback_missed', zone: 'right-palm' })`)
    const e = await next('error', () => true, 3000)
    await sleep(700)
    const tt = await toasts()
    record('errors', 'feedback sent twice quickly: error shown in plain words', !!e && tt.length > 0 && !tt.some((x) => /feedback_missed|at most one/.test(x)), `daemon: "${e?.message ?? ''}"; toast: ${tt.join(' / ')}`)
    await shot('error-feedback-limit')
    await clearToasts()
    await js(`window.__gk.stores.client.send({ type: 'sonar_session_start' })`)
    const s = await next('session', (m) => m.kind === 'sonar', 3000)
    const e2 = s ? null : await next('error', () => true, 1500)
    await sleep(700)
    const tt2 = await toasts()
    record('errors', 'sonar start while off: plain explanation', tt2.length > 0 && !tt2.some((x) => /sonar_session|settings\.sonar/.test(x)), `daemon: ${s ? `session error "${s.error}"` : `"${e2?.message ?? ''}"`}; toast: ${tt2.join(' / ')}`)
    await shot('error-sonar-off')
    await clearToasts()
    await js(`window.__gk.stores.client.send({ type: 'calibration_zone', zone: 'right-palm' })`)
    const e3 = await next('error', () => true, 3000)
    await sleep(700)
    const tt3 = await toasts()
    record('errors', 'calibration message out of order: plain sentence', tt3.some((x) => /Calibration isn’t running/.test(x)), `daemon: "${e3?.message ?? ''}"; toast: ${tt3.join(' / ')}`)
  }

  // ------------------------------------------------------------ 8. accessibility snapshot of the other new screens
  for (const r of ['live', 'sonar']) {
    await S(`st.useStore.getState().navigate(${JSON.stringify(r)})`)
    await sleep(500)
  }

  return finish()

  function finish() {
    const counted = results.filter((r) => r.ok !== null)
    const passed = counted.filter((r) => r.ok).length
    console.log(`[verify] ${passed}/${counted.length} checks passed (${results.length - counted.length} not applicable)`)
    writeFileSync(join(outDir, 'results.json'), JSON.stringify({ results, notes, a11y }, null, 2))
    return passed === counted.length ? 0 : 1
  }
}
