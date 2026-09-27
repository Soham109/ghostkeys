import * as React from 'react'
import { toast } from 'sonner'
import {
  CAMERA_GESTURES,
  SESSION_NAME,
  SESSION_START,
  SONAR_GESTURES,
  SOUND_GESTURES,
  type Binding,
  type GestureKind,
  type SessionKind,
  type SessionMsg
} from '@shared/protocol'
import { saveSettingsConfirmed, useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { Button } from './ui/button'
import { Confirm } from './ui/overlays'
import { AutoApps } from '@/screens/Settings'

type Need = 'sound' | 'sonar' | 'camera'

export function needFor(g: GestureKind): Need | null {
  if (SONAR_GESTURES.includes(g)) return 'sonar'
  if (SOUND_GESTURES.includes(g)) return 'sound'
  if (CAMERA_GESTURES.includes(g)) return 'camera'
  return null
}

const NAME: Record<Need, string> = { sound: 'Sound mode', sonar: 'Sonar', camera: 'Camera' }
const SESSION: Record<Need, SessionKind> = { sound: 'sound', sonar: 'sonar', camera: 'air' }
const EXPLAIN: Record<Need, string> = {
  sound:
    'Sound mode listens with the microphone in short sessions, so macOS shows its orange dot while it listens. Nothing is recorded or saved. macOS may ask once for microphone access.',
  sonar:
    'Sonar plays two inaudible tones (19.5 and 20.25 kHz) at a low level through the built-in speakers and listens for their echo. It stays on until you turn it off, so macOS keeps its orange microphone dot on the whole time. The tones stop by themselves on headphones or other speakers, while the Mac or its display sleeps, with the lid closed and while Ghostkeys is paused. Some pets and young people can hear them. macOS may ask once for microphone access.',
  camera:
    'The camera add-on watches your hand in short sessions, so macOS shows its green light. Frames are never saved or sent anywhere. macOS may ask once for camera access.'
}

export interface NeedState {
  need: Need
  name: string
  enabled: boolean
  listening: boolean
  /** Sonar only: why it is on but not listening, or why the tones are off, in plain words. */
  problem: Problem | null
}

const WAITING: Record<string, string> = {
  paused: 'Ghostkeys is paused',
  asleep: 'the Mac is asleep',
  display_asleep: 'the display is asleep',
  lid_closed: 'the lid is closed'
}

export interface Problem {
  /** One plain sentence for the user. */
  text: string
  /** The daemon's own words (error codes and all), for a small "Details" disclosure; null when text says it all. */
  details: string | null
}

/**
 * Turns a daemon reason (a sonar refusal, a tones-off reason, a session error) into a plain sentence. The raw text
 * never goes in front of the user; it is kept as details.
 */
export function plainReason(raw: string, tonesOnly = false): Problem {
  const r = raw.toLowerCase()
  const out = (text: string, keep = true): Problem => ({ text, details: keep ? raw : null })
  const device = /headphones/.test(r) ? 'headphones' : /bluetooth/.test(r) ? 'a Bluetooth device' : /external/.test(r) ? 'other speakers' : null
  if (device) return out(`The sonar tones are off while sound goes to ${device}. They come back by themselves on the built-in speakers.`, false)
  if (/not the built-in speakers|unknown device/.test(r)) return out('The sonar tones only play through the built-in speakers. They come back by themselves when those are the output again.')
  if (/coreaudio|speakers could not start|-108\d\d|error domain/.test(r)) return out('The speakers couldn’t start the sonar tones. Ghostkeys keeps retrying.')
  if (/keeps changing/.test(r)) return out('The audio devices keep changing, so the sonar tones wait 30 seconds before trying again.', false)
  if (/audio output changed|timed out/.test(r)) return out('The audio output just changed. The sonar tones restart in a moment.', false)
  if (/cooling down/.test(r)) return out('The sonar tones wait a few seconds after a refusal, then try again.', false)
  if (/access is denied|microphoneDenied/i.test(raw)) return out('Ghostkeys isn’t allowed to use the microphone. Allow it in System Settings > Privacy & Security > Microphone.', false)
  if (/permission not granted yet/.test(r)) return out('macOS hasn’t asked for microphone access yet. Turn sonar off and on again to get the prompt.', false)
  if (/no microphone/.test(r)) return out('This Mac has no microphone Ghostkeys can use.', false)
  if (/open the microphone|reopen the microphone/.test(r)) return out('The microphone couldn’t be opened. Ghostkeys keeps retrying.')
  if (/sonar is off/.test(r)) return out('Sonar is off.', false)
  if (/paused/.test(r)) return out('Ghostkeys is paused.', false)
  if (/not connected|did not confirm/.test(r)) return out(sentence(raw), false)
  return out(tonesOnly ? 'The sonar tones are off right now. Ghostkeys keeps retrying.' : 'Sonar couldn’t start. Ghostkeys keeps retrying.')
}

/** Plain-words state of an enabled sonar that is not doing its job, or null when it is. */
export function sonarProblem(m: SessionMsg | null | undefined): Problem | null {
  if (!m) return null
  if (m.waiting) return { text: `Waiting: ${WAITING[m.waiting] ?? m.waiting}. It comes back by itself.`, details: null }
  if (m.error) return plainReason(m.error)
  if (m.active && m.sonarField === false) {
    const p = plainReason(m.tonesOff ?? 'output is not the built-in speakers', true)
    return { ...p, text: `Listening, but the tones are off. ${p.text}` }
  }
  return null
}

/** A problem sentence with the raw daemon text folded away under "Details". */
export function ProblemText({ problem, className }: { problem: Problem; className?: string }): React.JSX.Element {
  // Inline elements only: this sits inside <p> descriptions.
  const [open, setOpen] = React.useState(false)
  return (
    <span className={className}>
      {problem.text}
      {problem.details && (
        <>
          {' '}
          <button type="button" className="text-[11px] text-ink-3 underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Details'}
          </button>
          {open && <span className="mt-1 block font-mono text-[11px] break-all text-ink-3 select-text">{problem.details}</span>}
        </>
      )}
    </span>
  )
}

function sentence(s: string): string {
  const t = s.trim()
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? '' : '.'}` : t
}

/** Whether this gesture's session is switched on and running now. Sonar sessions also do everything Sound mode does. */
export function useNeed(g: GestureKind): NeedState | null {
  const need = needFor(g)
  const settings = useStore((s) => s.config?.settings)
  const sessions = useStore((s) => s.sessions)
  if (!need) return null
  const key = need === 'camera' ? 'camera' : need
  const enabled = !!settings?.[key]?.enabled
  const listening = need === 'sound' ? !!sessions.sound?.active || !!sessions.sonar?.active : !!sessions[SESSION[need]]?.active
  const problem = need === 'sonar' && enabled ? sonarProblem(sessions.sonar) : null
  return { need, name: NAME[need], enabled, listening, problem }
}

/**
 * Turns the mode on and waits for the daemon to confirm the setting. Sonar then starts by itself (it is a
 * switch, not a session); sound and camera get their first session only once the setting is really saved.
 * Failures show as a toast; a session that then fails to start shows one too (wireSessionToasts).
 */
export async function turnOn(need: Need): Promise<boolean> {
  const s = useStore.getState()
  const key = need === 'camera' ? 'camera' : need
  const cur = s.config?.settings[key]
  const base = { sessionSeconds: 30, autoApps: [] as string[], ...(need === 'camera' ? { deskMode: false } : {}), ...cur }
  const err = await saveSettingsConfirmed({ [key]: { ...base, enabled: true } })
  if (err) {
    toast(`Couldn’t turn on ${NAME[need]}`, { description: plainReason(err).text })
    return false
  }
  if (need !== 'sonar') client.send({ type: SESSION_START[SESSION[need]] })
  return true
}

/** Turns sonar off (the only way it stops, apart from pause, sleep, the lid and other speakers). */
export async function turnOffSonar(): Promise<boolean> {
  const cur = useStore.getState().config?.settings.sonar
  const err = await saveSettingsConfirmed({ sonar: { sessionSeconds: 30, autoApps: [], ...cur, enabled: false } })
  if (err) toast('Couldn’t turn off Sonar', { description: plainReason(err).text })
  return !err
}

/** Session errors from the daemon (permission denied, sonar refused...) as toasts, wherever they were asked for. */
export function wireSessionToasts(): void {
  let lastSonarTones: string | null = null
  client.on('session', (m) => {
    if (m.error) {
      toast(m.kind === 'sonar' ? 'Sonar isn’t listening' : `${SESSION_NAME[m.kind]} didn’t start`, { description: plainReason(m.error).text })
      return
    }
    if (m.kind !== 'sonar') return
    // Tell the user once when the tones stop (headphones, audio change), and once when they are back.
    const tones = m.active && m.sonarField === false ? (m.tonesOff ?? 'output is not the built-in speakers') : null
    if (tones && tones !== lastSonarTones) toast('Sonar tones paused', { description: plainReason(tones, true).text })
    else if (!tones && lastSonarTones && m.active) toast('Sonar tones back on')
    lastSonarTones = tones
  })
}

/** Inline note under a gesture that only works while a session runs. */
export function SessionNote({ gesture }: { gesture: GestureKind }): React.JSX.Element | null {
  const st = useNeed(gesture)
  const [ask, setAsk] = React.useState(false)
  const settings = useStore((s) => s.config?.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  if (!st) return null
  const key = st.need === 'camera' ? 'camera' : st.need
  const seen = (): boolean => {
    try {
      return localStorage.getItem(`gk.explained.${st.need}`) === '1'
    } catch {
      return false
    }
  }
  const go = (): void => {
    try {
      localStorage.setItem(`gk.explained.${st.need}`, '1')
    } catch {
      // shown again next time
    }
    void turnOn(st.need)
  }
  return (
    <div className="flex flex-col gap-2 text-[12px] leading-relaxed text-ink-2">
      {!st.enabled ? (
        <div className="flex items-center gap-3">
          <p className="flex-1 text-ink">
            Needs {st.name}. {st.name} is off.
          </p>
          <Button variant="outline" size="sm" onClick={() => (seen() ? go() : setAsk(true))}>
            Turn on
          </Button>
        </div>
      ) : st.need === 'sonar' ? (
        !st.listening || st.problem ? (
          <div className="flex items-start gap-3">
            <p className="flex-1">{st.problem ? <ProblemText problem={st.problem} /> : 'Sonar is on and starting.'}</p>
            <Button variant="text" size="sm" onClick={() => void turnOffSonar()}>
              Turn off
            </Button>
          </div>
        ) : null
      ) : (
        !st.listening && (
          <>
            <div className="flex items-start gap-3">
              <p className="flex-1">
                Only works while {st.name} is listening: start it from the menu bar or set it to start automatically in these apps.
              </p>
              <Button variant="text" size="sm" onClick={() => client.send({ type: SESSION_START[SESSION[st.need]] })}>
                Start now
              </Button>
            </div>
            <div className="flex justify-start">
              <AutoApps
                value={settings?.[key]?.autoApps ?? []}
                onChange={(autoApps) => {
                  const cur = settings?.[key]
                  saveSettings({ [key]: { sessionSeconds: 30, enabled: true, ...cur, autoApps } })
                }}
              />
            </div>
          </>
        )
      )}
      {st.enabled && st.listening && !st.problem && (
        <p className="text-ink-3">{st.need === 'sonar' ? 'Sonar is on and listening until you turn it off.' : `${st.name} is listening now.`}</p>
      )}
      <Confirm open={ask} onOpenChange={setAsk} title={`Turn on ${st.name}?`} body={EXPLAIN[st.need]} confirmLabel={`Turn on ${st.name}`} onConfirm={go} />
    </div>
  )
}

/** Enabled bindings that can't fire right now because their mode is off, grouped by mode. */
export function useBlockedBindings(): { need: Need; name: string; bindings: Binding[] }[] {
  const config = useStore((s) => s.config)
  if (!config) return []
  const out: { need: Need; name: string; bindings: Binding[] }[] = []
  for (const need of ['sound', 'sonar', 'camera'] as Need[]) {
    const key = need === 'camera' ? 'camera' : need
    if (config.settings[key]?.enabled) continue
    const bs = config.bindings.filter((b) => b.enabled && needFor(b.gesture) === need)
    if (bs.length) out.push({ need, name: NAME[need], bindings: bs })
  }
  return out
}
