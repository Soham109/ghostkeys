import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Command } from 'commander'
import { createClient, daemonPortHint, waitFor } from '../connection.js'
import { err, ok } from '../format.js'

function line(passed: boolean, label: string, detail?: string): string {
  const mark = passed ? ok('OK  ') : err('FAIL')
  return detail ? `${mark}  ${label} (${detail})` : `${mark}  ${label}`
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description("check that the daemon, sensors, permissions and model are all in good shape")
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const lines: string[] = []
      let healthy = true
      const client = createClient({ port: opts.port })

      let hello
      try {
        hello = await client.connect()
      } catch (error) {
        lines.push(line(false, 'ghostkeysd reachable', `port ${daemonPortHint(opts.port)}: ${(error as Error).message}`))
        console.log(lines.join('\n'))
        process.exitCode = 1
        return
      }
      lines.push(line(true, 'ghostkeysd reachable', `v${hello.version}, ${hello.device.model}`))

      for (const [sensor, present] of Object.entries(hello.sensors)) {
        lines.push(line(present, `sensor: ${sensor}`))
        healthy = healthy && present
      }

      lines.push(
        line(
          hello.permissions.accessibility,
          'accessibility permission',
          hello.permissions.accessibility ? undefined : 'grant it in System Settings, or run gk status after granting'
        )
      )
      healthy = healthy && hello.permissions.accessibility

      // The daemon sends "status" once, unprompted, right after "hello" as part of connecting: by
      // the time we get here it has very likely already arrived and been recorded on the client,
      // so prefer that over registering a fresh listener (which could otherwise wait out the full
      // timeout for an event that already came and went).
      const status = client.lastStatus ?? (await waitFor(client, 'status'))
      lines.push(line(!!status?.calibrated, 'daemon reports a trained model'))
      healthy = healthy && !!status?.calibrated

      const modelDir = path.join(os.homedir(), 'Library', 'Application Support', 'Ghostkeys', 'model')
      const modelPresent = existsSync(modelDir) && readdirSync(modelDir).length > 0
      lines.push(line(modelPresent, 'model files on disk', modelPresent ? modelDir : `nothing in ${modelDir}, run gk calibrate`))
      healthy = healthy && modelPresent

      console.log(lines.join('\n'))
      client.disconnect()
      if (!healthy) process.exitCode = 1
    })
}
