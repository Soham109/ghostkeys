import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { ok } from '../format.js'

export function registerPauseResume(program: Command): void {
  program
    .command('pause')
    .description('pause the daemon: no actions run until resumed')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        await client.pause()
        console.log(ok('paused'))
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })

  program
    .command('resume')
    .description('resume the daemon')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        await client.resume()
        console.log(ok('resumed'))
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
