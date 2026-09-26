#!/usr/bin/env node
import { Command } from 'commander'
import { registerBind } from './commands/bind.js'
import { registerBindings } from './commands/bindings.js'
import { registerCalibrate } from './commands/calibrate.js'
import { registerDoctor } from './commands/doctor.js'
import { registerExport } from './commands/export.js'
import { registerImport } from './commands/import.js'
import { registerPauseResume } from './commands/pause-resume.js'
import { registerPresets } from './commands/presets.js'
import { registerStatus } from './commands/status.js'
import { registerUnbind } from './commands/unbind.js'
import { registerWatch } from './commands/watch.js'
import { registerZones } from './commands/zones.js'

const VERSION = '0.1.0'

const program = new Command()
program.name('gk').description('a terminal client for ghostkeysd').version(VERSION)

registerStatus(program)
registerWatch(program)
registerZones(program)
registerBind(program)
registerUnbind(program)
registerBindings(program)
registerExport(program)
registerImport(program)
registerPauseResume(program)
registerCalibrate(program)
registerPresets(program)
registerDoctor(program)

program.parseAsync(process.argv)
