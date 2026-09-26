// Tracks the direction of gravity to tell "the laptop itself is moving" apart from taps.
//
// At rest the accelerometer reads +1 g pointing up (it measures the reaction to gravity), so a
// low-passed accel vector is the "up" direction in device coordinates. Its direction only changes
// when the machine is rotated (lifted, tilted, carried). Taps shake the machine but barely rotate it:
// a 50 ms low-pass turns even a 300 mg tap into a ~10 to 20 mg wobble, about 1 degree, well under
// the 3 degree motion limit.
//
// The monitor runs at a decimated rate (every 8 samples, about 100 Hz) to stay cheap.

import Foundation

struct GravityMonitor {
    var sampleRate = 797.0
    var lowPassSeconds = 0.05
    var decimation = 8
    /// Rotation above this many degrees within `motionWindow` counts as moving.
    var motionDegrees = 3.0
    var motionWindow = 0.5

    private var gx = 0.0, gy = 0.0, gz = 0.0
    private var initialized = false
    private var alpha = 0.0
    private var counter = 0

    // Ring of decimated unit vectors covering a bit more than the motion window.
    private var ringT: [Double] = []
    private var ringV: [SIMD3<Double>] = []
    private var ringCursor = 0
    private var ringCapacity = 0

    /// Last time the gravity direction rotated more than `motionDegrees` over `motionWindow`.
    private(set) var lastMotionT = -Double.infinity
    /// Current low-passed "up" vector in g.
    var gravity: SIMD3<Double> { SIMD3(gx, gy, gz) }

    /// Called once per sample. Returns true on the decimated ticks (when `gravity` is fresh for tilt).
    mutating func process(ax: Double, ay: Double, az: Double, t: Double) -> Bool {
        if !initialized {
            gx = ax; gy = ay; gz = az
            alpha = 1 - exp(-1 / (lowPassSeconds * sampleRate))
            ringCapacity = Int((motionWindow * sampleRate / Double(decimation)).rounded(.up)) + 4
            ringT = Array(repeating: -Double.infinity, count: ringCapacity)
            ringV = Array(repeating: SIMD3(0, 0, 0), count: ringCapacity)
            initialized = true
        }
        gx += alpha * (ax - gx); gy += alpha * (ay - gy); gz += alpha * (az - gz)
        counter += 1
        guard counter % decimation == 0 else { return false }

        let n = (gx * gx + gy * gy + gz * gz).squareRoot()
        guard n > 0.2 else { return true }   // free fall or garbage: skip
        let u = SIMD3(gx / n, gy / n, gz / n)
        ringT[ringCursor] = t
        ringV[ringCursor] = u
        ringCursor = (ringCursor + 1) % ringCapacity

        // Largest rotation between now and any stored direction in the last motionWindow.
        // (smallest dot product = largest angle; one acos instead of one per entry)
        var minDot = 1.0
        for k in 0..<ringCapacity where t - ringT[k] <= motionWindow {
            let v = ringV[k]
            minDot = min(minDot, u.x * v.x + u.y * v.y + u.z * v.z)
        }
        if acos(Stats.clamp(minDot, -1, 1)) * 180 / .pi > motionDegrees { lastMotionT = t }
        return true
    }

    /// True if the machine was rotating in the motion window ending at `t`.
    func wasMoving(at t: Double) -> Bool { t - lastMotionT <= 0.03 }

    /// Angle in degrees between two gravity vectors.
    static func angle(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double {
        let na = (a * a).sum().squareRoot(), nb = (b * b).sum().squareRoot()
        guard na > 0, nb > 0 else { return 0 }
        return acos(Stats.clamp((a * b).sum() / (na * nb), -1, 1)) * 180 / .pi
    }

    mutating func reset() {
        initialized = false
        counter = 0
        ringCursor = 0
        lastMotionT = -.infinity
    }
}
