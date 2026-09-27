// Tracks the direction of gravity to tell "the laptop itself is moving" apart from taps.
//
// At rest the accelerometer reads +1 g pointing up (it measures the reaction to gravity), so a
// low-passed accel vector is the "up" direction in device coordinates. Its direction changes when
// the machine is rotated (lifted, tilted, carried).
//
// Taps rotate it too, briefly. On a desk that is a fraction of a degree, but on a lap (the first real
// recording) the soft support lets a tap rock the machine: the 50 ms low-passed gravity turned by
// 1 to 6 degrees during palm taps, and the old gate (3 degrees within 0.5 s) rejected 24 of 61 taps.
// Three measures separate sustained motion from those transients (evaluated in
// analysis/motion_gate_eval.py: 0 of 61 taps gated, 67% of the repositioning period still flagged):
//   1. a slower 200 ms low-pass,
//   2. the estimate is frozen for 150 ms after each tap onset, so the tap's own rocking never enters it,
//   3. the rotation must stay above 3 degrees for 150 ms before it counts as motion.
//
// The monitor runs at a decimated rate (every 8 samples, about 100 Hz) to stay cheap.

import Foundation

struct GravityMonitor {
    var sampleRate = 797.0
    var lowPassSeconds = 0.2
    var decimation = 8
    /// Rotation above this many degrees within `motionWindow` counts as moving...
    var motionDegrees = 3.0
    var motionWindow = 0.5
    /// ...once it has lasted this long.
    var motionPersist = 0.15
    /// How long the estimate ignores the accelerometer after a tap onset.
    var freezeAfterOnset = 0.15

    private var gx = 0.0, gy = 0.0, gz = 0.0
    private var initialized = false
    private var alpha = 0.0
    private var counter = 0
    private var frozenUntil = -Double.infinity

    // Ring of decimated unit vectors covering a bit more than the motion window.
    private var ringT: [Double] = []
    private var ringV: [SIMD3<Double>] = []
    private var ringCursor = 0
    private var ringCapacity = 0

    private var rotatingSince: Double?
    /// True while sustained rotation is going on.
    private(set) var isMoving = false
    /// Last time `isMoving` was true.
    private(set) var lastMotionT = -Double.infinity
    /// Current low-passed "up" vector in g.
    var gravity: SIMD3<Double> { SIMD3(gx, gy, gz) }
    /// Unit direction of `gravity`; nil before the first sample or when the vector is too short to trust (free fall).
    var direction: SIMD3<Double>? {
        guard initialized else { return nil }
        let n = (gx * gx + gy * gy + gz * gz).squareRoot()
        return n > 0.2 ? SIMD3(gx / n, gy / n, gz / n) : nil
    }

    /// Stop following the accelerometer until `t` (called at a tap onset).
    mutating func freeze(until t: Double) { frozenUntil = max(frozenUntil, t) }

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
        if t >= frozenUntil {
            gx += alpha * (ax - gx); gy += alpha * (ay - gy); gz += alpha * (az - gz)
        }
        counter += 1
        guard counter % decimation == 0 else { return false }

        let n = (gx * gx + gy * gy + gz * gz).squareRoot()
        guard n > 0.2 else { return true }   // free fall or garbage: skip
        let u = SIMD3(gx / n, gy / n, gz / n)
        ringT[ringCursor] = t
        ringV[ringCursor] = u
        ringCursor = (ringCursor + 1) % ringCapacity

        // Largest rotation between now and any stored direction in the last motionWindow
        // (smallest dot product = largest angle; one acos instead of one per entry).
        var minDot = 1.0
        for k in 0..<ringCapacity where t - ringT[k] <= motionWindow {
            let v = ringV[k]
            minDot = min(minDot, u.x * v.x + u.y * v.y + u.z * v.z)
        }
        if acos(Stats.clamp(minDot, -1, 1)) * 180 / .pi > motionDegrees {
            if rotatingSince == nil { rotatingSince = t }
        } else {
            rotatingSince = nil
        }
        isMoving = rotatingSince.map { t - $0 >= motionPersist } ?? false
        if isMoving { lastMotionT = t }
        return true
    }

    /// True if sustained rotation was going on at `t` (within one decimated tick).
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
        rotatingSince = nil
        isMoving = false
        frozenUntil = -.infinity
        lastMotionT = -.infinity
    }
}
