import Foundation

struct Options {
    var port: UInt16 = 47823
    var verbose = false
    var dryRun = false
    var dumpIMUSeconds: Double?
    var selftest = false
    var parentPID: Int32?

    static let usage = """
    usage: ghostkeysd [--port N] [--parent-pid PID] [--verbose] [--dry-run] [--dump-imu SECONDS] [--selftest]
      --port N          WebSocket port on 127.0.0.1 (default 47823)
      --parent-pid PID  exit (restoring the sensors) when this process ends; the parent process is always watched too
      --verbose         debug logging to stderr
      --dry-run         log actions instead of running them
      --dump-imu S      print S seconds of motion samples as CSV to stdout, then exit
      --selftest        open the sensors for 3 s, print rates, lid angle and light, exit 0 (ok) or 1
    """

    static func parse(_ args: [String]) -> Options {
        var o = Options()
        var i = 1
        func value() -> String {
            i += 1
            guard i < args.count else { fail("missing value for \(args[i - 1])") }
            return args[i]
        }
        while i < args.count {
            let a = args[i]
            switch a {
            case "--port":
                guard let p = UInt16(value()), p > 0 else { fail("invalid port") }
                o.port = p
            case "--parent-pid":
                guard let p = Int32(value()), p > 1 else { fail("invalid parent pid") }
                o.parentPID = p
            case "--verbose", "-v": o.verbose = true
            case "--dry-run": o.dryRun = true
            case "--dump-imu":
                guard let s = Double(value()), s > 0, s <= 600 else { fail("--dump-imu needs seconds between 0 and 600") }
                o.dumpIMUSeconds = s
            case "--selftest": o.selftest = true
            case "--help", "-h":
                print(usage); exit(0)
            default:
                if a.hasPrefix("--port=") , let p = UInt16(a.dropFirst(7)) { o.port = p }
                else { fail("unknown argument \(a)") }
            }
            i += 1
        }
        return o
    }

    private static func fail(_ msg: String) -> Never {
        FileHandle.standardError.write((msg + "\n" + usage + "\n").data(using: .utf8)!)
        exit(2)
    }
}
