import type { Command } from 'commander'
import { SURFACES, type Surface, type Zone } from '@ghostkeys/sdk'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { dim, ok, table } from '../format.js'

function parseRect(spec: string): Zone['rect'] {
  const parts = spec.split(',').map((s) => Number.parseFloat(s.trim()))
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`--rect needs "x,y,w,h" (0..1 each), got "${spec}"`)
  }
  const [x, y, w, h] = parts as [number, number, number, number]
  return { x, y, w, h }
}

export function registerZones(program: Command): void {
  const zones = program.command('zones').description('list, add or remove zones')

  zones
    .command('list')
    .description('list configured zones')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config } = await client.getConfig()
        if (config.zones.length === 0) {
          console.log(dim('no zones configured'))
          return
        }
        const rows = config.zones.map((z) => [
          z.id,
          z.name,
          z.surface,
          `${z.rect.x.toFixed(2)},${z.rect.y.toFixed(2)},${z.rect.w.toFixed(2)},${z.rect.h.toFixed(2)}`,
          z.color
        ])
        console.log(table(['id', 'name', 'surface', 'rect (x,y,w,h)', 'color'], rows))
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })

  zones
    .command('add <id> <name>')
    .description('add a zone')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('--surface <surface>', `one of ${SURFACES.join(', ')}`, 'base')
    .option('--rect <x,y,w,h>', 'normalized rect, each 0..1', '0.1,0.1,0.2,0.2')
    .option('--color <hex>', 'hex color for the zone editor', '#6E9BFF')
    .action(async (id: string, name: string, opts: { port?: number; surface: string; rect: string; color: string }) => {
      if (!(SURFACES as readonly string[]).includes(opts.surface)) {
        fail(`unknown surface "${opts.surface}". Known surfaces: ${SURFACES.join(', ')}`)
        return
      }
      let rect: Zone['rect']
      try {
        rect = parseRect(opts.rect)
      } catch (error) {
        fail((error as Error).message)
        return
      }
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config, revision } = await client.getConfig()
        if (config.zones.some((z) => z.id === id)) {
          fail(`a zone with id "${id}" already exists`)
          return
        }
        const zone: Zone = { id, name, surface: opts.surface as Surface, rect, color: opts.color }
        await client.setConfig({ ...config, zones: [...config.zones, zone] }, { ifRevision: revision })
        console.log(ok(`added zone ${id}`))
      } catch (error) {
        fail(`could not update config: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })

  zones
    .command('rm <id>')
    .description('remove a zone')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('-f, --force', 'remove even if bindings still reference this zone')
    .action(async (id: string, opts: { port?: number; force?: boolean }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config, revision } = await client.getConfig()
        if (!config.zones.some((z) => z.id === id)) {
          fail(`no zone "${id}"`)
          return
        }
        const referencedBy = config.bindings.filter((b) => b.zone === id || b.zones?.includes(id))
        if (referencedBy.length > 0 && !opts.force) {
          fail(`zone "${id}" is used by binding(s) ${referencedBy.map((b) => b.id).join(', ')}; pass --force to remove it anyway`)
          return
        }
        await client.setConfig({ ...config, zones: config.zones.filter((z) => z.id !== id) }, { ifRevision: revision })
        console.log(ok(`removed zone ${id}`))
      } catch (error) {
        fail(`could not update config: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
