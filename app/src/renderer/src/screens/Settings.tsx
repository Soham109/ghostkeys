import * as React from 'react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { COMMON_APPS, appName } from '@/lib/apps'
import type { SessionSettings, Settings } from '@shared/protocol'
import type { ThemeMode } from '@shared/ipc'
import { FAMILY_LABEL } from '@shared/protocol'
import { PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Input, ProTag, Segmented, Slider, Switch } from '@/components/ui/controls'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/overlays'

function Row({ title, desc, children, htmlFor, pro }: { title: string; desc?: React.ReactNode; children: React.ReactNode; htmlFor?: string; pro?: boolean }): React.JSX.Element {
  return (
    <div className="flex min-h-14 items-center gap-8 py-2.5 shadow-[0_1px_0_var(--hairline)]">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="flex items-center gap-2 text-[13px] leading-[18px] text-ink">
          {title}
          {pro && <ProTag />}
        </label>
        {desc && <p className="max-w-[56ch] text-[12px] leading-4 text-ink-3">{desc}</p>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

function Section({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }): React.JSX.Element {
  return (
    <section className="pt-10 first:pt-6" aria-label={label}>
      <h2 className="label-mono pb-2">{label}</h2>
      <div className="shadow-[0_-1px_0_var(--hairline)]">{children}</div>
      {note && <div className="pt-3 text-[12px] leading-relaxed text-ink-3">{note}</div>}
    </section>
  )
}

function SliderRow({
  title,
  desc,
  value,
  min,
  max,
  step,
  format,
  word,
  ticks,
  onCommit
}: {
  title: string
  desc: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  word?: (v: number) => string
  ticks?: number
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [v, setV] = React.useState(value)
  React.useEffect(() => setV(value), [value])
  return (
    <Row title={title} desc={desc}>
      <div className="flex items-center gap-4">
        {word && <span className="w-16 text-right text-[13px] text-ink-2">{word(v)}</span>}
        <Slider className="w-[200px]" ticks={ticks} min={min} max={max} step={step} value={[v]} onValueChange={([x]) => setV(x ?? v)} onValueCommit={([x]) => onCommit(x ?? v)} aria-label={title} />
        <span className="num w-16 shrink-0 text-right text-[11px] tracking-[0.04em] text-ink-2 uppercase">{format(v)}</span>
      </div>
    </Row>
  )
}

function AutoApps({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }): React.JSX.Element {
  return (
    <div className="flex max-w-[300px] flex-wrap items-center justify-end gap-x-3 gap-y-1">
      {value.map((id) => (
        <button key={id} className="text-[12px] text-ink-2 hover:text-ink hover:line-through" title={`Remove ${appName(id)}`} onClick={() => onChange(value.filter((x) => x !== id))}>
          {appName(id)}
        </button>
      ))}
      <Menu>
        <MenuTrigger asChild>
          <Button variant="text" size="sm">
            {value.length ? 'Add' : 'Choose apps'}
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="max-h-72 overflow-y-auto">
          {COMMON_APPS.filter((a) => !value.includes(a.id)).map((a) => (
            <MenuItem key={a.id} onSelect={() => onChange([...value, a.id])}>
              {a.name}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
    </div>
  )
}

const DEFAULT_SESSION: SessionSettings = { enabled: false, sessionSeconds: 30, autoApps: [] }

function permissionWord(p: string | undefined): string {
  return p === 'authorized' ? 'Allowed' : p === 'denied' ? 'Blocked in System Settings' : 'Not asked yet'
}

function SessionButton({ kind }: { kind: 'sound' | 'air' }): React.JSX.Element {
  const s = useStore((st) => st.sessions[kind])
  const active = !!s?.active
  return (
    <Button
      variant="outline"
      onClick={() => client.send({ type: active ? (kind === 'sound' ? 'sound_session_stop' : 'air_session_stop') : kind === 'sound' ? 'sound_session_start' : 'air_session_start' })}
    >
      {active ? `Stop, ${Math.round(s!.secondsLeft)}s left` : kind === 'sound' ? 'Listen now' : 'Watch now'}
    </Button>
  )
}

interface Pricing {
  tiers: { id: string; name: string; price: number; billing: string; tagline: string }[]
}

function License(): React.JSX.Element {
  const license = useStore((s) => s.license)
  const [key, setKey] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [pricing, setPricing] = React.useState<Pricing | null>(null)
  React.useEffect(() => {
    void window.gk.pricing().then((p) => setPricing(p as Pricing | null))
  }, [])
  const submit = async (value: string | null): Promise<void> => {
    const r = await window.gk.setLicense(value)
    useStore.setState({ license: r.license })
    setError(r.error)
    if (!r.error) setKey('')
  }
  const billing = (t: Pricing['tiers'][number]): string =>
    t.price === 0 ? 'Free' : t.billing === 'one-time' ? `$${t.price} once` : t.billing === 'per-seat-yearly' ? `$${t.price} per seat, yearly` : `$${t.price}`
  return (
    <Section
      label="License"
      note={license.demoUnlock ? 'This is a demo build: every Pro feature works, and Pro features are only marked, never locked.' : undefined}
    >
      <Row title={license.tier === 'free' ? 'Ghostkeys Free' : `Ghostkeys ${license.tier === 'pro' ? 'Pro' : 'Teams'}`} desc={license.holder ? `Licensed to ${license.holder}${license.issued ? `, ${license.issued}` : ''}.` : 'Two palm-rest buttons, calibration and the basic actions.'}>
        {license.source === 'key' && (
          <Button variant="text" onClick={() => void submit(null)}>
            Remove key
          </Button>
        )}
      </Row>
      {pricing?.tiers.map((t) => (
        <div key={t.id} className="flex h-11 items-center gap-6 shadow-[0_1px_0_var(--hairline)]">
          <span className="w-16 text-[13px] text-ink">{t.name}</span>
          <span className="flex-1 truncate text-[12px] text-ink-3">{t.tagline}</span>
          <span className="num text-[11px] tracking-[0.04em] text-ink-2 uppercase">{billing(t)}</span>
        </div>
      ))}
      <div className="flex flex-col gap-2 py-4">
        <label htmlFor="license-key" className="text-[13px] text-ink">
          Enter license key
        </label>
        <div className="flex gap-2">
          <Input
            id="license-key"
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setError(null)
            }}
            placeholder="GK1..."
            spellCheck={false}
            className="font-mono text-[12px]"
          />
          <Button variant="primary" disabled={!key.trim()} onClick={() => void submit(key)}>
            Add key
          </Button>
        </div>
        <p className="text-[12px] text-ink-3">{error ?? 'Checked on this Mac. Ghostkeys never goes online to verify it.'}</p>
      </div>
    </Section>
  )
}

export function SettingsScreen(): React.JSX.Element {
  const config = useStore((s) => s.config)
  const status = useStore((s) => s.status)
  const hello = useStore((s) => s.hello)
  const info = useStore((s) => s.info)
  const saveSettings = useStore((s) => s.saveSettings)
  const setPrefs = useStore((s) => s.setPrefs)
  const setPaused = useStore((s) => s.setPaused)
  const s = config?.settings
  const set = (p: Partial<Settings>): void => saveSettings(p)
  const sound = { ...DEFAULT_SESSION, ...s?.sound }
  const camera = { ...DEFAULT_SESSION, deskMode: false, ...s?.camera }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="fade-bottom min-h-0 flex-1 overflow-y-auto shadow-[0_-1px_0_var(--hairline)]">
        <div className="mx-auto max-w-[640px] px-6 pb-20">
          <Section label="Detection">
            {s && (
              <>
                <SliderRow
                  title="Sensitivity"
                  desc="Higher catches lighter taps, and more accidental bumps."
                  value={s.sensitivity}
                  min={0}
                  max={1}
                  step={0.25}
                  ticks={5}
                  word={(v) => (v < 0.3 ? 'Firm' : v < 0.7 ? 'Balanced' : 'Light')}
                  format={(v) => `${Math.round(v * 100)}`}
                  onCommit={(sensitivity) => set({ sensitivity })}
                />
                <SliderRow
                  title="Typing pause"
                  desc="Ignore taps for this long after any key press."
                  value={s.typingGateMs}
                  min={100}
                  max={1200}
                  step={25}
                  format={(v) => `${v} ms`}
                  onCommit={(typingGateMs) => set({ typingGateMs })}
                />
                <SliderRow
                  title="Double-tap window"
                  desc="How long to wait for a second tap."
                  value={s.doubleWindowMs}
                  min={200}
                  max={500}
                  step={10}
                  format={(v) => `${v} ms`}
                  onCommit={(doubleWindowMs) => set({ doubleWindowMs })}
                />
                <SliderRow
                  title="Certainty needed"
                  desc="Ignore taps Ghostkeys isn’t at least this sure about."
                  value={s.minConfidence}
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)} %`}
                  onCommit={(minConfidence) => set({ minConfidence })}
                />
              </>
            )}
          </Section>

          <Section label="Feedback">
            {s && (
              <>
                <Row title="Show what ran" desc="A small label at the top of the screen after each gesture." htmlFor="hud">
                  <Switch id="hud" checked={s.hud} onCheckedChange={(hud) => set({ hud })} />
                </Row>
                <Row title="Haptic tick" desc="A light trackpad click confirms each gesture." htmlFor="haptics">
                  <Switch id="haptics" checked={s.haptics} onCheckedChange={(haptics) => set({ haptics })} />
                </Row>
              </>
            )}
          </Section>

          {s && (
            <Section
              label="Sound mode"
              note={
                <>
                  Nothing is recorded or saved, and sound never leaves your Mac. Hand waves use an inaudible 20 kHz tone from the built-in speakers, so they
                  don&rsquo;t work with headphones or external speakers, and some pets can hear it.
                  {!hello?.sensors.sound && ' This Mac has no microphone Ghostkeys can use.'}
                </>
              }
            >
              <Row title="Listen with the microphone" pro desc="Adds knuckle knocks, rubs and hand waves. macOS shows its orange dot while it listens." htmlFor="sound">
                <Switch id="sound" disabled={!hello?.sensors.sound} checked={sound.enabled} onCheckedChange={(enabled) => set({ sound: { ...sound, enabled } })} />
              </Row>
              <SliderRow
                title="Listen for"
                desc="Each session stops by itself after this long."
                value={sound.sessionSeconds}
                min={10}
                max={120}
                step={5}
                format={(v) => `${v} s`}
                onCommit={(sessionSeconds) => set({ sound: { ...sound, sessionSeconds } })}
              />
              <Row title="Start by itself in" desc="A session starts when one of these apps comes to the front.">
                <AutoApps value={sound.autoApps} onChange={(autoApps) => set({ sound: { ...sound, autoApps } })} />
              </Row>
              <Row title="Microphone" desc={permissionWord(hello?.permissions.microphone)}>
                <SessionButton kind="sound" />
              </Row>
            </Section>
          )}

          {s && (
            <Section
              label="Camera"
              note={
                <>
                  Frames are read in memory and never saved or sent anywhere. The camera turns off at the end of each session.
                  {!hello?.sensors.camera && ' This Mac has no camera Ghostkeys can use.'}
                </>
              }
            >
              <Row title="Watch for hand gestures" pro desc="Air taps, pinches, swipes and circles. macOS shows its green light while the camera is on." htmlFor="camera">
                <Switch id="camera" disabled={!hello?.sensors.camera} checked={camera.enabled} onCheckedChange={(enabled) => set({ camera: { ...camera, enabled } })} />
              </Row>
              <SliderRow
                title="Watch for"
                desc="Each session stops by itself after this long."
                value={camera.sessionSeconds}
                min={10}
                max={120}
                step={5}
                format={(v) => `${v} s`}
                onCommit={(sessionSeconds) => set({ camera: { ...camera, sessionSeconds } })}
              />
              <Row title="Start by itself in" desc="A session starts when one of these apps comes to the front.">
                <AutoApps value={camera.autoApps} onChange={(autoApps) => set({ camera: { ...camera, autoApps } })} />
              </Row>
              <Row title="Desk View" desc="Experimental: fingertips on the palm rests, seen from above." htmlFor="desk">
                <Switch id="desk" checked={camera.deskMode} onCheckedChange={(deskMode) => set({ camera: { ...camera, deskMode } })} />
              </Row>
              <Row title="Camera" desc={permissionWord(hello?.permissions.camera)}>
                <SessionButton kind="air" />
              </Row>
            </Section>
          )}

          <Section label="Appearance">
            <Row title="Theme">
              <Segmented<ThemeMode>
                aria-label="Theme"
                value={info?.prefs.theme ?? 'system'}
                onValueChange={(theme) => void setPrefs({ theme })}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' }
                ]}
              />
            </Row>
          </Section>

          <Section label="App">
            <Row title="Pause Ghostkeys" desc="Taps are still felt, but no action runs." htmlFor="pause">
              <Switch id="pause" checked={!!status?.paused} onCheckedChange={(p) => setPaused(p)} />
            </Row>
            <Row title="Keep running in the menu bar" desc="Closing the window leaves gestures working." htmlFor="menubar">
              <Switch id="menubar" checked={info?.prefs.keepInMenuBar ?? true} onCheckedChange={(keepInMenuBar) => void setPrefs({ keepInMenuBar })} />
            </Row>
            <Row title="Open this window at launch" htmlFor="showwin">
              <Switch id="showwin" checked={info?.prefs.showWindowOnLaunch ?? true} onCheckedChange={(showWindowOnLaunch) => void setPrefs({ showWindowOnLaunch })} />
            </Row>
            <Row title="Accessibility" desc="Needed for shortcuts, typed text and window moves.">
              {hello?.permissions.accessibility ? (
                <span className="text-[12px] text-ink-2">Allowed</span>
              ) : (
                <Button variant="outline" onClick={() => client.send({ type: 'request_permission', which: 'accessibility' })}>
                  Allow
                </Button>
              )}
            </Row>
            <Row title="Welcome tour" desc="The introduction and device check.">
              <Button variant="text" onClick={() => useStore.setState({ onboarding: true, onboardingStep: 0 })}>
                Show again
              </Button>
            </Row>
          </Section>

          <License />

          <section className="pt-10" aria-label="Privacy">
            <h2 className="label-mono pb-2">Privacy</h2>
            <div className="grid grid-cols-2 gap-10 pt-4 shadow-[0_-1px_0_var(--hairline)]">
              <div>
                <p className="text-[13px] text-ink">What Ghostkeys uses</p>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-ink-2">
                  <li>The motion sensor, to feel taps and tilts.</li>
                  <li>The lid angle and ambient light sensors.</li>
                  <li>Whether a key or the trackpad was just used, never which key.</li>
                  <li>The name of the app in front, to pick the right layer.</li>
                  <li>Only if you turn them on: the microphone and camera, in short sessions.</li>
                </ul>
              </div>
              <div>
                <p className="text-[13px] text-ink">What it never touches</p>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-ink-2">
                  <li>What you type or what is on screen.</li>
                  <li>Recordings of any kind. Sound and video are read and dropped.</li>
                  <li>The network. It only talks to itself on this Mac.</li>
                  <li>Administrator rights, system settings or login items.</li>
                </ul>
              </div>
            </div>
          </section>

          <section className="pt-10" aria-label="About">
            <h2 className="label-mono pb-2">About</h2>
            <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 pt-4 text-[12px] shadow-[0_-1px_0_var(--hairline)]">
              <dt className="text-ink-3">App</dt>
              <dd className="num text-ink-2">{info?.version ?? '...'}</dd>
              <dt className="text-ink-3">Helper</dt>
              <dd className="num text-ink-2">
                {hello?.version ?? '...'}
                {info?.mock ? ' (practice)' : ''}
              </dd>
              <dt className="text-ink-3">Mac</dt>
              <dd className="text-ink-2">{hello ? `${FAMILY_LABEL[hello.device.family]}, ${hello.device.chip}` : '...'}</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  )
}
