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
    MicMarker.clearIfOurs()
    SPUDriverControl.shared.restore()
    ProcessRunner.killAll()
}
// Signals are handled on a dedicated queue, never the main thread (SAFETY_AUDIT H1).
Lifetime.installSignalHandlers()

// Where the daemon keeps its files: --config-dir, then GHOSTKEYS_CONFIG_DIR, else
// ~/Library/Application Support/Ghostkeys/daemon/ (moving files an older version left one level up).
ConfigStore.configure(override: options.configDir)
ConfigStore.migrateLegacyFiles()

// One daemon at a time on the sensors: the lock is machine-wide (default directory), whatever --config-dir says,
// because two instances would fight over the sensor driver settings. A --simulate-sensors daemon never touches
// hardware, so it only locks its own config directory.
if options.simulateSensors {
    InstanceLock.acquireOrExit(directory: ConfigStore.baseDirectory)
} else {
    try? FileManager.default.createDirectory(at: ConfigStore.defaultDirectory, withIntermediateDirectories: true,
                                             attributes: [.posixPermissions: 0o700])
    InstanceLock.acquireOrExit(directory: ConfigStore.defaultDirectory)
}

// A previous run that crashed or was SIGKILLed may have left the motion sensors on: undo that first.
let recovered = options.simulateSensors ? nil : SPUDriverControl.shared.recoverFromCrashedRun()

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
