import Foundation
import IOKit
import IOKit.hid
import GhostkeysDetection

/// Opens the built-in SPU sensors (accelerometer, gyroscope, ambient light, lid angle) and delivers decoded readings.
/// Reports arrive on a dedicated thread's run loop; the handlers are called on that thread and must hand work off quickly.
final class SensorHub: @unchecked Sendable {
    struct Handlers {
        var imu: (IMUSample) -> Void = { _ in }
        var lid: (_ angle: Double, _ t: Double) -> Void = { _, _ in }
        var light: (_ value: Double, _ lux: Double, _ t: Double) -> Void = { _, _, _ in }
    }

    /// One opened HID device. Passed to the C callback as its context pointer.
    fileprivate final class Device {
        let kind: SensorKind
        let hid: IOHIDDevice
        let buffer: UnsafeMutablePointer<UInt8>
        let bufferSize = 4096
        weak var hub: SensorHub?
        init(kind: SensorKind, hid: IOHIDDevice, hub: SensorHub) {
            self.kind = kind; self.hid = hid; self.hub = hub
            buffer = .allocate(capacity: bufferSize)
            buffer.initialize(repeating: 0, count: bufferSize)
        }
        deinit { buffer.deallocate() }
    }

    private var handlers = Handlers()
    private var devices: [Device] = []
    private var thread: Thread?
    private var runLoop: CFRunLoop?

    private let countLock = NSLock()
    private var counts: [SensorKind: Int] = [:]

    /// Sensors whose HID device exists and opened.
    private(set) var present: Set<SensorKind> = []

    // Pairing state, only touched on the sensor thread.
    private var pendingAccel: (t: Double, v: SIMD3<Double>)?
    private var lastGyro = SIMD3<Double>(repeating: 0)
    private var gyroFresh = false

    // Latest values (read from other threads under countLock).
    private var latestLid: Double?
    private var latestLight: Double?
    private var latestLux: Double?

    /// Upper end of the log scale for light normalization (lux). Bright office is ~500, daylight by a window ~3000.
    static let luxFullScale = 3000.0

    func start(handlers: Handlers) {
        self.handlers = handlers
        SPUDriverControl.shared.wakeMotion()
        openDevices()

        let ready = DispatchSemaphore(value: 0)
        let t = Thread { [weak self] in
            guard let self else { ready.signal(); return }
            let rl = CFRunLoopGetCurrent()!
            self.runLoop = rl
            for d in self.devices {
                IOHIDDeviceScheduleWithRunLoop(d.hid, rl, CFRunLoopMode.defaultMode.rawValue)
            }
            // Keep the run loop alive even if no device opened.
            let keepAlive = CFRunLoopTimerCreateWithHandler(kCFAllocatorDefault, CFAbsoluteTimeGetCurrent() + 1e9, 1e9, 0, 0) { _ in }
            CFRunLoopAddTimer(rl, keepAlive, .defaultMode)
            ready.signal()
            CFRunLoopRun()
        }
        t.name = "ghostkeys.sensors"
        t.qualityOfService = .userInteractive
        thread = t
        t.start()
        ready.wait()

        // Light and lid are system sensors; they normally already stream. Wake them only if they stay silent.
        DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self else { return }
            for kind in [SensorKind.light, .lid] where self.present.contains(kind) && self.count(kind) == 0 {
                SPUDriverControl.shared.wakeSilent(kind)
            }
        }
    }

    func stop() {
        for d in devices {
            IOHIDDeviceRegisterInputReportWithTimeStampCallback(d.hid, d.buffer, d.bufferSize, nil, nil)
            if let rl = runLoop { IOHIDDeviceUnscheduleFromRunLoop(d.hid, rl, CFRunLoopMode.defaultMode.rawValue) }
            IOHIDDeviceClose(d.hid, 0)
        }
        if let rl = runLoop { CFRunLoopStop(rl) }
        devices.removeAll()
    }

    func count(_ kind: SensorKind) -> Int {
        countLock.lock(); defer { countLock.unlock() }
        return counts[kind] ?? 0
    }

    var lidAngle: Double? { countLock.lock(); defer { countLock.unlock() }; return latestLid }
    var lightValue: Double? { countLock.lock(); defer { countLock.unlock() }; return latestLight }
    var lux: Double? { countLock.lock(); defer { countLock.unlock() }; return latestLux }

    // MARK: Opening

    private func openDevices() {
        var opened = Set<SensorKind>()
        SPUDriverControl.forEachService("AppleSPUHIDDevice") { service in
            guard let page = SPUDriverControl.readInt(service, "PrimaryUsagePage"),
                  let usage = SPUDriverControl.readInt(service, "PrimaryUsage"),
                  let kind = SensorKind(page: page, usage: usage), !opened.contains(kind) else { return false }
            guard let hid = IOHIDDeviceCreate(kCFAllocatorDefault, service) else {
                Log.error("could not create HID device for \(kind)")
                return false
            }
            let kr = IOHIDDeviceOpen(hid, IOOptionBits(kIOHIDOptionsTypeNone))
            guard kr == kIOReturnSuccess else {
                Log.error("could not open \(kind) sensor: 0x\(String(UInt32(bitPattern: kr), radix: 16))")
                return false
            }
            let device = Device(kind: kind, hid: hid, hub: self)
            IOHIDDeviceRegisterInputReportWithTimeStampCallback(hid, device.buffer, device.bufferSize, sensorReportCallback,
                                                                Unmanaged.passUnretained(device).toOpaque())
            devices.append(device)
            opened.insert(kind)
            return false
        }
        present = opened
        for kind in SensorKind.allCases where !opened.contains(kind) {
            Log.info("sensor not available: \(kind)")
        }
    }

    // MARK: Decoding (sensor thread)

    fileprivate func handle(kind: SensorKind, report: UnsafeMutablePointer<UInt8>, length: Int, timeStamp: UInt64) {
        let t = timeStamp > 0 ? Clock.seconds(fromTicks: timeStamp) : Clock.now()
        switch kind {
        case .accel, .gyro:
            guard length >= 18 else { return }
            let v = SIMD3(Self.int32LE(report, 6), Self.int32LE(report, 10), Self.int32LE(report, 14)) / 65536.0
            bump(kind)
            if kind == .accel { accel(v, t: t) } else { gyro(v) }
        case .lid:
            guard length >= 3, report[0] == 1 else { return }
            let raw = (UInt16(report[1]) | (UInt16(report[2]) << 8)) & 0x1FF
            let angle = Double(raw)
            bump(kind) { self.latestLid = angle }
            handlers.lid(angle, t)
        case .light:
            guard length >= 44 else { return }
            var bits: UInt32 = 0
            for i in 0..<4 { bits |= UInt32(report[40 + i]) << (8 * UInt32(i)) }
            let lux = max(0, Double(Float(bitPattern: bits)))
            guard lux.isFinite else { return }
            let value = min(1, log10(1 + lux) / log10(1 + Self.luxFullScale))
            bump(kind) { self.latestLight = value; self.latestLux = lux }
            handlers.light(value, lux, t)
        }
    }

    /// Accel and gyro arrive at the same rate. Pair each accel with the next gyro; if a gyro is missed,
    /// emit with the previous gyro so the stream never stalls. Without a gyro, emit accel alone.
    private func accel(_ v: SIMD3<Double>, t: Double) {
        if !present.contains(.gyro) {
            handlers.imu(IMUSample(t: t, a: v, g: .zero)); return
        }
        if let p = pendingAccel { handlers.imu(IMUSample(t: p.t, a: p.v, g: lastGyro)) }
        if gyroFresh {
            gyroFresh = false
            pendingAccel = nil
            handlers.imu(IMUSample(t: t, a: v, g: lastGyro))
        } else {
            pendingAccel = (t, v)
        }
    }

    private func gyro(_ v: SIMD3<Double>) {
        lastGyro = v
        if let p = pendingAccel {
            pendingAccel = nil
            gyroFresh = false
            handlers.imu(IMUSample(t: p.t, a: p.v, g: v))
        } else {
            gyroFresh = true
        }
    }

    private func bump(_ kind: SensorKind, _ update: () -> Void = {}) {
        countLock.lock()
        counts[kind, default: 0] += 1
        update()
        countLock.unlock()
    }

    private static func int32LE(_ p: UnsafeMutablePointer<UInt8>, _ o: Int) -> Double {
        let u = UInt32(p[o]) | UInt32(p[o + 1]) << 8 | UInt32(p[o + 2]) << 16 | UInt32(p[o + 3]) << 24
        return Double(Int32(bitPattern: u))
    }
}

private let sensorReportCallback: IOHIDReportWithTimeStampCallback = { context, _, _, _, _, report, length, timeStamp in
    guard let context else { return }
    let device = Unmanaged<SensorHub.Device>.fromOpaque(context).takeUnretainedValue()
    device.hub?.handle(kind: device.kind, report: report, length: length, timeStamp: timeStamp)
}
