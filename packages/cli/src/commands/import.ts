import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import { schemas, type Config } from '@ghostkeys/sdk'
import { createClient } from '../connection.js'
import { diffConfig } from '../diff.js'
import { fail } from '../fail.js'
import { ok } from '../format.js'
import { confirm } from '../prompt.js'

export function registerImport(program: Command): void {
  program
    .command('import <file>')
    .description('import a layout.json: shows a diff against the current config, then asks to confirm')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('-y, --yes', 'apply without asking for confirmation')
    .action(async (file: string, opts: { port?: number; yes?: boolean }) => {
      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch (error) {
        fail(`could not read ${file}: ${(error as Error).message}`)
        return
      }
      let data: unknown
      try {
        data = JSON.parse(raw)
      } catch (error) {
        fail(`${file} is not valid JSON: ${(error as Error).message}`)
        return
      }
      const result = schemas.configSchema.safeParse(data)
      if (!result.success) {
        fail(`${file} is not a valid config: ${result.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
        return
      }
      const next = result.data as Config

      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config: current, revision } = await client.getConfig()

        console.log('changes from the current config:')
        console.log(diffConfig(current, next).join('\n'))

        if (!opts.yes) {
          const proceed = await confirm('Apply this config?')
          if (!proceed) {
            console.log('cancelled')
            return
          }
        }
        await client.setConfig(next, { ifRevision: revision })
        console.log(ok(`imported ${file}`))
      } catch (error) {
        fail(`could not update config: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
