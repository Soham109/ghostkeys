import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'
import { cn, slugify, clamp } from '@/lib/utils'
import { SURFACES, SURFACE_LABEL, type Rect, type Surface, type Zone } from '@shared/protocol'
import { defaultZones } from '@shared/defaults'
import { LAPTOPS, obstacles, rectsOverlap, surfaceMm, type LaptopSpec } from '@shared/laptop'
import { bindingsForZone } from '@/lib/bindings'
import { PageHeader, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { ProTag, ZoneIndex } from '@/components/ui/controls'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Confirm } from '@/components/ui/overlays'
import { LaptopMap, normalizeRect } from '@/components/laptop/LaptopMap'

/** Finds the largest free spot on a surface for a new zone, scanning a coarse grid. */
function freeRect(surface: Surface, taken: Rect[], spec: LaptopSpec): Rect | null {
  const size: Record<Surface, { w: number; h: number }> = {
    base: { w: 0.12, h: 0.1 },
    lid: { w: 0.2, h: 0.3 },
    'edge-left': { w: 1, h: 0.2 },
    'edge-right': { w: 1, h: 0.2 },
    front: { w: 0.2, h: 1 }
  }
  const { w, h } = size[surface]
  const blocked = [...taken, ...obstacles(spec, surface)]
  for (let y = 0; y <= 1 - h + 1e-6; y += 0.02) {
    for (let x = 0; x <= 1 - w + 1e-6; x += 0.02) {
      const r = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w, h }
      if (!blocked.some((b) => rectsOverlap(r, b))) return r
    }
  }
  return null
}

const PRO_SURFACE = (z: Zone): boolean => !['left-palm', 'right-palm'].includes(z.id)

/** A millimetre readout you can drag sideways to change, like a pro Mac app. */
function Scrub({ label, mm, onDelta }: { label: string; mm: number; onDelta: (dMm: number) => void }): React.JSX.Element {
  const start = React.useRef<number | null>(null)
  return (
    <div className="flex flex-col">
      <span
        className="tag-mono cursor-ew-resize text-ink-3 select-none"
        onPointerDown={(e) => {
          start.current = e.clientX
          ;(e.target as Element).setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          if (start.current === null) return
          const d = e.clientX - start.current
          if (Math.abs(d) >= 4) {
            onDelta(Math.round(d / 4))
            start.current = e.clientX
          }
        }}
        onPointerUp={() => (start.current = null)}
        title="Drag sideways to change"
      >
        {label}
      </span>
      <span className="num text-[12px] text-ink-2">{Math.round(mm)} mm</span>
    </div>
  )
}

function Inspector({ zone, onDelete }: { zone: Zone; onDelete: () => void }): React.JSX.Element {
  const setDraft = useStore((s) => s.setDraft)
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const spec = LAPTOPS[family]
  const mm = surfaceMm(spec, zone.surface)
  const r = normalizeRect(zone.surface, zone.rect)
  const [armed, setArmed] = React.useState(false)
  React.useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 2000)
    return () => clearTimeout(t)
  }, [armed])

  const update = (patch: Partial<Zone>): void => setDraft((c) => ({ ...c, zones: c.zones.map((z) => (z.id === zone.id ? { ...z, ...patch } : z)) }))

  const nudge = (k: keyof Rect, dMm: number): void => {
    const scale = k === 'x' || k === 'w' ? mm.w : mm.h
    const next = { ...r, [k]: r[k] + dMm / scale }
    next.w = clamp(next.w, 0.03, 1)
    next.h = clamp(next.h, 0.03, 1)
    next.x = clamp(next.x, 0, 1 - next.w)
    next.y = clamp(next.y, 0, 1 - next.h)
    const others = useStore.getState().draft?.zones.filter((z) => z.id !== zone.id && z.surface === zone.surface).map((z) => normalizeRect(z.surface, z.rect)) ?? []
    const obs = obstacles(spec, zone.surface).filter((o) => !rectsOverlap(r, o))
    if ([...others, ...obs].some((o) => rectsOverlap(next, o))) return
    update({ rect: normalizeRect(zone.surface, next) })
  }

  const moveTo = (surface: Surface): void => {
    setDraft((c) => {
      const taken = c.zones.filter((z) => z.surface === surface && z.id !== zone.id).map((z) => normalizeRect(z.surface, z.rect))
      const rect = freeRect(surface, taken, spec)
      if (!rect) {
        toast('That surface is full', { description: `Make room on the ${SURFACE_LABEL[surface].toLowerCase()} first.` })
        return c
      }
      return { ...c, zones: c.zones.map((z) => (z.id === zone.id ? { ...z, surface, rect } : z)) }
    })
  }

  return (
    <motion.div
      key={zone.id}
      initial={{ opacity: 0, x: 12 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.28, ease: [0.2, 0, 0, 1] }}
      className="flex flex-1 flex-col gap-6 px-4 pt-6 pb-6"
    >
      <input
        value={zone.name}
        onChange={(e) => update({ name: e.target.value })}
        aria-label="Zone name"
        className="-mx-1.5 rounded-[6px] px-1.5 py-1 text-[15px] font-medium text-ink outline-none hover:shadow-[inset_0_0_0_1px_var(--hairline)] focus:shadow-[inset_0_0_0_1px_var(--ink-3)]"
      />
      <div className="flex flex-col gap-1">
        <span className="label-mono">Surface</span>
        <Select value={zone.surface} onValueChange={(v) => moveTo(v as Surface)}>
          <SelectTrigger borderless aria-label="Surface">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SURFACES.map((s) => (
              <SelectItem key={s} value={s}>
                {SURFACE_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <span className="label-mono">Position</span>
        <div className="grid grid-cols-4 gap-2">
          <Scrub label="X" mm={r.x * mm.w} onDelta={(d) => nudge('x', d)} />
          <Scrub label="Y" mm={r.y * mm.h} onDelta={(d) => nudge('y', d)} />
          <Scrub label="W" mm={r.w * mm.w} onDelta={(d) => nudge('w', d)} />
          <Scrub label="H" mm={r.h * mm.h} onDelta={(d) => nudge('h', d)} />
        </div>
      </div>
      <div className="mt-auto">
        <Button
          variant="text"
          className={armed ? 'text-ink' : undefined}
          onClick={() => {
            if (armed) onDelete()
            else setArmed(true)
          }}
        >
          {armed ? 'Click again to delete' : 'Delete zone'}
        </Button>
      </div>
    </motion.div>
  )
}

export function ZonesScreen(): React.JSX.Element {
  const hello = useStore((s) => s.hello)
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  const [selected, setSelected] = React.useState<string | null>(null)
  const [confirmReset, setConfirmReset] = React.useState(false)
  const family = hello?.device.family ?? 'macbook-pro-14'
  const zones = draft?.zones ?? []
  const zone = zones.find((z) => z.id === selected)

  const addZone = (surface: Surface): void => {
    if (!draft) return
    const taken = draft.zones.filter((z) => z.surface === surface).map((z) => normalizeRect(z.surface, z.rect))
    const rect = freeRect(surface, taken, LAPTOPS[family])
    if (!rect) {
      toast('No room left there', { description: `Shrink or move a zone on the ${SURFACE_LABEL[surface].toLowerCase()} first.` })
      return
    }
    let n = draft.zones.length + 1
    let name = `Zone ${n}`
    while (draft.zones.some((z) => z.name === name)) name = `Zone ${++n}`
    let id = slugify(name)
    while (draft.zones.some((z) => z.id === id)) id = `${id}-x`
    setDraft((c) => ({ ...c, zones: [...c.zones, { id, name, surface, rect, color: '#8A8A90' }] }))
    setSelected(id)
  }

  const deleteZone = (z: Zone): void => {
    const n = draft ? bindingsForZone(draft, z.id).length : 0
    setDraft((c) => ({ ...c, zones: c.zones.filter((x) => x.id !== z.id) }))
    setSelected(null)
    toast(`Deleted ${z.name}`, { description: n ? `${n} binding${n === 1 ? '' : 's'} used it and will do nothing until you change them.` : 'Recalibrate so Ghostkeys learns the new layout.' })
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,[role=dialog]')) return
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <PageHeader
        title="Zones"
        subtitle={`${String(zones.length).padStart(2, '0')} zones`}
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(true)}>
              Reset
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary">Add zone</Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Surface</MenuLabel>
                {SURFACES.map((s) => (
                  <MenuItem key={s} onSelect={() => addZone(s)}>
                    <span className="flex-1">{SURFACE_LABEL[s]}</span>
                    <ProTag feature="Custom zones" />
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(60% 55% at 50% 48%, var(--light-behind), transparent 70%)' }} />
          <div className="relative min-h-0 flex-1 px-8 pt-6 pb-4">
            {draft && (
              <LaptopMap
                family={family}
                zones={zones}
                mode="edit"
                selectedId={selected}
                onSelect={setSelected}
                onZoneChange={(id, rect) => setDraft((c) => ({ ...c, zones: c.zones.map((z) => (z.id === id ? { ...z, rect } : z)) }))}
              />
            )}
          </div>
          <p className="relative px-8 pb-6 text-[12px] text-ink-3">Drag to move. Drag a corner to resize. Arrow keys nudge; &#x2325; + arrows resize.</p>
        </div>
        <aside className="flex w-[320px] shrink-0 flex-col overflow-y-auto shadow-[-1px_0_0_var(--hairline)]">
          <p className="label-mono px-4 pt-6 pb-2">All zones</p>
          {zones.length ? (
            <ul className="shadow-[0_-1px_0_var(--hairline)]" role="listbox" aria-label="Zones">
              {zones.map((z, i) => (
                <li key={z.id} role="option" aria-selected={z.id === selected}>
                  <button
                    onClick={() => setSelected(z.id === selected ? null : z.id)}
                    onContextMenu={async (e) => {
                      e.preventDefault()
                      setSelected(z.id)
                      const id = await window.gk.contextMenu([
                        { id: 'reset', label: 'Reset Position' },
                        { type: 'separator' },
                        { id: 'delete', label: 'Delete Zone' }
                      ])
                      if (id === 'delete') deleteZone(z)
                      else if (id === 'reset') {
                        const d = defaultZones(family).find((x) => x.id === z.id)
                        if (d) setDraft((c) => ({ ...c, zones: c.zones.map((x) => (x.id === z.id ? { ...x, surface: d.surface, rect: d.rect } : x)) }))
                        else toast('This zone has no default position')
                      }
                    }}
                    className={cn(
                      'flex h-8 w-full items-center gap-2.5 px-4 text-left shadow-[0_1px_0_var(--hairline)] transition-colors duration-150',
                      z.id === selected ? 'bg-fill-active' : 'hover:bg-fill-hover'
                    )}
                  >
                    <ZoneIndex n={i + 1} className={z.id === selected ? 'text-ink' : undefined} />
                    <span className="flex-1 truncate text-[13px]">{z.name}</span>
                    {PRO_SURFACE(z) && <ProTag />}
                    <span className="text-[12px] text-ink-3">{SURFACE_LABEL[z.surface]}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No zones.">Add one, or reset to the defaults for this MacBook.</Empty>
          )}
          <AnimatePresence mode="wait">{zone && <Inspector key={zone.id} zone={zone} onDelete={() => deleteZone(zone)} />}</AnimatePresence>
        </aside>
      </div>
      <Confirm
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset to the default zones?"
        body="Your zones are replaced with the defaults for this MacBook. Bindings stay, and nothing is saved until you press Save."
        confirmLabel="Reset zones"
        onConfirm={() => {
          setDraft((c) => ({ ...c, zones: defaultZones(family) }))
          setSelected(null)
        }}
      />
    </>
  )
}
