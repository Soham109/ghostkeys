import Foundation
import IOKit
import Darwin

/// Which built-in sensor an SPU service carries, from its PrimaryUsagePage / PrimaryUsage.
enum SensorKind: String, CaseIterable {
    case accel, gyro, light, lid

    init?(page: Int, usage: Int) {
        switch (page, usage) {
        case (0xFF00, 3): self = .accel
        case (0xFF00, 9): self = .gyro
        case (0xFF00, 4): self = .light
        case (0x0020, 138): self = .lid
        default: return nil
        }
    }
}

/// Wakes the motion sensor drivers (AppleSPUHIDDriver) and puts them back the way they were.
///
/// Safety policy (see PROTOCOL.md "Safety rules"):
/// - Only drivers for sensors we read are touched, never the others.
/// - `ReportInterval` is read before it is written and written back on exit.
/// - `SensorPropertyReportingState` / `SensorPropertyPowerState` cannot be read back from the registry. We infer the
///   original state from whether the driver was already delivering events (its `DebugState._last_event_timestamp`,
///   or for light/lid whether any report arrived). If it was idle we switch it back off on exit; if it was already
///   running (macOS or another client uses it) we leave it running.
/// - Light and lid drivers are system sensors (auto brightness, lid close). They are only woken if they are silent,
///   and their ReportInterval is never changed.
final class SPUDriverControl: @unchecked Sendable {
    static let shared = SPUDriverControl()

    private struct Touched {
        let service: io_service_t
        let kind: SensorKind
        let originalInterval: Int?
        let setInterval: Bool
        let wasStreaming: Bool
        let setStates: Bool
    }

    private let lock = NSLock()
    private var touched: [Touched] = []
    private var restored = false

    /// Microseconds between reports. 1250 gives about 797 Hz on M-series (1000 also caps there).
    static let motionInterval: Int32 = 1250

    /// Wake the accelerometer and gyroscope drivers. Returns the kinds that were found.
    @discardableResult
    func wakeMotion() -> Set<SensorKind> {
        var found = Set<SensorKind>()
        for (service, kind) in Self.drivers() where kind == .accel || kind == .gyro {
            found.insert(kind)
            let original = Self.readInt(service, "ReportInterval")
            let streaming = Self.isStreaming(service)
            var setStates = false
            if !streaming {
                setStates = Self.setStates(service, on: true)
            }
            let setInterval = Self.set(service, "ReportInterval", Self.motionInterval)
            Log.debug("SPU \(kind): originalInterval=\(original.map(String.init) ?? "nil") wasStreaming=\(streaming)")
            record(Touched(service: service, kind: kind, originalInterval: original, setInterval: setInterval,
                           wasStreaming: streaming, setStates: setStates))
        }
        return found
    }

    /// Wake a silent system sensor (light or lid) without changing its report interval.
    func wakeSilent(_ kind: SensorKind) {
        for (service, k) in Self.drivers() where k == kind {
            let ok = Self.setStates(service, on: true)
            Log.info("\(kind) sensor was silent, woke its driver (ok=\(ok))")
            record(Touched(service: service, kind: kind, originalInterval: nil, setInterval: false,
                           wasStreaming: false, setStates: ok))
        }
    }

    /// Put every touched driver back. Safe to call more than once and from a signal/atexit path.
    func restore() {
        lock.lock()
        defer { lock.unlock() }
        guard !restored else { return }
        restored = true
        for t in touched {
            if t.setInterval, let original = t.originalInterval {
                _ = Self.set(t.service, "ReportInterval", Int32(truncatingIfNeeded: original))
            }
            if t.setStates && !t.wasStreaming {
                Self.setStates(t.service, on: false)
            }
            IOObjectRelease(t.service)
        }
        if !touched.isEmpty { Log.info("restored \(touched.count) sensor driver setting(s)") }
        touched.removeAll()
    }

    private func record(_ t: Touched) {
        lock.lock(); defer { lock.unlock() }
        IOObjectRetain(t.service)
        touched.append(t)
    }

    // MARK: IOKit helpers

    static func drivers() -> [(io_service_t, SensorKind)] {
        var result: [(io_service_t, SensorKind)] = []
        forEachService("AppleSPUHIDDriver") { service in
            guard let page = readInt(service, "PrimaryUsagePage"), let usage = readInt(service, "PrimaryUsage"),
                  let kind = SensorKind(page: page, usage: usage) else { return false }
            result.append((service, kind))
            return true   // keep the reference; caller owns it for the process lifetime
        }
        return result
    }

    /// Calls `body` for each matching service. If `body` returns false the service is released.
    static func forEachService(_ className: String, _ body: (io_service_t) -> Bool) {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching(className), &iterator) == KERN_SUCCESS else { return }
        defer { IOObjectRelease(iterator) }
        while case let service = IOIteratorNext(iterator), service != 0 {
            if !body(service) { IOObjectRelease(service) }
        }
    }

    static func readInt(_ service: io_service_t, _ key: String) -> Int? {
        guard let ref = IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0) else { return nil }
        return (ref.takeRetainedValue() as? NSNumber)?.intValue
    }

    static func isStreaming(_ service: io_service_t) -> Bool {
        guard let ref = IORegistryEntryCreateCFProperty(service, "DebugState" as CFString, kCFAllocatorDefault, 0),
              let dict = ref.takeRetainedValue() as? [String: Any],
              let last = (dict["_last_event_timestamp"] as? NSNumber)?.uint64Value else {
            return true   // unknown: assume something else uses it and never switch it off
        }
        guard last > 0 else { return false }
        let now = mach_absolute_time()
        return now > last ? Clock.seconds(fromTicks: now - last) < 1.0 : true
    }

    /// Sets both state properties. Returns true if either write succeeded (so restore undoes a partial wake too).
    @discardableResult
    static func setStates(_ service: io_service_t, on: Bool) -> Bool {
        let a = set(service, "SensorPropertyReportingState", on ? 1 : 0)
        let b = set(service, "SensorPropertyPowerState", on ? 1 : 0)
        return a || b
    }

    @discardableResult
    static func set(_ service: io_service_t, _ key: String, _ value: Int32) -> Bool {
        let kr = IORegistryEntrySetCFProperty(service, key as CFString, NSNumber(value: value))
        if kr != KERN_SUCCESS { Log.debug("set \(key)=\(value) failed: 0x\(String(UInt32(bitPattern: kr), radix: 16))") }
        return kr == KERN_SUCCESS
    }
}
