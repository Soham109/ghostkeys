// Tilt gesture: the laptop is rolled sideways by more than 8 degrees and brought back within 2 s.
//
// Roll is read from the low-passed gravity ("up") vector. At rest this Mac reads about
// (0.01, -0.01, -0.99) g, so "up" is -z. If the right side of the machine goes down, "up" leans
// toward the left side, i.e. toward -x when +x points to the right. So
//     roll = atan2(-up.x, -up.z)     (degrees, positive = right side down)
// `rollSign` flips the convention should the sensor's x axis point the other way on some model.

import Foundation

struct TiltDetector {
    var triggerDegrees = 8.0
    var returnDegrees = 3.0
    var maxDuration = 2.0
    var baselineSeconds = 1.0
    var rollSign = 1.0

    private enum State { case idle, excursion(start: Double, peak: Double) }
    private var state = State.idle
    private var baseline: Double?
    private var lastT: Double?

    mutating func reset() { state = .idle; baseline = nil; lastT = nil }

    static func roll(_ up: SIMD3<Double>) -> Double { atan2(-up.x, -up.z) * 180 / .pi }

    /// Feed the gravity vector on the decimated ticks. Returns "tilt_left" / "tilt_right".
    mutating func process(gravity up: SIMD3<Double>, t: Double) -> String? {
        let roll = rollSign * Self.roll(up)
        let dt = lastT.map { t - $0 } ?? 0
        lastT = t
        guard let base = baseline else { baseline = roll; return nil }
        let dev = roll - base

        switch state {
        case .idle:
            if abs(dev) > triggerDegrees {
                state = .excursion(start: t, peak: dev)
            } else if abs(dev) < returnDegrees {
                // Slowly follow the resting roll (desk not level, lap, stand).
                let a = min(1, dt / baselineSeconds)
                baseline = base + a * dev
            } else {
                // Between 3 and 8 degrees off: a slow change of resting position. Re-baseline slowly.
                let a = min(1, dt / (4 * baselineSeconds))
                baseline = base + a * dev
            }
            return nil
        case .excursion(let start, let peak):
            let newPeak = abs(dev) > abs(peak) ? dev : peak
            if t - start > maxDuration {
                // Held too long: not a gesture, the machine now rests at a new angle.
                state = .idle
                baseline = roll
                return nil
            }
            if abs(dev) < returnDegrees {
                state = .idle
                return newPeak > 0 ? "tilt_right" : "tilt_left"
            }
            state = .excursion(start: start, peak: newPeak)
            return nil
        }
    }
}
