import * as React from 'react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import type { Settings } from '@shared/protocol'
import type { ThemeMode } from '@shared/ipc'
import { FAMILY_LABEL } from '@shared/protocol'
import { PageHeader } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Segmented, Slider, Switch } from '@/components/ui/controls'

function Row({ title, desc, children, htmlFor }: { title: string; desc?: React.ReactNode; children: React.ReactNode; htmlFor?: string }): React.JSX.Element {
  return (
    <div className="flex min-h-[52px] items-center gap-8 py-3 shadow-[0_1px_0_var(--hairline)]">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-[13px] text-ink">
          {title}
        </label>
        {desc && <p className="mt-0.5 max-w-[52ch] text-[12px] leading-relaxed text-ink-3">{desc}</p>}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="pt-8 first:pt-2" aria-label={label}>
      <h2 className="label-mono pb-2">{label}</h2>
      <div className="shadow-[0_-1px_0_var(--hairline)]">{children}</div>
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
  onCommit
}: {
  title: string
  desc: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onCommit: (v: number) => void
}): React.JSX.Element {
  const [v, setV] = React.useState(value)
  React.useEffect(() => setV(value), [value])
  return (
    <Row title={title} desc={desc}>
      <div className="flex w-[280px] items-center gap-4">
        <Slider min={min} max={max} step={step} value={[v]} onValueChange={([x]) => setV(x ?? v)} onValueCommit={([x]) => onCommit(x ?? v)} aria-label={title} />
        <span className="num w-20 shrink-0 text-right text-[12px] text-ink-2">{format(v)}</span>
      </div>
    </Row>
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

  return (
    <>
      <PageHeader title="Settings" />
      <div className="min-h-0 flex-1 overflow-y-auto shadow-[0_-1px_0_var(--hairline)]">
        <div className="max-w-[720px] px-6 pb-16">
          <Section label="Detection">
            {s && (
              <>
                <SliderRow
                  title="Sensitivity"
                  desc="Higher catches lighter taps, and more accidental bumps."
                  value={s.sensitivity}
                  min={0}
                  max={1}
                  step={0.05}
                  format={(v) => (v < 0.34 ? 'Firm' : v < 0.67 ? 'Balanced' : 'Light')}
                  onCommit={(sensitivity) => set({ sensitivity })}
                />
                <SliderRow
                  title="Typing pause"
                  desc="Taps are ignored for this long after any key press, so typing never triggers a gesture."
                  value={s.typingGateMs}
                  min={100}
                  max={1200}
                  step={25}
                  format={(v) => `${v} ms`}
                  onCommit={(typingGateMs) => set({ typingGateMs })}
                />
                <SliderRow
                  title="Double-tap window"
                  desc="How long Ghostkeys waits for a second tap. Single taps on zones with a double tap wait this long."
                  value={s.doubleWindowMs}
                  min={200}
                  max={500}
                  step={10}
                  format={(v) => `${v} ms`}
                  onCommit={(doubleWindowMs) => set({ doubleWindowMs })}
                />
                <SliderRow
                  title="Minimum confidence"
                  desc="Taps the model is less sure about than this are ignored."
                  value={s.minConfidence}
                  min={0.5}
                  max={0.99}
                  step={0.01}
                  format={(v) => `${Math.round(v * 100)}%`}
                  onCommit={(minConfidence) => set({ minConfidence })}
                />
              </>
            )}
          </Section>

          <Section label="Feedback">
            {s && (
              <>
                <Row title="Show the HUD" desc="A small pill near the top of the screen names each gesture and what it did." htmlFor="hud">
                  <Switch id="hud" checked={s.hud} onCheckedChange={(hud) => set({ hud })} />
                </Row>
                <Row title="Haptic tick" desc="A light trackpad click confirms each gesture." htmlFor="haptics">
                  <Switch id="haptics" checked={s.haptics} onCheckedChange={(haptics) => set({ haptics })} />
                </Row>
              </>
            )}
          </Section>

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
            <Row title="Pause Ghostkeys" desc="Taps are still felt, but no action runs. Also in the menu bar." htmlFor="pause">
              <Switch id="pause" checked={!!status?.paused} onCheckedChange={(p) => setPaused(p)} />
            </Row>
            <Row title="Keep running in the menu bar" desc="Closing the window leaves gestures working. Quit from the menu bar icon." htmlFor="menubar">
              <Switch id="menubar" checked={info?.prefs.keepInMenuBar ?? true} onCheckedChange={(keepInMenuBar) => void setPrefs({ keepInMenuBar })} />
            </Row>
            <Row title="Open this window at launch" htmlFor="showwin">
              <Switch id="showwin" checked={info?.prefs.showWindowOnLaunch ?? true} onCheckedChange={(showWindowOnLaunch) => void setPrefs({ showWindowOnLaunch })} />
            </Row>
            <Row
              title="Accessibility access"
              desc="Needed for keyboard shortcuts, typing text and arranging windows."
            >
              {hello?.permissions.accessibility ? (
                <span className="text-[12px] text-ink-2">Granted</span>
              ) : (
                <Button variant="outline" onClick={() => client.send({ type: 'request_permission', which: 'accessibility' })}>
                  Grant access
                </Button>
              )}
            </Row>
            <Row title="Welcome tour" desc="See the introduction and device check again.">
              <Button variant="ghost" onClick={() => useStore.setState({ onboarding: true, onboardingStep: 0 })}>
                Show again
              </Button>
            </Row>
          </Section>

          <section className="pt-8" aria-label="Privacy">
            <h2 className="label-mono pb-2">Privacy</h2>
            <div className="grid grid-cols-2 gap-10 pt-3 shadow-[0_-1px_0_var(--hairline)]">
              <div>
                <p className="text-[13px] text-ink">What Ghostkeys uses</p>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-ink-2">
                  <li>The motion sensor, to feel taps and tilts.</li>
                  <li>The lid angle sensor, for lid nudges.</li>
                  <li>The ambient light sensor, for covering it with your hand.</li>
                  <li>Whether a key or the trackpad was just used, never which key.</li>
                  <li>The name of the app in front, to pick the right layer.</li>
                </ul>
              </div>
              <div>
                <p className="text-[13px] text-ink">What it never touches</p>
                <ul className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-ink-2">
                  <li>The camera and the microphone.</li>
                  <li>What you type or what is on screen.</li>
                  <li>The network. It only talks to itself on this Mac.</li>
                  <li>Administrator rights, system settings or login items.</li>
                </ul>
                <p className="mt-3 text-[12px] leading-relaxed text-ink-3">Settings, samples and the trained model stay in ~/Library/Application Support/Ghostkeys.</p>
              </div>
            </div>
          </section>

          <section className="pt-10" aria-label="About">
            <h2 className="label-mono pb-2">About</h2>
            <dl className="grid grid-cols-[140px_1fr] gap-y-1.5 pt-3 text-[12px] shadow-[0_-1px_0_var(--hairline)]">
              <dt className="text-ink-3">App</dt>
              <dd className="num text-ink-2">{info?.version ?? '...'}</dd>
              <dt className="text-ink-3">Service</dt>
              <dd className="num text-ink-2">
                {hello?.version ?? '...'}
                {info?.mock ? ' (mock)' : ''}
              </dd>
              <dt className="text-ink-3">Mac</dt>
              <dd className="text-ink-2">
                {hello ? `${FAMILY_LABEL[hello.device.family]}, ${hello.device.chip}, ${hello.device.model}` : '...'}
              </dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  )
}
