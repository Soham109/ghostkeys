import type { Command } from 'commander'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { dim, fmtPercent, ok } from '../format.js'
import { pressEnter } from '../prompt.js'

export function registerCalibrate(program: Command): void {
  program
    .command('calibrate')
    .description('interactive calibration wizard: capture taps per zone, then negatives, then train')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('-t, --target <n>', 'samples to capture per zone', (v) => Number.parseInt(v, 10), 20)
    .option('-z, --zones <ids>', 'comma-separated zone ids (default: every configured zone)')
    .option('-n, --negatives <seconds>', 'seconds of negative (typing/trackpad) samples', (v) => Number.parseInt(v, 10), 45)
    .action(async (opts: { port?: number; target: number; zones?: string; negatives: number }) => {
      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config } = await client.getConfig()
        const zoneIds = opts.zones
          ? opts.zones
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : config.zones.map((z) => z.id)

        if (zoneIds.length === 0) {
          fail('no zones to calibrate. Add one first: gk zones add <id> <name>')
          return
        }

        console.log(`calibrating ${zoneIds.length} zone(s), ${opts.target} taps each`)
        const flow = await client.startCalibration(zoneIds, opts.target)
        flow.onProgress((p) => {
          if (p.phase === 'capturing') process.stdout.write(`\r  ${p.zone}: ${p.count}/${p.target}   `)
        })

        for (const zone of zoneIds) {
          await pressEnter(`Tap the "${zone}" zone ${opts.target} times, then press enter to start.`)
          await flow.captureZone(zone)
          process.stdout.write('\n')
          console.log(ok(`  ${zone} captured`))
        }

        await pressEnter(`Now type and use the trackpad normally for about ${opts.negatives}s, then press enter to start.`)
        console.log(dim('capturing negatives...'))
        await flow.negatives(opts.negatives)

        console.log(dim('training...'))
        const report = await flow.finish()
        console.log(ok(`done: overall accuracy ${fmtPercent(report.overall)}`))
        for (const [zone, accuracy] of Object.entries(report.accuracy)) {
          console.log(`  ${zone}: ${fmtPercent(accuracy)}`)
        }
      } catch (error) {
        fail(`calibration failed: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
