import Foundation
import AppKit
import GhostkeysDetection

// ghostkeysd: reads the built-in sensors, detects gestures, runs actions, serves ws://127.0.0.1:47823/.

let options = Options.parse(CommandLine.arguments)
Log.verbose = options.verbose
_ = Clock.start

// Sensor driver settings are put back however we leave: normal exit, SIGINT/SIGTERM/SIGHUP, or exit() anywhere.
atexit { SPUDriverControl.shared.restore() }

nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []
func installSignalHandlers(_ onSignal: @escaping () -> Void) {
    for sig in [SIGINT, SIGTERM, SIGHUP] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
        src.setEventHandler {
            Log.info("signal \(sig), shutting down")
            onSignal()
            SPUDriverControl.shared.restore()
            exit(0)
        }
        src.resume()
        signalSources.append(src)
    }
}

if options.selftest {
    installSignalHandlers {}
    exit(SelfTest.run())
}

if let seconds = options.dumpIMUSeconds {
    installSignalHandlers {}
    SelfTest.dumpIMU(seconds: seconds)
    exit(0)
}

let daemon = Daemon(options: options)
installSignalHandlers { daemon.stop() }
do {
    try daemon.start()
} catch {
    Log.error("could not start: \(error)")
    exit(1)
}
// The main run loop services the main dispatch queue (signals, AppKit calls from actions) and NSWorkspace notifications.
RunLoop.main.run()
