import type { Command } from 'commander'
import { actionsNeedingApproval } from '@ghostkeys/sdk'
import { resolveActionArg, ActionArgError } from '../action-arg.js'
import { buildBinding, describeBinding, nextBindingId, unknownZones } from '../binding.js'
import { createClient } from '../connection.js'
import { fail } from '../fail.js'
import { isDestructive, describeAction } from '../describe.js'
import { dim, ok } from '../format.js'
import { BindGrammarError, parseBindSpec } from '../grammar.js'
import { loadPresets } from '../presets.js'
import { confirm } from '../prompt.js'

export function registerBind(program: Command): void {
  program
    .command('bind <spec> <action>')
    .description('add a binding. <spec> is "<gesture> [zone] [+modifiers] [@app]", <action> is inline JSON or a preset id')
    .option('-p, --port <port>', 'daemon port (default 47823)', (v) => Number.parseInt(v, 10))
    .option('-l, --label <label>', 'label for this binding (default: a description of the action)')
    .option('--disabled', 'create the binding disabled')
    .option('-y, --yes', 'skip confirmation prompts (destructive actions, approvals)')
    .action(async (specArg: string, actionArg: string, opts: { port?: number; label?: string; disabled?: boolean; yes?: boolean }) => {
      let spec
      try {
        spec = parseBindSpec(specArg)
      } catch (error) {
        if (error instanceof BindGrammarError) fail(error.message)
        else fail(`could not parse bind spec: ${(error as Error).message}`)
        return
      }

      let resolved
      try {
        const presets = await loadPresets()
        resolved = resolveActionArg(actionArg, presets)
      } catch (error) {
        if (error instanceof ActionArgError) fail(error.message)
        else fail(`could not resolve action: ${(error as Error).message}`)
        return
      }

      if (isDestructive(resolved.action) && !opts.yes) {
        const proceed = await confirm(`${describeAction(resolved.action)} can quit an app. Bind it anyway?`)
        if (!proceed) {
          console.log('cancelled')
          return
        }
      }

      const client = createClient({ port: opts.port })
      try {
        await client.connect()
        const { config, revision } = await client.getConfig()

        const missing = unknownZones(spec, config.zones)
        if (missing.length > 0) {
          fail(`unknown zone(s): ${missing.join(', ')}. Known zones: ${config.zones.map((z) => z.id).join(', ') || 'none'}`)
          return
        }

        // open, shell, applescript and shortcut actions only run once the daemon has an approved
        // hash for them (docs/PROTOCOL.md "Authentication"): approve_action, sent here after this
        // confirmation, is what "the app shows a native confirmation" means for gk. Without this,
        // the binding would be written but silently never fire ("not approved" on every attempt).
        const gated = actionsNeedingApproval(resolved.action)
        if (gated.length > 0) {
          console.log(dim('This binding runs action(s) that need approval before they can run:'))
          for (const g of gated) console.log(dim(`  ${describeAction(g)}`))
          const proceed = opts.yes || (await confirm('Approve them now?'))
          if (!proceed) {
            fail('cancelled: binding not created (the action(s) above were not approved)')
            return
          }
          for (const g of gated) {
            const { hash } = await client.approveAction(g)
            // actionsNeedingApproval() only ever returns the four gated kinds (open/shell/applescript/
            // shortcut), which all carry approvedHash; the wider SimpleAction type just doesn't say so.
            ;(g as { approvedHash?: string }).approvedHash = hash
          }
        }

        const binding = buildBinding(spec, resolved.action, {
          id: nextBindingId(config.bindings),
          enabled: !opts.disabled,
          label: opts.label ?? resolved.label
        })
        await client.setConfig({ ...config, bindings: [...config.bindings, binding] }, { ifRevision: revision })
        console.log(ok(`bound ${binding.id}: `) + describeBinding(binding))
      } catch (error) {
        fail(`could not update config: ${(error as Error).message}`)
      } finally {
        client.disconnect()
      }
    })
}
