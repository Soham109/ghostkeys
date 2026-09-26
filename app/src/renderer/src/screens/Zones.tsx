import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Plus, Trash2, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useStore } from '@/lib/store'
import { cn, slugify } from '@/lib/utils'
import { SURFACES, SURFACE_LABEL, type Rect, type Surface, type Zone } from '@shared/protocol'
import { ZONE_COLORS, defaultZones } from '@shared/defaults'
import { LAPTOPS, obstacles, rectsOverlap } from '@shared/laptop'
import { bindingsForZone } from '@/lib/bindings'
import { PageHeader, Empty } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Input, ZoneDot, Tip } from '@/components/ui/controls'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Confirm } from '@/components/ui/overlays'
import { LaptopMap } from '@/components/laptop/LaptopMap'

/** Finds a free spot on a surface for a new zone, scanning a coarse grid. */
function freeRect(surface: Surface, taken: Rect[], family: Parameters<typeof obstacles>[0]): Rect | null {
  const size: Record<Surface, { w: number; h: number }> = {
    base: { w: 0.12, h: 0.1 },
    lid: { w: 0.2, h: 0.3 },
    'edge-left': { w: 1, h: 0.2 },
    'edge-right': { w: 1, h: 0.2 },
    front: { w: 0.2, h: 1 }
  }
  const { w, h } = size[surface]
  const blocked = [...taken, ...obstacles(family, surface)]
  for (let y = 0; y <= 1 - h + 1e-6; y += 0.02) {
    for (let x = 0; x <= 1 - w + 1e-6; x += 0.02) {
      const r = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w, h }
      if (!blocked.some((b) => rectsOverlap(r, b))) return r
    }
  }
  return null
}

function Inspector({ zone, onDelete }: { zone: Zone; onDelete: () => void }): React.JSX.Element {
  const setDraft = useStore((s) => s.setDraft)
  const family = useStore((s) => s.hello?.device.family ?? 'macbook-pro-14')
  const update = (patch: Partial<Zone>): void =>
    setDraft((c) => ({ ...c, zones: c.zones.map((z) => (z.id === zone.id ? { ...z, ...patch } : z)) }))

  const moveTo = (surface: Surface): void => {
    setDraft((c) => {
      const taken = c.zones.filter((z) => z.surface === surface && z.id !== zone.id).map((z) => z.rect)
      const rect = freeRect(surface, taken, LAPTOPS[family])
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
      className="flex flex-col gap-5 px-4 py-4"
    >
      <label className="flex flex-col gap-1.5">
        <span className="label-mono">Name</span>
        <Input value={zone.name} onChange={(e) => update({ name: e.target.value })} aria-label="Zone name" />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="label-mono">Surface</span>
        <Select value={zone.surface} onValueChange={(v) => moveTo(v as Surface)}>
          <SelectTrigger aria-label="Surface">
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
        <span className="label-mono">Color</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Zone color">
          {ZONE_COLORS.map((c) => (
            <button
              key={c}
              role="radio"
              aria-checked={zone.color === c}
              aria-label={c}
              onClick={() => update({ color: c })}
              className={cn(
                'size-5 rounded-full transition-shadow duration-150',
                zone.color === c ? 'shadow-[0_0_0_2px_var(--bg),0_0_0_3px_var(--ink)]' : 'hover:shadow-[0_0_0_2px_var(--bg),0_0_0_3px_var(--hairline-strong)]'
              )}
              style={{ background: c }}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="label-mono">Position</span>
        <dl className="grid grid-cols-4 gap-2 font-mono text-[12px]">
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <div key={k} className="flex flex-col">
              <dt className="text-[11px] text-ink-3 uppercase">{k}</dt>
              <dd className="num text-ink-2">{zone.rect[k].toFixed(2)}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <Button variant="danger" size="md" className="-ml-3" onClick={onDelete}>
          <Trash2 />
          Delete zone
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
  const [confirmDelete, setConfirmDelete] = React.useState<Zone | null>(null)
  const [confirmReset, setConfirmReset] = React.useState(false)
  const family = hello?.device.family ?? 'macbook-pro-14'
  const zones = draft?.zones ?? []
  const zone = zones.find((z) => z.id === selected)

  const addZone = (surface: Surface): void => {
    if (!draft) return
    const taken = draft.zones.filter((z) => z.surface === surface).map((z) => z.rect)
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
    const color = ZONE_COLORS.find((c) => !draft.zones.some((z) => z.color === c)) ?? ZONE_COLORS[n % ZONE_COLORS.length]!
    setDraft((c) => ({ ...c, zones: [...c.zones, { id, name, surface, rect, color }] }))
    setSelected(id)
  }

  const deleteZone = (z: Zone): void => {
    setDraft((c) => ({ ...c, zones: c.zones.filter((x) => x.id !== z.id) }))
    setSelected(null)
  }

  const bound = (z: Zone): number => (draft ? bindingsForZone(draft, z.id).length : 0)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement
      if (t.closest('input,textarea,[role=dialog]')) return
      if ((e.key === 'Backspace' || e.key === 'Delete') && zone) {
        e.preventDefault()
        setConfirmDelete(zone)
      } else if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [zone])

  return (
    <>
      <PageHeader
        title="Zones"
        subtitle={`${zones.length} zones`}
        actions={
          <>
            <Tip content="Restore the default zones for this MacBook">
              <Button variant="ghost" size="icon" aria-label="Restore defaults" onClick={() => setConfirmReset(true)}>
                <RotateCcw />
              </Button>
            </Tip>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="primary">
                  <Plus />
                  Add zone
                </Button>
              </MenuTrigger>
              <MenuContent align="end">
                <MenuLabel>Surface</MenuLabel>
                {SURFACES.map((s) => (
                  <MenuItem key={s} onSelect={() => addZone(s)}>
                    {SURFACE_LABEL[s]}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 shadow-[0_-1px_0_var(--hairline)]">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(60% 55% at 50% 48%, var(--light-behind), transparent 70%)' }}
          />
          <div className="relative min-h-0 flex-1 px-10 pt-8 pb-4">
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
          <p className="relative px-6 pb-5 text-[12px] text-ink-3">
            Drag a zone to move it, or a corner to resize. Arrow keys nudge, Option with arrows resizes. Zones snap to a grid and
            never overlap each other, the keyboard or the trackpad.
          </p>
        </div>
        <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto shadow-[-1px_0_0_var(--hairline)]">
          <div className="px-4 pt-4">
            <p className="label-mono pb-2">All zones</p>
          </div>
          {zones.length ? (
            <ul className="shadow-[0_-1px_0_var(--hairline)]" role="listbox" aria-label="Zones">
              {zones.map((z) => (
                <li key={z.id} role="option" aria-selected={z.id === selected}>
                  <button
                    onClick={() => setSelected(z.id === selected ? null : z.id)}
                    className={cn(
                      'flex h-9 w-full items-center gap-2.5 px-4 text-left shadow-[0_1px_0_var(--hairline)] transition-colors duration-150',
                      z.id === selected ? 'bg-fill-active' : 'hover:bg-fill-hover'
                    )}
                  >
                    <ZoneDot color={z.color} />
                    <span className="flex-1 truncate text-[13px]">{z.name}</span>
                    <span className="text-[11px] text-ink-3">{SURFACE_LABEL[z.surface]}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty title="No zones.">Add one from the button above, or restore the defaults for this MacBook.</Empty>
          )}
          <AnimatePresence mode="wait">{zone && <Inspector key={zone.id} zone={zone} onDelete={() => setConfirmDelete(zone)} />}</AnimatePresence>
        </aside>
      </div>
      <Confirm
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? 'zone'}?`}
        body={
          confirmDelete && bound(confirmDelete) > 0
            ? `${bound(confirmDelete)} binding${bound(confirmDelete) === 1 ? ' uses' : 's use'} this zone and will stop working. Recalibrate after deleting zones.`
            : 'Recalibrate after changing zones so Ghostkeys learns the new layout.'
        }
        confirmLabel="Delete zone"
        onConfirm={() => confirmDelete && deleteZone(confirmDelete)}
      />
      <Confirm
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Restore the default zones?"
        body="Your zones are replaced with the defaults for this MacBook. Bindings stay, and you can discard before saving."
        confirmLabel="Restore defaults"
        onConfirm={() => {
          setDraft((c) => ({ ...c, zones: defaultZones(family) }))
          setSelected(null)
        }}
      />
    </>
  )
}
