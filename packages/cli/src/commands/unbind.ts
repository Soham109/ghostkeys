import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { ok } from '../format.js'

export function registerUnbind(program: Command): void {
  program
    .command('unbind <id>')
    .description('remove a binding by id (see gk bindings)')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (id: string, opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config, revision } = await client.getConfig()
        if (!config.bindings.some((b) => b.id === id)) {
          fail(`no binding "${id}". Run gk bindings to see what's configured.`)
          return
        }
        await client.setConfig({ ...config, bindings: config.bindings.filter((b) => b.id !== id) }, { ifRevision: revision })
        console.log(ok(`removed ${id}`))
      } catch (error) {
        fail(`could not update config: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
