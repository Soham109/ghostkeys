import * as React from 'react'
import { motion } from 'motion/react'
import { useStore, type Route } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'

export const NAV: { route: Route; label: string }[] = [
  { route: 'live', label: 'Live' },
  { route: 'zones', label: 'Zones' },
  { route: 'bindings', label: 'Gestures and actions' },
  { route: 'calibration', label: 'Calibration' },
  { route: 'sensors', label: 'Sensors' },
  { route: 'settings', label: 'Settings' }
]

/** A dot that lights in --signal for a moment whenever a tap is felt. */
function TouchDot({ state }: { state: 'on' | 'paused' | 'off' }): React.JSX.Element {
  const [pulse, setPulse] = React.useState(0)
  React.useEffect(() => client.on('tap', () => setPulse((p) => p + 1)), [])
  return (
    <span className="relative inline-flex size-1.5">
      <span
        className={cn(
          'absolute inset-0 rounded-full',
          state === 'on' ? 'bg-ink-2' : state === 'paused' ? 'shadow-[inset_0_0_0_1px_var(--ink-3)]' : 'bg-ink-3/50'
        )}
      />
      {pulse > 0 && (
        <motion.span
          key={pulse}
          className="absolute inset-0 rounded-full bg-signal"
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
    </span>
  )
}

/** Microphone or camera open right now: say so plainly, with a way to stop it. */
function SessionLine(): React.JSX.Element | null {
  const sessions = useStore((s) => s.sessions)
  const active = (['sound', 'air'] as const).filter((k) => sessions[k]?.active)
  const [, tick] = React.useState(0)
  React.useEffect(() => {
    if (!active.length) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active.length])
  if (!active.length) return null
  return (
    <div className="flex flex-col gap-1 pb-2">
      {active.map((k) => {
        const m = sessions[k]!
        return (
          <div key={k} className="flex items-center gap-2.5 text-[12px]" role="status">
            <span className="size-1.5 rounded-full bg-ink" />
            <span className="flex-1 text-ink">{k === 'sound' ? 'Microphone on' : 'Camera on'}</span>
            <span className="num text-[11px] text-ink-3">{Math.max(0, Math.round(m.secondsLeft))}s</span>
            <button
              className="text-[12px] text-ink-2 hover:text-ink"
              onClick={() => client.send({ type: k === 'sound' ? 'sound_session_stop' : 'air_session_stop' })}
            >
              Stop
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function Sidebar({ offline }: { offline?: boolean }): React.JSX.Element {
  const route = useStore((s) => s.route)
  const navigate = useStore((s) => s.navigate)
  const conn = useStore((s) => s.conn)
  const status = useStore((s) => s.status)
  const setPaused = useStore((s) => s.setPaused)
  const focused = useStore((s) => s.windowFocused)
  const paused = !!status?.paused
  const state = conn !== 'open' || offline ? 'off' : paused ? 'paused' : 'on'

  return (
    <aside className="flex w-[220px] shrink-0 flex-col bg-[var(--sidebar)] in-data-[screenshot]:bg-[var(--sidebar-solid)]">
      <div className="drag h-[52px] shrink-0" />
      <nav className="flex flex-col gap-px px-2" aria-label="Sections">
        {NAV.map((item, i) => {
          const active = route === item.route
          return (
            <button
              key={item.route}
              disabled={offline}
              onClick={() => navigate(item.route)}
              aria-current={active ? 'page' : undefined}
              aria-keyshortcuts={`Meta+${i + 1}`}
              className={cn(
                'relative flex h-7 items-center gap-2 rounded-[6px] px-2 text-left text-[13px] transition-colors duration-150',
                offline ? 'text-ink-3' : active ? 'text-ink' : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              )}
            >
              {active && !offline && (
                <motion.span
                  layoutId="nav-active"
                  className={cn('absolute inset-0 rounded-[6px]', focused ? 'bg-fill-active' : 'bg-fill-hover')}
                  transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
                />
              )}
              <span className={cn('num relative w-6 text-[11px] tracking-[0.06em]', active && !offline ? 'text-ink' : 'text-ink-3')}>
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="relative flex-1 truncate">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-4 pb-4">
        <SessionLine />
        <div className="flex items-center gap-2.5 py-2">
          <TouchDot state={state} />
          <span className="flex-1 truncate text-[12px] text-ink-2">
            {state === 'off' ? 'Not listening' : status?.pausedReason === 'rate_limit' ? 'Paused for safety' : paused ? 'Paused' : 'Listening'}
          </span>
          <button
            disabled={state === 'off'}
            onClick={() => setPaused(!paused)}
            className="text-[12px] text-ink-2 hover:text-ink disabled:opacity-30"
            aria-label={paused ? 'Resume Ghostkeys' : 'Pause Ghostkeys'}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
        </div>
        <button
          onClick={() => useStore.setState({ paletteOpen: true })}
          className="flex h-7 w-full items-center justify-between rounded-[6px] px-2 text-[12px] text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] hover:text-ink-2"
        >
          <span>Search and commands</span>
          <span className="num text-[11px] text-ink-2">⌘K</span>
        </button>
      </div>
    </aside>
  )
}
