// Synthetic hand-pose generator: builds plausible 21-joint landmark sets for a given posture, so gesture logic
// can be tested without a camera.
import Darwin
@testable import GhostkeysVision

enum Posture {
    case open        // all fingers extended, thumb out
    case pinch       // thumb tip touching index tip, other fingers extended
    case point       // index extended, others curled
    case fist
}

struct SynthRNG: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed &+ 0x9E3779B97F4A7C15 }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func gaussian() -> Double {
        let u1 = max(Double.random(in: 0..<1, using: &self), 1e-12)
        let u2 = Double.random(in: 0..<1, using: &self)
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
}

/// Builds a hand with the wrist at `wrist`, hand size `s` (wrist to middle knuckle), fingers pointing up (-y).
func makeHand(_ posture: Posture, wrist: Point2 = Point2(0.5, 0.7), s: Double = 0.12,
              confidence: Double = 0.9, chirality: Chirality = .right) -> HandLandmarks {
    var p = [Point2](repeating: .zero, count: 21)
    func set(_ j: HandJoint, _ dx: Double, _ dy: Double) { p[j.rawValue] = wrist + Point2(dx * s, dy * s) }
    set(.wrist, 0, 0)
    // Knuckles.
    let mcp: [(HandJoint, Double, Double)] = [(.indexMCP, -0.3, -0.95), (.middleMCP, 0, -1),
                                              (.ringMCP, 0.22, -0.95), (.littleMCP, 0.42, -0.85)]
    for (j, x, y) in mcp { set(j, x, y) }
    func finger(_ f: Finger, extended: Bool) {
        let j = f.joints
        let base = p[j.mcp.rawValue]
        func at(_ dx: Double, _ dy: Double) -> Point2 { base + Point2(dx * s, dy * s) }
        if extended {
            p[j.pip.rawValue] = at(0, -0.45)
            p[j.dip.rawValue] = at(0, -0.73)
            p[j.tip.rawValue] = at(0, -0.95)
        } else {
            p[j.pip.rawValue] = at(0, -0.3)
            p[j.dip.rawValue] = at(0, -0.15)
            p[j.tip.rawValue] = at(0, 0.1)
        }
    }
    switch posture {
    case .open:
        Finger.allCases.forEach { finger($0, extended: true) }
    case .pinch:
        Finger.allCases.forEach { finger($0, extended: true) }
        // Index bends down toward the thumb.
        set(.indexPIP, -0.35, -1.35)
        set(.indexDIP, -0.42, -1.4)
        set(.indexTip, -0.48, -1.3)
    case .point:
        finger(.index, extended: true)
        [Finger.middle, .ring, .little].forEach { finger($0, extended: false) }
    case .fist:
        Finger.allCases.forEach { finger($0, extended: false) }
    }
    // Thumb.
    set(.thumbCMC, -0.3, -0.2)
    set(.thumbMP, -0.55, -0.4)
    switch posture {
    case .pinch:
        set(.thumbIP, -0.6, -0.9)
        set(.thumbTip, -0.52, -1.27)
    case .point, .fist:
        set(.thumbIP, -0.5, -0.6)
        set(.thumbTip, -0.35, -0.7)
    case .open:
        set(.thumbIP, -0.7, -0.6)
        set(.thumbTip, -0.8, -0.8)
    }
    return HandLandmarks(points: p, confidences: Array(repeating: confidence, count: 21), chirality: chirality)
}

func jittered(_ h: HandLandmarks, sigma: Double, rng: inout SynthRNG) -> HandLandmarks {
    var out = h
    for i in 0..<21 { out.points[i] = out.points[i] + Point2(rng.gaussian() * sigma, rng.gaussian() * sigma) }
    return out
}

/// A timeline builder at a fixed frame rate.
struct Timeline {
    var fps: Double = 30
    var frames: [HandFrame] = []
    var t: Double = 0

    mutating func add(_ n: Int, _ hands: (Int) -> [HandLandmarks]) {
        for i in 0..<n {
            frames.append(HandFrame(t: t, hands: hands(i)))
            t += 1 / fps
        }
    }
    mutating func add(_ n: Int, _ hand: HandLandmarks?) { add(n) { _ in hand.map { [$0] } ?? [] } }
}

func run(_ frames: [HandFrame], config: AirGestureConfig = AirGestureConfig()) -> [AirGestureEvent] {
    let r = AirGestureRecognizer(config: config)
    return frames.flatMap { r.process($0) }
}

func discrete(_ ev: [AirGestureEvent]) -> [AirGesture] { ev.filter { $0.phase == .instant }.map(\.gesture) }

func seconds(_ d: Duration) -> Double {
    let c = d.components
    return Double(c.seconds) + Double(c.attoseconds) / 1e18
}

func fmt(_ v: Double, _ digits: Int = 3) -> String {
    let p = pow(10.0, Double(digits))
    return String((v * p).rounded() / p)
}
