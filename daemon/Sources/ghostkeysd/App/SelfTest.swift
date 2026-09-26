import Foundation
import GhostkeysDetection

/// --selftest and --dump-imu: sensor checks without the server or any actions.
enum SelfTest {
    /// Opens the sensors for 3 s and prints what arrived. Returns the process exit code.
    static func run() -> Int32 {
        let hub = SensorHub()
        let lock = NSLock()
        var imuPairs = 0
        var lastSample: IMUSample?
        hub.start(handlers: .init(imu: { s in lock.lock(); imuPairs += 1; lastSample = s; lock.unlock() }))
        let t0 = Date()
        let duration = 3.0
        spin(until: t0.addingTimeInterval(duration))
        let elapsed = Date().timeIntervalSince(t0)
        let present = hub.present
        let counts = Dictionary(uniqueKeysWithValues: SensorKind.allCases.map { ($0, hub.count($0)) })
        let lid = hub.lidAngle, light = hub.lightValue, lux = hub.lux
        hub.stop()
        SPUDriverControl.shared.restore()

        let device = DeviceInfo.current()
        print("ghostkeysd selftest on \(device.model), \(device.chip), family \(device.family)")
        for kind in SensorKind.allCases {
            let hz = Double(counts[kind] ?? 0) / elapsed
            let state = present.contains(kind) ? String(format: "%6.0f Hz  (%d reports)", hz, counts[kind] ?? 0) : "not available"
            print("  \(kind.rawValue.padding(toLength: 6, withPad: " ", startingAt: 0)) \(state)")
        }
        lock.lock()
        print(String(format: "  paired imu samples: %.0f Hz", Double(imuPairs) / elapsed))
        if let s = lastSample {
            print(String(format: "  last accel (g):     %+.3f %+.3f %+.3f  |a| = %.3f", s.a.x, s.a.y, s.a.z, (s.a * s.a).sum().squareRoot()))
            print(String(format: "  last gyro (deg/s):  %+.2f %+.2f %+.2f", s.g.x, s.g.y, s.g.z))
        }
        lock.unlock()
        print("  lid angle:          \(lid.map { "\(Int($0)) deg" } ?? "none")")
        print("  light:              \(light.map { String(format: "%.3f (%.1f lux)", $0, lux ?? 0) } ?? "none")")

        let accelHz = Double(counts[.accel] ?? 0) / elapsed
        let ok = present.contains(.accel) && accelHz > 100
        print(ok ? "selftest: OK" : "selftest: FAILED (the accelerometer did not stream)")
        return ok ? 0 : 1
    }

    /// Prints `seconds` of paired samples as CSV on stdout (t in seconds since start, accel g, gyro deg/s).
    static func dumpIMU(seconds: Double) {
        let hub = SensorHub()
        let lock = NSLock()
        var lines: [String] = []
        print("t,ax,ay,az,gx,gy,gz")
        hub.start(handlers: .init(imu: { s in
            let line = String(format: "%.6f,%.5f,%.5f,%.5f,%.4f,%.4f,%.4f", s.t - Clock.start, s.a.x, s.a.y, s.a.z, s.g.x, s.g.y, s.g.z)
            lock.lock(); lines.append(line); lock.unlock()
        }))
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            spin(until: min(end, Date().addingTimeInterval(0.1)))
            lock.lock(); let batch = lines; lines.removeAll(keepingCapacity: true); lock.unlock()
            if !batch.isEmpty { print(batch.joined(separator: "\n")) }
        }
        hub.stop()
        SPUDriverControl.shared.restore()
        lock.lock(); if !lines.isEmpty { print(lines.joined(separator: "\n")) }; lock.unlock()
        fflush(stdout)
    }

    /// Runs the main run loop (so signal handlers on the main queue still fire) until `date`.
    private static func spin(until date: Date) {
        while Date() < date {
            RunLoop.main.run(until: min(date, Date().addingTimeInterval(0.05)))
        }
    }
}
