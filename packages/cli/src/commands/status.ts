import type { Command } from 'commander'
import { createClient, waitFor } from '../connection.js'
import { fail } from '../fail.js'
import { dim, ok, table, warn } from '../format.js'

export function registerStatus(program: Command): void {
  program
    .command('status')
    .description('show the daemon connection, sensors, permissions and current status')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .action(async (opts: { port?: number }) => {
      const client = createClient({ port: opts.port })
      try {
        const hello = await client.connect()
        const status = client.lastStatus ?? (await waitFor(client, 'status'))
        const sensors = Object.entries(hello.sensors)
          .filter(([, present]) => present)
          .map(([name]) => name)
        const rows: string[][] = [
          ['version', hello.version],
          ['device', `${hello.device.model} (${hello.device.chip})`],
          ['family', hello.device.family],
          ['sensors', sensors.length ? sensors.join(', ') : warn('none')],
          ['accessibility', hello.permissions.accessibility ? ok('granted') : warn('not granted')],
          ['paused', status ? (status.paused ? warn('yes') : 'no') : dim('unknown')],
          ['calibrated', status ? (status.calibrated ? ok('yes') : warn('no')) : dim('unknown')],
          ['zones', status ? String(status.zones.length) : dim('unknown')],
          ['imu rate', status ? `${status.imuHz} Hz` : dim('unknown')]
        ]
        console.log(table(['field', 'value'], rows))
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
