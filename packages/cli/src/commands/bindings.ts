import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { describeAction, isDestructive } from '../describe.js'
import { fail } from '../fail.js'
import { dim, err, ok, table } from '../format.js'

export function registerBindings(program: Command): void {
  program
    .command('bindings')
    .description('list configured bindings')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config } = await client.getConfig()
        if (config.bindings.length === 0) {
          console.log(dim('no bindings configured'))
          return
        }
        const rows = config.bindings.map((b) => {
          const zone = b.zone ?? (b.zones ? b.zones.join(' then ') : dim('any'))
          const mods = b.modifiers.length ? b.modifiers.join('+') : dim('none')
          const app = b.app === '*' ? dim('any app') : b.app
          const action = describeAction(b.action) + (isDestructive(b.action) ? ` ${err('(destructive)')}` : '')
          return [b.id, b.enabled ? ok('yes') : dim('no'), b.gesture, zone, mods, app, action]
        })
        console.log(table(['id', 'enabled', 'gesture', 'zone', 'modifiers', 'app', 'action'], rows))
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
