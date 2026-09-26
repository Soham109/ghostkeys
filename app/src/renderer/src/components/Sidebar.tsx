import * as React from 'react'
import { motion } from 'motion/react'
import { Activity, Command, Crosshair, Settings2, SquareDashed, Waves, Pause, Play } from 'lucide-react'
import { useStore, type Route } from '@/lib/store'
import { client } from '@/lib/client'
import { cn } from '@/lib/utils'
import { FAMILY_LABEL } from '@shared/protocol'
import { Logo } from './Logo'
import { Tip } from './ui/controls'

const NAV: { route: Route; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { route: 'live', label: 'Live', icon: Activity },
  { route: 'zones', label: 'Zones', icon: SquareDashed },
  { route: 'bindings', label: 'Gestures and actions', icon: Command },
  { route: 'calibration', label: 'Calibration', icon: Crosshair },
  { route: 'sensors', label: 'Sensors', icon: Waves },
  { route: 'settings', label: 'Settings', icon: Settings2 }
]

/** A dot that lights in --signal for a moment whenever a tap is felt. */
function TouchDot({ state }: { state: 'on' | 'paused' | 'off' }): React.JSX.Element {
  const [pulse, setPulse] = React.useState(0)
  React.useEffect(() => client.on('tap', () => setPulse((p) => p + 1)), [])
  return (
    <span className="relative inline-flex size-2">
      <span
        className={cn(
          'absolute inset-0 rounded-full',
          state === 'on' ? 'bg-ink-2' : state === 'paused' ? 'bg-transparent shadow-[inset_0_0_0_1px_var(--ink-3)]' : 'bg-ink-3'
        )}
      />
      {pulse > 0 && (
        <motion.span
          key={pulse}
          className="absolute inset-0 rounded-full bg-signal"
          initial={{ opacity: 1, scale: 1 }}
          animate={{ opacity: 0, scale: 1.8 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
    </span>
  )
}

export function Sidebar(): React.JSX.Element {
  const route = useStore((s) => s.route)
  const navigate = useStore((s) => s.navigate)
  const conn = useStore((s) => s.conn)
  const status = useStore((s) => s.status)
  const hello = useStore((s) => s.hello)
  const setPaused = useStore((s) => s.setPaused)
  const paused = !!status?.paused
  const forceOffline = useStore((s) => s.forceOffline)
  const state = conn !== 'open' || forceOffline ? 'off' : paused ? 'paused' : 'on'

  return (
    <aside className="flex w-[220px] shrink-0 flex-col bg-[var(--sidebar)] in-data-[screenshot]:bg-[var(--sidebar-solid)]">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex items-center gap-2 px-4 pb-5">
        <Logo className="size-[18px] text-ink" />
        <span className="text-[14px] font-medium tracking-[-0.02em] lowercase">ghostkeys</span>
      </div>
      <nav className="flex flex-col gap-px px-2" aria-label="Sections">
        {NAV.map((item, i) => {
          const active = route === item.route
          const Icon = item.icon
          return (
            <button
              key={item.route}
              onClick={() => navigate(item.route)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'group relative flex h-7 items-center gap-2.5 rounded-[6px] px-2 text-left text-[13px] transition-colors duration-150',
                active ? 'text-ink' : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-[6px] bg-fill-active"
                  transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
                />
              )}
              <Icon className="relative size-[15px] shrink-0 opacity-80" />
              <span className="relative flex-1 truncate">{item.label}</span>
              <span className="relative font-mono text-[11px] text-ink-3 opacity-0 transition-opacity group-hover:opacity-100">⌘{i + 1}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-auto px-4 pb-4">
        <div className="flex items-center gap-2.5 py-2">
          <TouchDot state={state} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] text-ink">
              {state === 'off' ? 'Service not running' : paused ? 'Paused' : 'Listening'}
            </div>
            <div className="truncate text-[11px] text-ink-3">{hello ? FAMILY_LABEL[hello.device.family] : 'No device'}</div>
          </div>
          <Tip content={paused ? 'Resume' : 'Pause all gestures'}>
            <button
              disabled={state === 'off'}
              onClick={() => setPaused(!paused)}
              aria-label={paused ? 'Resume' : 'Pause'}
              className="inline-flex size-6 items-center justify-center rounded-[6px] text-ink-2 hover:bg-fill-hover hover:text-ink disabled:opacity-30"
            >
              {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            </button>
          </Tip>
        </div>
        <button
          onClick={() => useStore.setState({ paletteOpen: true })}
          className="flex h-7 w-full items-center justify-between rounded-[6px] px-2 text-[12px] text-ink-3 shadow-[inset_0_0_0_1px_var(--hairline)] hover:text-ink-2"
        >
          <span>Search and commands</span>
          <span className="font-mono text-[11px]">⌘K</span>
        </button>
      </div>
    </aside>
  )
}
