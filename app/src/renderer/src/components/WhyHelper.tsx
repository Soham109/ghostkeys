import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { client } from '@/lib/client'
import { useStore } from '@/lib/store'
import { explain } from '@/lib/why'
import type { RejectedMsg } from '@shared/protocol'
import { Button } from './ui/button'

/** "Why didn't that work?": the last dropped tap, in one sentence, with the one action that fixes it. */
export function WhyHelper(): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [picking, setPicking] = React.useState(false)
  const [last, setLast] = React.useState<{ m: RejectedMsg; at: number } | null>(null)
  const config = useStore((s) => s.config)
  React.useEffect(() => client.on('rejected', (m) => setLast({ m, at: Date.now() })), [])
  const recent = last && Date.now() - last.at < 30_000 ? last.m : null
  const name = (id: string): string => config?.zones.find((z) => z.id === id)?.name ?? id
  const why = explain(recent, config?.settings, name)
  const act = (): void => {
    const s = useStore.getState()
    switch (why.action?.run) {
      case 'shorten-typing':
        s.saveSettings({ typingGateMs: Math.max(150, (s.config?.settings.typingGateMs ?? 450) - 150) })
        toast('Typing pause shortened', { description: 'Taps right after typing are now accepted sooner.' })
        break
      case 'teach':
        setPicking(true)
        return
      case 'resume':
        s.setPaused(false)
        break
      case 'raise-sensitivity':
        s.saveSettings({ sensitivity: Math.min(1, (s.config?.settings.sensitivity ?? 0.5) + 0.15) })
        toast('Sensitivity raised', { description: 'Lighter taps now count. If bumps start firing, lower it in Settings.' })
        break
      case 'lower-certainty':
        s.saveSettings({ minConfidence: Math.max(0.6, (s.config?.settings.minConfidence ?? 0.8) - 0.05) })
        toast('Ghostkeys now accepts slightly less certain taps')
        break
    }
    setOpen(false)
  }
  return (
    <div className="px-4 py-3 shadow-[0_-1px_0_var(--hairline)]">
      <Button variant="text" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        Why didn&rsquo;t that work?
      </Button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <p className="pt-2 text-[13px] leading-relaxed text-ink">{why.sentence}</p>
            {why.action && why.action.run !== 'none' && !picking && (
              <Button variant="outline" size="sm" className="mt-2" onClick={act}>
                {why.action.label}
              </Button>
            )}
            {picking && (
              <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Where did you tap?">
                {(config?.zones ?? [])
                  .filter((z) => z.enabled !== false)
                  .map((z) => (
                    <Button
                      key={z.id}
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        client.send({ type: 'feedback_missed', zone: z.id })
                        setPicking(false)
                        setOpen(false)
                      }}
                    >
                      {z.name}
                    </Button>
                  ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
