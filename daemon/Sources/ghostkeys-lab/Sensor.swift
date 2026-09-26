// Minimal motion sensor reader for the lab tool (independent of ghostkeysd on purpose).
//
// Wakes the accelerometer and gyroscope drivers (AppleSPUHIDDriver), opens the matching AppleSPUHIDDevice
// services, and streams 22-byte reports: X/Y/Z Int32 little-endian at offsets 6/10/14, divided by 65536
// (g for the accelerometer, degrees per second for the gyroscope). Runs its own CFRunLoop thread.
//
// Safety (PROTOCOL.md): only the accel/gyro drivers are touched, ReportInterval is read before it is written
// and written back on exit, and the on/off state properties (which cannot be read back) are switched off again
// only if the driver was idle before we woke it.

import Foundation
import IOKit
import IOKit.hid
import Darwin
import CoreGraphics

enum LabClock {
    static let timebase: mach_timebase_info_data_t = {
        var tb = mach_timebase_info_data_t()
        mach_timebase_info(&tb)
        return tb
    }()
    static func seconds(fromTicks ticks: UInt64) -> Double {
        Double(ticks) * Double(timebase.numer) / Double(timebase.denom) / 1e9
    }
    static func now() -> Double { seconds(fromTicks: mach_absolute_time()) }
}

// MARK: - Driver property control

final class DriverControl: @unchecked Sendable {
    static let shared = DriverControl()
    static let motionInterval: Int32 = 1250

    struct Touched {
        let service: io_service_t
        let usage: Int
        let originalInterval: Int?
        let setInterval: Bool
        let wasStreaming: Bool
        let setStates: Bool
    }

    private let lock = NSLock()
    private(set) var touched: [Touched] = []
    private var restored = false

    /// Wakes the accel (usage 3) and gyro (usage 9) drivers. Returns a human-readable log of what was done.
    func wakeMotion() -> [String] {
        var log: [String] = []
        forEachService("AppleSPUHIDDriver") { service in
            guard let page = readInt(service, "PrimaryUsagePage"), let usage = readInt(service, "PrimaryUsage"),
                  page == 0xFF00, usage == 3 || usage == 9 else { return false }
            let original = readInt(service, "ReportInterval")
            let streaming = isStreaming(service)
            var setStates = false
            if !streaming {
                let a = set(service, "SensorPropertyReportingState", 1)
                let b = set(service, "SensorPropertyPowerState", 1)
                setStates = a || b
            }
            let setIv = set(service, "ReportInterval", Self.motionInterval)
            lock.lock()
            touched.append(Touched(service: service, usage: usage, originalInterval: original, setInterval: setIv,
                                   wasStreaming: streaming, setStates: setStates))
            lock.unlock()
            log.append("driver usage=\(usage) originalReportInterval=\(original.map(String.init) ?? "nil") wasStreaming=\(streaming) setStates=\(setStates) setInterval=\(setIv)")
            return true
        }
        return log
    }

    /// Puts every touched driver back. Idempotent; safe from the signal path.
    @discardableResult
    func restore() -> Int {
        lock.lock(); defer { lock.unlock() }
        guard !restored else { return 0 }
        restored = true
        for t in touched {
            if t.setInterval, let original = t.originalInterval {
                _ = set(t.service, "ReportInterval", Int32(truncatingIfNeeded: original))
            }
            if t.setStates && !t.wasStreaming {
                _ = set(t.service, "SensorPropertyReportingState", 0)
                _ = set(t.service, "SensorPropertyPowerState", 0)
            }
            IOObjectRelease(t.service)
        }
        let n = touched.count
        touched.removeAll()
        return n
    }

    private func isStreaming(_ service: io_service_t) -> Bool {
        guard let ref = IORegistryEntryCreateCFProperty(service, "DebugState" as CFString, kCFAllocatorDefault, 0),
              let dict = ref.takeRetainedValue() as? [String: Any],
              let last = (dict["_last_event_timestamp"] as? NSNumber)?.uint64Value else {
            return true   // unknown: assume another client uses it, never switch it off
        }
        guard last > 0 else { return false }
        let now = mach_absolute_time()
        return now > last ? LabClock.seconds(fromTicks: now - last) < 1.0 : true
    }
}

func forEachService(_ className: String, _ body: (io_service_t) -> Bool) {
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching(className), &iterator) == KERN_SUCCESS else { return }
    defer { IOObjectRelease(iterator) }
    while case let service = IOIteratorNext(iterator), service != 0 {
        if !body(service) { IOObjectRelease(service) }
    }
}

func readInt(_ service: io_service_t, _ key: String) -> Int? {
    guard let ref = IORegistryEntryCreateCFProperty(service, key as CFString, kCFAllocatorDefault, 0) else { return nil }
    return (ref.takeRetainedValue() as? NSNumber)?.intValue
}

@discardableResult
func set(_ service: io_service_t, _ key: String, _ value: Int32) -> Bool {
    IORegistryEntrySetCFProperty(service, key as CFString, NSNumber(value: value)) == KERN_SUCCESS
}

// MARK: - Streaming

/// One merged sample: accelerometer report paired with the latest gyroscope report.
struct RawSample {
    var t: Double      // seconds, mach clock
    var a: SIMD3<Float>
    var g: SIMD3<Float>
}

final class IMUStream: @unchecked Sendable {
    private final class DeviceBox {
        let usage: Int
        weak var owner: IMUStream?
        let buffer: UnsafeMutablePointer<UInt8>
        init(usage: Int, owner: IMUStream) {
            self.usage = usage; self.owner = owner
            buffer = .allocate(capacity: 4096)
        }
        deinit { buffer.deallocate() }
    }

    private let lock = NSLock()
    private var pending: [RawSample] = []
    private var lastGyro = SIMD3<Float>(0, 0, 0)
    private var boxes: [DeviceBox] = []
    private var devices: [IOHIDDevice] = []
    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private(set) var accelCount = 0
    private(set) var gyroCount = 0
    private(set) var openLog: [String] = []

    /// Wakes the drivers and starts the run loop thread. Throws if no accelerometer could be opened.
    func start() throws {
        // Never fight ghostkeysd over the drivers: take the daemon's own lock first.
        try LabInstanceLock.acquire()
        openLog += DriverControl.shared.wakeMotion()
        let ready = DispatchSemaphore(value: 0)
        var opened = Set<Int>()
        let t = Thread { [self] in
            self.runLoop = CFRunLoopGetCurrent()
            forEachService("AppleSPUHIDDevice") { service in
                defer { IOObjectRelease(service) }
                guard let page = readInt(service, "PrimaryUsagePage"), let usage = readInt(service, "PrimaryUsage"),
                      page == 0xFF00, usage == 3 || usage == 9 else { return true }
                guard let dev = IOHIDDeviceCreate(kCFAllocatorDefault, service) else {
                    self.openLog.append("device usage=\(usage): IOHIDDeviceCreate failed"); return true
                }
                let kr = IOHIDDeviceOpen(dev, IOOptionBits(kIOHIDOptionsTypeNone))
                guard kr == kIOReturnSuccess else {
                    self.openLog.append("device usage=\(usage): open failed 0x\(String(UInt32(bitPattern: kr), radix: 16))"); return true
                }
                let box = DeviceBox(usage: usage, owner: self)
                self.boxes.append(box)
                self.devices.append(dev)
                let ctx = Unmanaged.passUnretained(box).toOpaque()
                IOHIDDeviceRegisterInputReportWithTimeStampCallback(dev, box.buffer, 4096, { ctx, _, _, _, _, report, length, ts in
                    guard let ctx else { return }
                    let box = Unmanaged<DeviceBox>.fromOpaque(ctx).takeUnretainedValue()
                    box.owner?.handle(usage: box.usage, report: report, length: length, timestamp: ts)
                }, ctx)
                IOHIDDeviceScheduleWithRunLoop(dev, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
                opened.insert(usage)
                self.openLog.append("device usage=\(usage): opened")
                return true
            }
            ready.signal()
            // Keep the run loop alive even if no source is attached yet.
            let keepAlive = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 1e9, 1e9, 0, 0) { _ in }
            CFRunLoopAddTimer(CFRunLoopGetCurrent(), keepAlive, .defaultMode)
            CFRunLoopRun()
        }
        t.name = "ghostkeys-lab.imu"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
        ready.wait()
        if !opened.contains(3) {
            throw LabError("could not open the accelerometer (AppleSPUHIDDevice page 0xFF00 usage 3). Log:\n  " + openLog.joined(separator: "\n  "))
        }
    }

    private func handle(usage: Int, report: UnsafeMutablePointer<UInt8>, length: CFIndex, timestamp: UInt64) {
        guard length >= 18 else { return }
        func i32(_ off: Int) -> Float {
            let v = UInt32(report[off]) | UInt32(report[off + 1]) << 8 | UInt32(report[off + 2]) << 16 | UInt32(report[off + 3]) << 24
            return Float(Int32(bitPattern: v)) / 65536
        }
        let v = SIMD3<Float>(i32(6), i32(10), i32(14))
        lock.lock()
        if usage == 9 {
            lastGyro = v
            gyroCount += 1
        } else {
            accelCount += 1
            pending.append(RawSample(t: LabClock.seconds(fromTicks: timestamp), a: v, g: lastGyro))
        }
        lock.unlock()
    }

    /// Returns and clears the samples received since the last call.
    func drain() -> [RawSample] {
        lock.lock(); defer { lock.unlock() }
        let out = pending
        pending.removeAll(keepingCapacity: true)
        return out
    }

    func stop() {
        if let rl = runLoop {
            CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) { [self] in
                for d in self.devices {
                    IOHIDDeviceUnscheduleFromRunLoop(d, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
                    IOHIDDeviceClose(d, IOOptionBits(kIOHIDOptionsTypeNone))
                }
                self.devices.removeAll()
                CFRunLoopStop(CFRunLoopGetCurrent())
            }
            CFRunLoopWakeUp(rl)
            runLoop = nil
            // Give the run loop a moment to close the devices.
            let deadline = Date().addingTimeInterval(0.5)
            while !devices.isEmpty && Date() < deadline { usleep(5_000) }
        }
        DriverControl.shared.restore()
    }
}

// MARK: - Keyboard / mouse activity (no Input Monitoring needed)

struct ActivityReading {
    var t: Double
    var sinceKey: Double
    var sinceMouse: Double
    var flags: UInt32     // masked CGEventFlags: shift, control, option, command, fn (all below 2^24, exact in Float32)
}

enum Activity {
    static let flagMask: UInt64 = 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x800000
    private static let mouseTypes: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                                    .leftMouseDragged, .rightMouseDragged, .scrollWheel, .otherMouseDown]
    static func read() -> ActivityReading {
        let key = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
        var mouse = Double.greatestFiniteMagnitude
        for ty in mouseTypes { mouse = min(mouse, CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: ty)) }
        let flags = CGEventSource.flagsState(.combinedSessionState).rawValue & flagMask
        return ActivityReading(t: LabClock.now(), sinceKey: key, sinceMouse: mouse, flags: UInt32(flags))
    }

    static func modifiers(_ flags: UInt32) -> Set<String> {
        var s = Set<String>()
        if flags & 0x20000 != 0 { s.insert("shift") }
        if flags & 0x40000 != 0 { s.insert("control") }
        if flags & 0x80000 != 0 { s.insert("option") }
        if flags & 0x100000 != 0 { s.insert("command") }
        if flags & 0x800000 != 0 { s.insert("fn") }
        return s
    }
}

// MARK: - Signals

/// Ctrl+C / SIGTERM handling: the first signal sets `stopRequested` (callers finish cleanly and restore); a second
/// one restores the drivers immediately and exits.
enum Signals {
    nonisolated(unsafe) static var stopRequested = false
    nonisolated(unsafe) private static var sources: [DispatchSourceSignal] = []
    nonisolated(unsafe) static var onForcedExit: (() -> Void)?

    static func install() {
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInteractive))
            src.setEventHandler {
                if stopRequested {
                    onForcedExit?()
                    DriverControl.shared.restore()
                    Terminal.restore()
                    FileHandle.standardError.write("\nforced exit, sensor settings restored\n".data(using: .utf8)!)
                    exit(130)
                }
                stopRequested = true
            }
            src.resume()
            sources.append(src)
        }
        atexit {
            DriverControl.shared.restore()
            Terminal.restore()
        }
    }
}

struct LabError: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}
