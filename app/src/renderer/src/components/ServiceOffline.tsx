import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { defaultZones } from '@shared/defaults'
import { Button } from './ui/button'
import { Logo } from './Logo'
import { LaptopMap } from './laptop/LaptopMap'

function detail(d: ReturnType<typeof useStore.getState>['daemon']): { title: string; body: string; dev: React.ReactNode } {
  switch (d.kind) {
    case 'missing':
      return {
        title: 'Ghostkeys isn’t listening.',
        body: 'Its background helper is missing from this copy of the app. Reinstall Ghostkeys to bring your gestures back.',
        dev: (
          <>
            <p>
              Build the helper from the daemon folder with <code className="text-ink">swift build -c release</code>, then restart.
            </p>
            {d.searched.map((p) => (
              <p key={p} className="truncate">
                {p}
              </p>
            ))}
          </>
        )
      }
    case 'exited':
      return {
        title: 'Ghostkeys isn’t listening.',
        body: d.gaveUp
          ? 'Its background helper stopped several times in a row, so Ghostkeys stopped restarting it. Restart it when you are ready.'
          : 'Its background helper stopped. Restart it to bring your gestures back.',
        dev: (
          <>
            <p className="truncate">{d.path}</p>
            <p>{d.message ?? (d.code !== null ? `exit code ${d.code}` : d.signal ? `signal ${d.signal}` : 'exited')}</p>
          </>
        )
      }
    case 'mock':
      return {
        title: 'Ghostkeys isn’t listening.',
        body: 'The practice helper is not running.',
        dev: (
          <p>
            Start it with <code className="text-ink">pnpm mock</code>, or run the app with <code className="text-ink">pnpm dev:mock</code>.
          </p>
        )
      }
    default:
      return {
        title: 'Ghostkeys isn’t listening.',
        body: 'Its background helper is not answering yet. Restart it to bring your gestures back.',
        dev: <p>Waiting for 127.0.0.1:{useStore.getState().info?.port ?? 47823}.</p>
      }
  }
}

export function ServiceOffline(): React.JSX.Element {
  const daemon = useStore((s) => s.daemon)
  const packaged = useStore((s) => s.info?.packaged ?? false)
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const [busy, setBusy] = React.useState(false)
  const [details, setDetails] = React.useState(false)
  const { title, body, dev } = detail(daemon)

  const retry = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.gk.restartDaemon()
      client.retryNow()
    } finally {
      setTimeout(() => setBusy(false), 800)
    }
  }

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-y-16 right-[-12%] left-[52%] opacity-[0.12]" aria-hidden>
        <LaptopMap family={family} zones={defaultZones(family)} showLabels={false} />
      </div>
      <div className="drag h-[52px] shrink-0" />
      <div className="relative flex flex-1 items-center px-16 pb-16">
        <motion.div className="max-w-[460px]" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}>
          <Logo className="mb-8 size-9 text-ink-3" dotClassName="fill-[var(--ink-3)]" />
          <h1 className="text-[28px] leading-[1.15] font-medium tracking-[-0.02em]">{title}</h1>
          <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-ink-2">{body}</p>
          <div className="mt-8 flex items-center gap-5">
            <Button variant="primary" size="lg" onClick={() => void retry()} disabled={busy}>
              {busy ? 'Restarting' : 'Restart helper'}
            </Button>
            {!packaged && (
              <Button variant="text" onClick={() => setDetails((d) => !d)} aria-expanded={details}>
                {details ? 'Hide details' : 'Show details'}
              </Button>
            )}
          </div>
          <AnimatePresence>
            {details && !packaged && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
                className="overflow-hidden"
              >
                <div className="mt-8 space-y-1 pt-4 font-mono text-[11px] leading-relaxed text-ink-3 shadow-[0_-1px_0_var(--hairline)]">
                  <p className="label-mono pb-1">Developer</p>
                  {dev}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </div>
  )
}

export function ReconnectBanner(): React.JSX.Element {
  const conn = useStore((s) => s.conn)
  const everConnected = useStore((s) => s.everConnected)
  const show = everConnected && conn !== 'open'
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 32, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          className="flex shrink-0 items-center gap-2 overflow-hidden px-6 text-[12px] text-ink-2 hairline-b"
          role="status"
        >
          <span className="size-1.5 animate-[breathe_1.6s_ease-in-out_infinite] rounded-full bg-ink-3" />
          Lost the connection to the Ghostkeys helper. Reconnecting.
        </motion.div>
      )}
    </AnimatePresence>
  )
}
