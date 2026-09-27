import * as React from 'react'
import { CAMERA_GESTURES, SESSION_START, SONAR_GESTURES, SOUND_GESTURES, type Binding, type GestureKind, type SessionKind } from '@shared/protocol'
import { useStore } from '@/lib/store'
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
    'Sonar plays two inaudible tones (19.5 and 20.25 kHz) at a low level through the built-in speakers and listens for their echo, so macOS shows its orange dot. Some pets and young people can hear the tones. Sessions stop by themselves. macOS may ask once for microphone access.',
  camera:
    'The camera add-on watches your hand in short sessions, so macOS shows its green light. Frames are never saved or sent anywhere. macOS may ask once for camera access.'
}

export interface NeedState {
  need: Need
  name: string
  enabled: boolean
  listening: boolean
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
  return { need, name: NAME[need], enabled, listening }
}

function turnOn(need: Need): void {
  const s = useStore.getState()
  const key = need === 'camera' ? 'camera' : need
  const cur = s.config?.settings[key]
  const base = { sessionSeconds: 30, autoApps: [] as string[], ...(need === 'camera' ? { deskMode: false } : {}), ...cur }
  s.saveSettings({ [key]: { ...base, enabled: true } })
  setTimeout(() => client.send({ type: SESSION_START[SESSION[need]] }), 200)
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
    turnOn(st.need)
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
      {st.enabled && st.listening && <p className="text-ink-3">{st.name} is listening now.</p>}
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
