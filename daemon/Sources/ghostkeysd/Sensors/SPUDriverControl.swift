import Foundation
import IOKit
import Darwin

/// Which built-in sensor an SPU service carries, from its PrimaryUsagePage / PrimaryUsage.
enum SensorKind: String, CaseIterable, Codable {
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

    /// Only the motion sensors are ever written to. Light and lid are used by macOS itself (auto brightness,
    /// lid close) and are read passively only (SAFETY_AUDIT H3).
    var writable: Bool { self == .accel || self == .gyro }
}

/// Wakes the motion sensor drivers (AppleSPUHIDDriver) and puts them back the way they were.
///
/// Safety policy (PROTOCOL.md "Safety rules", SAFETY_AUDIT H2/H3/M3/M4):
/// - Only the accelerometer and gyroscope drivers are written. Light and lid are never written.
/// - `ReportInterval` is read before it is written; if the read fails it is not written at all.
/// - `SensorPropertyReportingState` / `SensorPropertyPowerState` cannot be read back from the registry. We infer the
///   original state from whether the driver was already delivering events (`DebugState._last_event_timestamp`).
///   If it was idle we switch it back off on exit; if it was already running we leave it running.
/// - The originals are saved to `spu-originals.json` BEFORE the first write. If the daemon dies without restoring
///   (crash, SIGKILL), the next start (or `--restore-sensors`) restores from that file and uses its values as the
///   originals instead of the leftover registry state. The file is deleted after a clean restore.
final class SPUDriverControl: @unchecked Sendable {
    static let shared = SPUDriverControl()

    struct Original: Codable {
        var kind: SensorKind
        var registryID: UInt64
        var originalInterval: Int?
        var wasStreaming: Bool
    }

    private struct Touched {
        let service: io_service_t
        let original: Original
        let setInterval: Bool
        let setStates: Bool
    }

    private let lock = NSLock()
    private var touched: [Touched] = []
    private var restored = false
    /// Originals recovered from a crashed run; they win over what the registry shows now.
    private var recovered: [SensorKind: Original] = [:]

    /// Microseconds between reports. 1250 gives about 797 Hz on M-series (1000 also caps there).
    static let motionInterval: Int32 = 1250

    /// Machine-wide (the sensors are): always in the default daemon directory, whatever --config-dir says, so a
    /// crash of any instance is recovered by the next one.
    var originalsURL: URL { ConfigStore.defaultDirectory.appendingPathComponent("spu-originals.json") }

    // MARK: Crash recovery

    /// If a previous run left `spu-originals.json` behind, restore those values now. Call with the instance lock held.
    /// Returns a human-readable summary, or nil if there was nothing to restore.
    @discardableResult
    func recoverFromCrashedRun() -> String? {
        guard let data = try? Data(contentsOf: originalsURL) else { return nil }
        guard let originals = try? JSONDecoder().decode([Original].self, from: data) else {
            Log.error("spu-originals.json is unreadable; leaving it for inspection at \(originalsURL.path)")
            return "unreadable spu-originals.json left in place"
        }
        var lines: [String] = []
        var allOK = true
        for o in originals where o.kind.writable {
            guard let service = Self.service(for: o) else {
                lines.append("\(o.kind): driver not found"); continue
            }
            defer { IOObjectRelease(service) }
            var ok = true
            if let interval = o.originalInterval {
                ok = Self.set(service, "ReportInterval", Int32(truncatingIfNeeded: interval)) && ok
            }
            if !o.wasStreaming { ok = Self.setStates(service, on: false) && ok }
            allOK = allOK && ok
            lock.lock(); recovered[o.kind] = o; lock.unlock()
            lines.append("\(o.kind): interval -> \(o.originalInterval.map(String.init) ?? "unchanged"), "
                         + (o.wasStreaming ? "left on (was on before)" : "switched off") + (ok ? "" : " (a write failed)"))
        }
        if allOK { try? FileManager.default.removeItem(at: originalsURL) }
        let summary = "restored sensor settings left by a previous run: " + lines.joined(separator: "; ")
        Log.info(summary)
        return summary
    }

    // MARK: Wake / restore

    /// Wake the accelerometer and gyroscope drivers. Returns the kinds that were found.
    @discardableResult
    func wakeMotion() -> Set<SensorKind> {
        lock.lock()
        defer { lock.unlock() }
        guard !restored else { return [] }

        // 1. Read originals for every motion driver, before touching anything.
        var plan: [(io_service_t, Original)] = []
        for (service, kind) in Self.drivers() {
            guard kind.writable else { IOObjectRelease(service); continue }
            let id = Self.registryID(service)
            let original = recovered[kind].map { Original(kind: kind, registryID: id, originalInterval: $0.originalInterval,
                                                          wasStreaming: $0.wasStreaming) }
                ?? Original(kind: kind, registryID: id, originalInterval: Self.readInt(service, "ReportInterval"),
                            wasStreaming: Self.isStreaming(service))
            plan.append((service, original))
        }
        guard !plan.isEmpty else { return [] }

        // 2. Persist them before the first write (never overwrite a file left by a crashed run).
        persistOriginals(plan.map(\.1))

        // 3. Write.
        var found = Set<SensorKind>()
        for (service, o) in plan {
            found.insert(o.kind)
            // Record the attempt even if a write failed, so restore always tries to switch it back off.
            let setStates = !o.wasStreaming
            if setStates { Self.setStates(service, on: true) }
            // Never write the interval when the original could not be read: we could not put it back.
            let setInterval = o.originalInterval != nil && Self.set(service, "ReportInterval", Self.motionInterval)
            Log.debug("SPU \(o.kind): originalInterval=\(o.originalInterval.map(String.init) ?? "unreadable (not written)") "
                      + "wasStreaming=\(o.wasStreaming)")
            touched.append(Touched(service: service, original: o, setInterval: setInterval, setStates: setStates))
        }
        return found
    }

    /// Put every touched driver back. Safe to call more than once, from any thread, and from atexit / signal paths.
    func restore() {
        lock.lock()
        defer { lock.unlock() }
        guard !restored else { return }
        restored = true
        var allOK = true
        for t in touched {
            if t.setInterval, let original = t.original.originalInterval {
                allOK = Self.set(t.service, "ReportInterval", Int32(truncatingIfNeeded: original)) && allOK
            }
            if t.setStates && !t.original.wasStreaming {
                allOK = Self.setStates(t.service, on: false) && allOK
            }
            IOObjectRelease(t.service)
        }
        if !touched.isEmpty {
            Log.info("restored \(touched.count) sensor driver setting(s)")
            if allOK { try? FileManager.default.removeItem(at: originalsURL) }
            else { Log.error("a sensor restore write failed; kept \(originalsURL.path) for the next start") }
        }
        touched.removeAll()
    }

    private func persistOriginals(_ originals: [Original]) {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: originalsURL.path) else {
            Log.info("keeping existing spu-originals.json from an earlier run")
            return
        }
        do {
            try fm.createDirectory(at: originalsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
            try enc.encode(originals).write(to: originalsURL, options: .atomic)
        } catch {
            Log.error("could not save sensor originals: \(error)")
        }
    }

    // MARK: IOKit helpers

    static func drivers() -> [(io_service_t, SensorKind)] {
        var result: [(io_service_t, SensorKind)] = []
        forEachService("AppleSPUHIDDriver") { service in
            guard let page = readInt(service, "PrimaryUsagePage"), let usage = readInt(service, "PrimaryUsage"),
                  let kind = SensorKind(page: page, usage: usage) else { return false }
            result.append((service, kind))
            return true   // caller owns the reference
        }
        return result
    }

    private static func service(for o: Original) -> io_service_t? {
        if o.registryID != 0, let matching = IORegistryEntryIDMatching(o.registryID) {
            let s = IOServiceGetMatchingService(kIOMainPortDefault, matching)
            if s != 0 { return s }
        }
        var found: io_service_t?
        for (s, kind) in drivers() {
            if kind == o.kind && found == nil { found = s } else { IOObjectRelease(s) }
        }
        return found
    }

    private static func registryID(_ service: io_service_t) -> UInt64 {
        var id: UInt64 = 0
        IORegistryEntryGetRegistryEntryID(service, &id)
        return id
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

    /// Sets both state properties. Returns true only if both writes succeeded.
    @discardableResult
    static func setStates(_ service: io_service_t, on: Bool) -> Bool {
        let a = set(service, "SensorPropertyReportingState", on ? 1 : 0)
        let b = set(service, "SensorPropertyPowerState", on ? 1 : 0)
        return a && b
    }

    @discardableResult
    static func set(_ service: io_service_t, _ key: String, _ value: Int32) -> Bool {
        let kr = IORegistryEntrySetCFProperty(service, key as CFString, NSNumber(value: value))
        if kr != KERN_SUCCESS { Log.debug("set \(key)=\(value) failed: 0x\(String(UInt32(bitPattern: kr), radix: 16))") }
        return kr == KERN_SUCCESS
    }
}
