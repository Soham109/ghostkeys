import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { HudPayload } from '@shared/ipc'
import '../styles/globals.css'
import './hud.css'

const HOLD_MS = 1100

function Hud(): React.JSX.Element {
  const [payload, setPayload] = React.useState<HudPayload | null>(null)
  const reduce = useReducedMotion()

  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.gk.onHud((p) => {
      setPayload(p)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setPayload(null), HOLD_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [])

  return (
    <div className="flex h-full items-start justify-center pt-3">
      <AnimatePresence>
        {payload && (
          <motion.div
            key="pill"
            layout
            initial={{ opacity: 0, y: reduce ? 0 : -8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: [0.2, 0, 0, 1] } }}
            exit={{ opacity: 0, y: reduce ? 0 : -4, transition: { duration: 0.24, ease: [0.2, 0, 0, 1] } }}
            transition={{ layout: { duration: 0.24, ease: [0.2, 0, 0, 1] } }}
            className="hud-pill"
          >
            <motion.span layout="position" key={`dot${payload.id}`} className={payload.ok ? 'hud-dot' : 'hud-dot is-error'} />
            <motion.span layout="position" key={`t${payload.id}`} className="hud-title">
              {payload.title}
            </motion.span>
            {payload.detail && (
              <>
                <motion.span layout="position" key={`d${payload.id}`} className="hud-detail-wrap">
                  <span className="hud-sep" aria-hidden>
                    &middot;
                  </span>
                  <span className={payload.ok ? 'hud-detail' : 'hud-detail is-error'}>{payload.detail}</span>
                </motion.span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

if (new URLSearchParams(location.search).has('backdrop')) document.documentElement.dataset.backdrop = '1'
createRoot(document.getElementById('root')!).render(<Hud />)
