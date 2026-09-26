import * as React from 'react'
import { toast } from 'sonner'
import { useStore, zoneNumber } from '@/lib/store'
import { client } from '@/lib/client'
import { Button } from './ui/button'
import { ZoneIndex } from './ui/controls'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from './ui/overlays'

/** Results of "Missed a tap" and "That wasn't me", as toasts, wherever they were sent from. */
export function wireFeedbackToasts(): void {
  client.on('feedback', (m) => {
    const cfg = useStore.getState().config
    const name = (id?: string): string => (id ? (cfg?.zones.find((z) => z.id === id)?.name ?? id) : 'the last tap')
    if (m.kind === 'missed') {
      if (m.found && m.retrained) {
        const n = m.counts?.[m.zone]
        toast(`Learned that tap on the ${name(m.zone).toLowerCase()}`, {
          description: `${n ? `It now has ${n} samples. ` : ''}${m.candidate ? `It had been dropped as ${m.candidate.droppedBecause.replace('_', ' ')}.` : ''}`.trim() || undefined
        })
      } else toast('Couldn’t find that tap', { description: m.reason ? `${m.reason[0]!.toUpperCase()}${m.reason.slice(1)}.` : 'Try again right after tapping.' })
    } else {
      toast(m.retrained ? `Noted: ${name(m.zone).toLowerCase()} wasn’t you` : 'Nothing to correct', {
        description: m.retrained ? 'Ghostkeys will be less eager to fire on bumps like that one. What it did is not undone.' : m.reason
      })
    }
  })
}

/** Two quiet actions that teach Ghostkeys from its mistakes. */
export function FeedbackActions(): React.JSX.Element {
  const config = useStore((s) => s.config)
  const open = useStore((s) => s.missedPickerOpen)
  const zones = (config?.zones ?? []).filter((z) => z.enabled !== false)
  return (
    <div className="flex items-center gap-4">
      <Menu open={open} onOpenChange={(o) => useStore.setState({ missedPickerOpen: o })}>
        <MenuTrigger asChild>
          <Button variant="text" size="sm">
            Missed a tap
          </Button>
        </MenuTrigger>
        <MenuContent align="end" className="w-56">
          <MenuLabel>Where did you tap?</MenuLabel>
          {zones.map((z) => (
            <MenuItem key={z.id} onSelect={() => client.send({ type: 'feedback_missed', zone: z.id })}>
              <ZoneIndex n={zoneNumber(config, z.id)} />
              {z.name}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <Button variant="text" size="sm" onClick={() => client.send({ type: 'feedback_false' })}>
        That wasn&rsquo;t me
      </Button>
    </div>
  )
}
