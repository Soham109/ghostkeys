import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'

export function registerExport(program: Command): void {
  program
    .command('export')
    .description('print the current config as JSON (redirect to a file: gk export > layout.json)')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config } = await client.getConfig()
        process.stdout.write(`${JSON.stringify(config, null, 2)}\n`)
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
