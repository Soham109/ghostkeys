import Foundation
import Darwin

/// Monotonic clock helpers. Sensor timestamps come from mach_absolute_time ticks.
enum Clock {
    private static let timebase: (numer: Double, denom: Double) = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return (Double(info.numer), Double(info.denom))
    }()

    /// Daemon start, in seconds on the mach clock. Protocol timestamps are milliseconds since this.
    static let start: Double = now()

    static func seconds(fromTicks ticks: UInt64) -> Double {
        Double(ticks) * timebase.numer / timebase.denom / 1e9
    }

    static func now() -> Double { seconds(fromTicks: mach_absolute_time()) }

    /// Milliseconds since daemon start for a mach-clock time in seconds.
    static func protocolMs(_ t: Double) -> Double { ((t - start) * 1000 * 10).rounded() / 10 }
}

/// Logging goes to stderr so stdout stays clean for --dump-imu CSV output.
enum Log {
    nonisolated(unsafe) static var verbose = false

    static func info(_ message: @autoclosure () -> String) {
        write("[ghostkeysd] " + message())
    }

    static func debug(_ message: @autoclosure () -> String) {
        guard verbose else { return }
        write("[ghostkeysd:debug] " + message())
    }

    static func error(_ message: @autoclosure () -> String) {
        write("[ghostkeysd:error] " + message())
    }

    private static func write(_ s: String) {
        FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
    }
}
