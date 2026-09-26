import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { dim, err, fmtPercent, fmtTimestamp, ok } from '../format.js'
import pc from 'picocolors'

export function registerWatch(program: Command): void {
  program
    .command('watch')
    .description('live stream of taps, gestures and actions')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('--seconds <n>', 'stop automatically after N seconds, instead of running until ctrl-c', (v) => Number.parseFloat(v))
    .option('--rejected', 'also show taps the daemon threw out (typing, trackpad, etc.)')
    .action(async (opts: { port?: number; seconds?: number; rejected?: boolean }) => {
      const client = createClient({ port: opts.port, reconnect: true })
      try {
        await client.connect()
      } catch (error) {
        fail(`could not reach ghostkeysd: ${(error as Error).message}`)
        return
      }
      client.subscribe(['taps'])

      console.log(dim('watching taps, gestures and actions. press ctrl-c to stop.'))

      client.on('tap', (t) => {
        console.log(`${dim(fmtTimestamp(t.t))}  ${pc.cyan('tap')}       ${t.zone}  ${dim(`confidence ${fmtPercent(t.confidence)}`)}`)
      })
      if (opts.rejected) {
        client.on('rejected', (r) => {
          console.log(`${dim(fmtTimestamp(r.t))}  ${dim('rejected')}  ${r.reason}`)
        })
      }
      client.on('gesture', (g) => {
        const where = g.zone ?? (g.zones ? g.zones.join(' then ') : 'anywhere')
        const mods = g.modifiers.length ? dim(` +${g.modifiers.join('+')}`) : ''
        console.log(`${dim(fmtTimestamp(g.t))}  ${pc.magenta('gesture')}   ${g.gesture} ${where}${mods}`)
      })
      client.on('action', (a) => {
        const status = a.ok ? ok('ok') : err(a.error ?? 'failed')
        console.log(`${dim(fmtTimestamp(a.t))}  ${a.ok ? ok('action') : err('action')}    ${a.label}  ${status}`)
      })
      client.on('reconnecting', ({ attempt }) => console.log(dim(`connection lost, reconnecting (attempt ${attempt})...`)))
      client.on('reconnected', () => {
        console.log(ok('reconnected'))
        client.subscribe(['taps'])
      })

      if (opts.seconds !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, opts.seconds! * 1000))
        client.disconnect()
        return
      }

      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => {
          client.disconnect()
          resolve()
        })
      })
    })
}
