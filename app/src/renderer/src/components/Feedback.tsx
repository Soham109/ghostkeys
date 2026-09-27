import * as React from 'react'
import { toast } from 'sonner'
import { useStore, zoneNumber } from '@/lib/store'
import { client } from '@/lib/client'
import { Button } from './ui/button'
import { ZoneIndex } from './ui/controls'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from './ui/overlays'

/** Turns a raw service message into one plain sentence. */
export function plainError(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('rate limit')) return 'Too many actions fired at once, so Ghostkeys paused itself for safety. Resume it from the sidebar.'
  if (m.includes('not approved')) return 'That action needs your approval first. Open it and choose Test or Save to approve it.'
  if (m.includes('accessibility')) return 'Ghostkeys needs Accessibility access to press keys. Allow it in System Settings, Privacy and Security.'
  if (m.includes('invalid config') || m.includes('config_set')) return 'Ghostkeys couldn\u2019t save that change. Nothing was changed.'
  if (m.includes('calibration_start first')) return 'Calibration isn\u2019t running. Start it again from Calibration.'
  if (m.includes('unknown zone')) return 'That zone no longer exists. Pick another one.'
  if (m.includes('paused')) return 'Ghostkeys is paused, so nothing ran. Resume it from the sidebar.'
  if (m.includes('timed out') || m.includes('timeout')) return 'That took too long and was stopped.'
  if (m.includes('automation') || m.includes('not allowed to send apple events')) return 'macOS blocked Ghostkeys from controlling that app. Allow it in System Settings, Privacy and Security, Automation.'
  return 'Ghostkeys couldn\u2019t do that.'
}

/** Results of "Missed a tap" and "That wasn't me", as toasts, wherever they were sent from. */
export function wireFeedbackToasts(): void {
  client.on('error', (e) => {
    // Settings saves report their own errors; everything else gets one plain sentence.
    if (/config/i.test(e.message)) return
    const text = plainError(e.message)
    toast(text, text === 'Ghostkeys couldn\u2019t do that.' ? { description: e.message } : undefined)
  })
  client.on('action', (a) => {
    if ((a.bindingId === null || a.bindingId === 'test') && !a.ok) {
      const text = plainError(a.error ?? '')
      toast('The test didn\u2019t run', { description: text === 'Ghostkeys couldn\u2019t do that.' ? (a.error ?? undefined) : text })
    }
  })
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
