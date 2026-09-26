import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore } from '@/lib/store'
import { client } from '@/lib/client'
import { Button } from './ui/button'
import { Logo } from './Logo'

function detail(d: ReturnType<typeof useStore.getState>['daemon'], port: number): { title: string; body: React.ReactNode } {
  switch (d.kind) {
    case 'missing':
      return {
        title: 'The Ghostkeys service is not built yet',
        body: (
          <>
            The app talks to a small background service, ghostkeysd, that reads the motion sensor. Build it from the
            daemon folder with <code className="font-mono text-[12px] text-ink">swift build -c release</code>, then try again.
          </>
        )
      }
    case 'exited':
      return {
        title: 'The Ghostkeys service stopped',
        body: d.message
          ? `It could not start: ${d.message}`
          : `It exited${d.code !== null ? ` with code ${d.code}` : d.signal ? ` after ${d.signal}` : ''}. Try starting it again.`
      }
    case 'mock':
      return {
        title: 'The mock service is not running',
        body: (
          <>
            Start it with <code className="font-mono text-[12px] text-ink">pnpm mock</code>, or run the app with{' '}
            <code className="font-mono text-[12px] text-ink">pnpm dev:mock</code>.
          </>
        )
      }
    default:
      return {
        title: 'The Ghostkeys service is not running',
        body: `Waiting for it to accept connections on 127.0.0.1:${port}.`
      }
  }
}

export function ServiceOffline(): React.JSX.Element {
  const daemon = useStore((s) => s.daemon)
  const port = useStore((s) => s.info?.port ?? 47823)
  const [busy, setBusy] = React.useState(false)
  const { title, body } = detail(daemon, port)

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
    <div className="flex flex-1 flex-col">
      <div className="drag h-[52px] shrink-0" />
      <div className="flex flex-1 items-center px-16 pb-16">
        <motion.div
          className="max-w-[520px]"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <Logo className="mb-8 size-10 text-ink-3" />
          <p className="label-mono mb-3">Service</p>
          <h1 className="text-[28px] leading-[1.15] font-medium tracking-[-0.02em]">{title}</h1>
          <p className="mt-3 max-w-[60ch] text-[13px] leading-relaxed text-ink-2">{body}</p>
          {daemon.kind === 'missing' && (
            <ul className="mt-5 space-y-1">
              {daemon.searched.map((p) => (
                <li key={p} className="truncate font-mono text-[11px] text-ink-3">
                  {p}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-8 flex gap-2">
            <Button variant="primary" onClick={retry} disabled={busy}>
              {busy ? 'Starting' : 'Try again'}
            </Button>
          </div>
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
          Lost the connection to the Ghostkeys service. Reconnecting.
        </motion.div>
      )}
    </AnimatePresence>
  )
}
