import type { Command } from 'commander'
import { describeAction } from '../describe.js'
import { fail } from '../fail.js'
import { dim, table } from '../format.js'
import { loadPresets, presetsLibraryPath, searchPresets } from '../presets.js'

export function registerPresets(program: Command): void {
  const presets = program.command('presets').description('search the shared preset library')

  presets
    .command('search <query>')
    .description('search presets by id, name, category or keywords')
    .action(async (query: string) => {
      let library
      try {
        library = await loadPresets()
      } catch (error) {
        fail((error as Error).message)
        return
      }
      if (!library) {
        console.log(dim(`no preset library found at ${presetsLibraryPath()}`))
        return
      }
      const results = searchPresets(library, query)
      if (results.length === 0) {
        console.log(dim(`no presets match "${query}"`))
        return
      }
      const rows = results.map((p) => [
        p.id,
        p.title,
        p.category,
        describeAction(p.action) + (p.destructive ? ` ${dim('(destructive)')}` : ''),
        p.apps.includes('*') ? dim('any app') : p.apps.join(', ')
      ])
      console.log(table(['id', 'title', 'category', 'action', 'apps'], rows))
    })
}
