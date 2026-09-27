import * as React from 'react'
import { Command } from 'cmdk'
import { Dialog } from './ui/overlays'
import { useStore, type Route } from '@/lib/store'
import { client } from '@/lib/client'

const GO: { route: Route; label: string; keys: string }[] = [
  { route: 'live', label: 'Live', keys: '⌘1' },
  { route: 'zones', label: 'Zones', keys: '⌘2' },
  { route: 'bindings', label: 'Gestures and actions', keys: '⌘3' },
  { route: 'calibration', label: 'Calibration', keys: '⌘4' },
  { route: 'sensors', label: 'Sensors', keys: '⌘5' },
  { route: 'sonar', label: 'Sonar', keys: '⌘6' },
  { route: 'settings', label: 'Settings', keys: '⌘7' },
  { route: 'guide', label: 'Gesture guide', keys: '⌘8' }
]

export function CommandPalette(): React.JSX.Element {
  const open = useStore((s) => s.paletteOpen)
  const paused = useStore((s) => !!s.status?.paused)
  const run = (fn: () => void) => () => {
    useStore.setState({ paletteOpen: false })
    fn()
  }
  const s = useStore.getState

  return (
    <Dialog open={open} onOpenChange={(o) => useStore.setState({ paletteOpen: o })} title="Commands" className="top-[22%] w-[560px] translate-y-0">
      <Command label="Commands" className="flex flex-col" loop>
        <Command.Input
          autoFocus
          placeholder="Search commands"
          className="h-12 w-full bg-transparent px-4 text-[15px] text-ink outline-none placeholder:text-ink-3 hairline-b"
        />
        <Command.List className="max-h-[340px] overflow-y-auto px-1.5 pt-1.5 pb-2">
          <Command.Empty className="px-3 py-6 text-[13px] text-ink-3">No matching commands</Command.Empty>
          <Group heading="Go to">
            {GO.map((g) => (
              <Item key={g.route} onSelect={run(() => s().navigate(g.route))} keys={g.keys}>
                {g.label}
              </Item>
            ))}
          </Group>
          <Group heading="Actions">
            <Item onSelect={run(() => s().setPaused(!paused))}>{paused ? 'Resume Ghostkeys' : 'Pause Ghostkeys'}</Item>
            <Item onSelect={run(() => s().navigate('calibration'))}>Start calibration</Item>
            <Item
              onSelect={run(() => {
                s().navigate('bindings')
                useStore.setState({ editingBinding: 'new' })
              })}
              keys="⌘N"
            >
              New binding
            </Item>
            <Item
              onSelect={run(() => {
                s().navigate('bindings')
                useStore.setState({ presetsOpen: true })
              })}
            >
              Browse the action library
            </Item>
            <Item onSelect={run(() => client.send({ type: 'sound_session_start' }))}>Listen with the microphone for a while</Item>
            <Item onSelect={run(() => client.send({ type: 'air_session_start' }))}>Watch for hand gestures for a while</Item>
            <Item onSelect={run(() => useStore.setState({ onboarding: true, onboardingStep: 0 }))}>Show the welcome tour</Item>
          </Group>
          <Group heading="Appearance">
            <Item onSelect={run(() => void s().setPrefs({ theme: 'system' }))}>Use system appearance</Item>
            <Item onSelect={run(() => void s().setPrefs({ theme: 'light' }))}>Use light appearance</Item>
            <Item onSelect={run(() => void s().setPrefs({ theme: 'dark' }))}>Use dark appearance</Item>
          </Group>
        </Command.List>
      </Command>
    </Dialog>
  )
}

function Group({ heading, children }: { heading: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Command.Group
      heading={heading}
      className="[&_[cmdk-group-heading]]:tag-mono [&_[cmdk-group-heading]]:text-ink-3 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1"
    >
      {children}
    </Command.Group>
  )
}

function Item({ children, onSelect, keys }: { children: React.ReactNode; onSelect: () => void; keys?: string }): React.JSX.Element {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center justify-between rounded-[6px] px-2.5 text-[13px] text-ink-2 data-[selected=true]:bg-fill-active data-[selected=true]:text-ink"
    >
      {children}
      {keys && <span className="num text-[11px] text-ink-2">{keys}</span>}
    </Command.Item>
  )
}
