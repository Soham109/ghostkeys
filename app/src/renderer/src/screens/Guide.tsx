import * as React from 'react'
import { useStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import { PageHeader, ScrollBody } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { ProTag } from '@/components/ui/controls'
import { GestureDemo } from '@/components/gestures/GestureDemo'
import { GESTURE_INFO, GROUP_ORDER, type GestureInfo } from '@/components/gestures/info'
import { uid } from '@/lib/utils'
import { CAMERA_GESTURES, SONAR_AIR_GESTURES } from '@shared/protocol'

function supported(info: GestureInfo, hello: ReturnType<typeof useStore.getState>['hello']): boolean | null {
  if (!hello) return null
  switch (info.needs) {
    case 'imu':
      return hello.sensors.imu
    case 'lid':
      return hello.sensors.lid
    case 'light':
      return hello.sensors.light
    case 'sound':
      return !!hello.sensors.sound
    case 'camera':
      return !!hello.sensors.camera
    case 'grilles':
      return hello.device.family.startsWith('macbook-pro')
    default:
      return true
  }
}

function Row({ info }: { info: GestureInfo }): React.JSX.Element {
  const hello = useStore((s) => s.hello)
  const draft = useStore((s) => s.draft)
  const ok = supported(info, hello)
  const use = (): void => {
    if (!info.gesture || !draft) return
    const g = info.gesture
    const zone = ['tap', 'double', 'triple', 'rhythm', 'knock_knuckle'].includes(g)
      ? (draft.zones[0]?.id ?? null)
      : g.startsWith('finger_slide')
        ? (draft.zones.find((z) => z.id === 'right-grille')?.id ?? draft.zones[0]?.id ?? null)
        : [...CAMERA_GESTURES, ...SONAR_AIR_GESTURES].includes(g)
          ? 'air'
          : null
    useStore.getState().navigate('bindings')
    useStore.setState({
      editorSeed: {
        id: uid('b'),
        enabled: true,
        gesture: info.gesture,
        zone,
        zones: info.gesture === 'sequence' ? [draft.zones[0]?.id ?? '', draft.zones[1]?.id ?? ''] : null,
        modifiers: [],
        app: '*',
        action: info.gesture === 'hover_level' ? { kind: 'volume', step: 6 } : { kind: 'media', command: 'playpause' },
        label: info.gesture === 'hover_level' ? 'Volume' : 'Play or pause',
        knob: info.gesture === 'pinch_hold' ? { axis: 'y', stepPx: 24 } : null,
        slider: info.gesture === 'hover_level' ? { mode: 'relative', stepMm: 15, inverse: { kind: 'volume', step: -6 } } : null
      }
    })
  }
  return (
    <li id={`g-${info.id}`} className="grid grid-cols-[232px_1fr] gap-8 py-5 shadow-[0_1px_0_var(--hairline)]">
      <GestureDemo gesture={info.id} className="h-[148px] w-[232px] rounded-[6px] bg-sunken shadow-[inset_0_0_0_1px_var(--hairline)]" label={`${info.label}: ${info.how}`} />
      <div className="flex min-w-0 flex-col py-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-medium">{info.label}</h3>
          {info.pro && <ProTag />}
          {info.coming && <span className="tag-mono text-ink-3">Coming soon</span>}
        </div>
        <p className="mt-1 max-w-[52ch] text-[13px] leading-relaxed text-ink-2">{info.how}</p>
        <dl className="mt-4 grid grid-cols-[88px_1fr] gap-x-4 gap-y-1 text-[12px]">
          <dt className="tag-mono pt-px text-ink-3">Where</dt>
          <dd className="text-ink-2">{info.surfaces}</dd>
          <dt className="tag-mono pt-px text-ink-3">Macs</dt>
          <dd className="text-ink-2">{info.macs}</dd>
          <dt className="tag-mono pt-px text-ink-3">This Mac</dt>
          <dd className={cn(ok === false ? 'text-ink-3' : 'text-ink-2')}>{ok === null ? 'Checking' : ok ? 'Works here' : 'Not on this Mac'}</dd>
        </dl>
        {info.gesture && !info.coming && ok !== false && (
          <div className="mt-auto pt-3">
            <Button variant="text" size="sm" onClick={use}>
              Use this gesture
            </Button>
          </div>
        )}
      </div>
    </li>
  )
}

export function GuideScreen(): React.JSX.Element {
  const [group, setGroup] = React.useState<string>('All')
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const list = group === 'All' ? GESTURE_INFO : GESTURE_INFO.filter((g) => g.group === group)
  return (
    <>
      <PageHeader title="Gesture guide" subtitle={`${GESTURE_INFO.length} gestures`} />
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[180px] shrink-0 flex-col gap-px px-2 pt-2" aria-label="Gesture groups">
          {['All', ...GROUP_ORDER].map((g) => (
            <button
              key={g}
              onClick={() => {
                setGroup(g)
                bodyRef.current?.scrollTo({ top: 0 })
              }}
              aria-current={group === g ? 'true' : undefined}
              className={cn(
                'flex h-7 items-center justify-between rounded-[6px] px-2 text-left text-[13px] transition-colors duration-150',
                group === g ? 'bg-fill-active text-ink' : 'text-ink-2 hover:bg-fill-hover hover:text-ink'
              )}
            >
              {g}
              <span className="num text-[11px] text-ink-3">{g === 'All' ? GESTURE_INFO.length : GESTURE_INFO.filter((x) => x.group === g).length}</span>
            </button>
          ))}
        </nav>
        <ScrollBody ref={bodyRef} className="fade-bottom px-8 pb-16">
          {(group === 'All' ? GROUP_ORDER : [group]).map((g) => {
            const items = list.filter((x) => x.group === g)
            if (!items.length) return null
            return (
              <section key={g} aria-label={g} className="pt-6">
                <h2 className="label-mono pb-2">{g}</h2>
                <ul className="max-w-[760px] shadow-[0_-1px_0_var(--hairline)]">
                  {items.map((info) => (
                    <Row key={info.id} info={info} />
                  ))}
                </ul>
              </section>
            )
          })}
        </ScrollBody>
      </div>
    </>
  )
}
