import Foundation

/// "The laptop itself is moving" (lifted, tilted, carried), for pausing sonar. A copy of the detection library's
/// motion gate (GhostkeysDetection/Onset/GravityMonitor.swift, which is internal): the direction of a 200 ms
/// low-passed gravity vector, checked every 8 samples; rotation above 3 degrees within 0.5 s that lasts 150 ms counts
/// as moving, and the estimate ignores the 150 ms after each tap onset so a tap's own rocking never counts.
///
/// Why not a level threshold: on the real session1 recording (laptop on a lap, hands resting on the palm rests), the
/// old rule (|a| more than 0.05 g off 1 g, or any rotation over 15 deg/s, held 0.45 s) kept sonar paused 74 to 96% of
/// the still time between taps (the resting accelerometer already reads 15 to 18 mg under 1 g, and resting wrists rock
/// a soft support). This gate paused it 0 to 7% there, and still flags real repositioning. Knocks and clicks do not need
/// a pause here: SonarField voids its own phase samples around impulses.
struct MotionGate {
    var sampleRate = 797.0
    private var g = SIMD3<Double>(0, 0, 0)
    private var initialized = false
    private var alpha = 0.0
    private var counter = 0
    private var frozenUntil = -Double.infinity
    private var ring: [(t: Double, v: SIMD3<Double>)] = []
    private var rotatingSince: Double?
    private(set) var isMoving = false
    /// Last time the laptop was moving.
    private(set) var lastMoving = -Double.infinity

    mutating func freeze(until t: Double) { frozenUntil = max(frozenUntil, t) }

    mutating func process(_ a: SIMD3<Double>, t: Double) {
        if !initialized { g = a; alpha = 1 - exp(-1 / (0.2 * sampleRate)); initialized = true }
        if t >= frozenUntil { g += alpha * (a - g) }
        counter += 1
        guard counter % 8 == 0 else { return }
        let n = (g * g).sum().squareRoot()
        guard n > 0.2 else { return }
        let u = g / n
        ring.append((t, u))
        while let first = ring.first, t - first.t > 0.5 { ring.removeFirst() }
        let minDot = ring.map { ($0.v * u).sum() }.min() ?? 1
        let degrees = acos(max(-1, min(1, minDot))) * 180 / .pi
        if degrees > 3 {
            if rotatingSince == nil { rotatingSince = t }
            isMoving = t - rotatingSince! >= 0.15
        } else {
            rotatingSince = nil
            isMoving = false
        }
        if isMoving { lastMoving = t }
    }
}
