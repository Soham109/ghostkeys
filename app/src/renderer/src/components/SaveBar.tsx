import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useStore, isDirty } from '@/lib/store'
import { Button } from './ui/button'
import { Kbd } from './ui/controls'
import { Confirm } from './ui/overlays'

export function SaveBar(): React.JSX.Element {
  const dirty = useStore(isDirty)
  const route = useStore((s) => s.route)
  const saving = useStore((s) => s.saving)
  const save = useStore((s) => s.saveDraft)
  const discard = useStore((s) => s.discardDraft)
  const [ask, setAsk] = React.useState(false)
  const show = dirty && (route === 'zones' || route === 'bindings' || route === 'live')

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.24, ease: [0.2, 0, 0, 1] }}
          className="absolute bottom-5 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 material rounded-[10px] py-1.5 pr-1.5 pl-4"
          role="status"
        >
          <span className="text-[13px] text-ink-2">Unsaved changes</span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" onClick={() => setAsk(true)}>
              Discard
            </Button>
            <Button variant="primary" onClick={save} disabled={saving}>
              {saving ? 'Saving' : 'Save'}
              <Kbd className="ml-1 text-bg/60">⌘S</Kbd>
            </Button>
          </div>
        </motion.div>
      )}
      <Confirm
        key="confirm"
        open={ask}
        onOpenChange={setAsk}
        title="Discard your changes?"
        body="Your zone and binding edits since the last save are thrown away."
        confirmLabel="Discard changes"
        destructive
        onConfirm={discard}
      />
    </AnimatePresence>
  )
}
