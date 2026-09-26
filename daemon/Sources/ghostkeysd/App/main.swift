import Foundation
import AppKit
import GhostkeysDetection

// ghostkeysd: reads the built-in sensors, detects gestures, runs actions, serves ws://127.0.0.1:47823/.

let options = Options.parse(CommandLine.arguments)
Log.verbose = options.verbose
_ = Clock.start

// Sensor driver settings are put back however we leave: normal exit, SIGINT/SIGTERM/SIGHUP, parent death, or exit()
// anywhere. Crashes and SIGKILL are covered by spu-originals.json, restored on the next start or --restore-sensors.
atexit {
    SPUDriverControl.shared.restore()
    ProcessRunner.killAll()
}
// Signals are handled on a dedicated queue, never the main thread (SAFETY_AUDIT H1).
Lifetime.installSignalHandlers()

// One daemon at a time: two would fight over the sensor driver settings. Applies to every mode.
InstanceLock.acquireOrExit(directory: ConfigStore().directory)

// A previous run that crashed or was SIGKILLed may have left the motion sensors on: undo that first.
let recovered = SPUDriverControl.shared.recoverFromCrashedRun()

if options.restoreSensors {
    print(recovered ?? "nothing to restore: no sensor settings were left behind")
    exit(0)
}

if options.selftest {
    exit(SelfTest.run())
}

if let seconds = options.dumpIMUSeconds {
    SelfTest.dumpIMU(seconds: seconds)
    exit(0)
}

let daemon: Daemon
do {
    daemon = try Daemon(options: options)
    try daemon.start()
} catch {
    Log.error("could not start: \(error)")
    exit(1)
}
let parentWatch = ParentWatch { reason in Lifetime.shutdown(reason) }
parentWatch.start(explicitParent: options.parentPID)

// The main run loop services the main dispatch queue (AppKit calls from actions) and NSWorkspace notifications.
// Nothing needed for shutdown runs here.
RunLoop.main.run()
