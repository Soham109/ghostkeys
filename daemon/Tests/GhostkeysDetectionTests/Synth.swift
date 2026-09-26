// Synthetic 797 Hz IMU streams for tests.
//
// Model of a tap at normalized position (x, y) with force direction F:
// - accel: a short half-sine force pulse along F (3 to 6 ms), then a damped ringing of the chassis
//   along a zone-specific mode shape at a zone-specific frequency;
// - gyro: the torque r x F spins the machine a little: a damped low-frequency (30 Hz) angular
//   velocity along w = (-(y-0.5) Fz, (x-0.5) Fz + 0.1 Fx, (x-0.5) Fy - (y-0.5) Fx), so that
//   twistY / impulseZ grows with x and -twistX / impulseZ grows with y, as in the feature docs.
// Noise: strongly low-frequency accel noise like the real recording (AR(1), lag-1 0.97, ~2 mg),
// a little white noise, gyro bias + white noise quantized to the real 0.061 deg/s step.

import Foundation
@testable import GhostkeysDetection

let fs = 797.0

struct Rng {
    var g: SplitMix64
    init(_ seed: UInt64) { g = SplitMix64(seed: seed) }
    mutating func uniform() -> Double { Double(g.next() >> 11) / Double(1 << 53) }
    mutating func uniform(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * uniform() }
    mutating func gaussian() -> Double {
        let u1 = max(uniform(), 1e-12), u2 = uniform()
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
    mutating func logUniform(_ lo: Double, _ hi: Double) -> Double { exp(uniform(log(lo), log(hi))) }
}

struct ZoneSpec {
    var name: String
    var x: Double, y: Double
    var force: SIMD3<Double>
    var mode: SIMD3<Double>
    var freq: Double
    var decay: Double

    static let leftPalm = ZoneSpec(name: "left-palm", x: 0.2, y: 0.8, force: [0, 0, 1], mode: [0.25, 0.1, 1], freq: 95, decay: 0.012)
    static let rightPalm = ZoneSpec(name: "right-palm", x: 0.8, y: 0.8, force: [0, 0, 1], mode: [-0.25, 0.1, 1], freq: 100, decay: 0.012)
    static let leftGrille = ZoneSpec(name: "left-grille", x: 0.07, y: 0.3, force: [0, 0, 1], mode: [0.4, -0.2, 1], freq: 160, decay: 0.008)
    static let rightGrille = ZoneSpec(name: "right-grille", x: 0.93, y: 0.3, force: [0, 0, 1], mode: [-0.4, -0.2, 1], freq: 170, decay: 0.008)
    static let topStrip = ZoneSpec(name: "top-strip", x: 0.5, y: 0.05, force: [0, 0, 1], mode: [0, -0.5, 1], freq: 210, decay: 0.006)
    static let leftEdge = ZoneSpec(name: "left-edge", x: 0.0, y: 0.5, force: [1, 0, 0.15], mode: [1, 0.1, 0.3], freq: 70, decay: 0.015)
    static let rightEdge = ZoneSpec(name: "right-edge", x: 1.0, y: 0.5, force: [-1, 0, 0.15], mode: [-1, 0.1, 0.3], freq: 72, decay: 0.015)
    static let lid = ZoneSpec(name: "lid", x: 0.5, y: 0.0, force: [0, -1, 0.3], mode: [0, 1, 0.4], freq: 45, decay: 0.02)

    static let six: [ZoneSpec] = [.leftPalm, .rightPalm, .leftGrille, .rightGrille, .topStrip, .rightEdge]
}

/// Builds a sample stream; add events, then call `samples()`.
struct StreamBuilder {
    let n: Int
    var a: [SIMD3<Double>]
    var g: [SIMD3<Double>]
    var rng: Rng

    static let restGravity = SIMD3<Double>(0.0117, -0.0061, -0.9897)

    init(seconds: Double, seed: UInt64 = 1, noiseMg: Double = 2, gravity: SIMD3<Double> = StreamBuilder.restGravity) {
        n = Int(seconds * fs)
        rng = Rng(seed)
        a = Array(repeating: gravity, count: n)
        g = Array(repeating: [0.121, -0.092, -0.006], count: n)
        var ar = SIMD3<Double>(0, 0, 0)
        let phi = 0.97, sigmaE = noiseMg / 1000 * (1 - phi * phi).squareRoot()
        for i in 0..<n {
            ar = phi * ar + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * sigmaE
            a[i] += ar + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.0003
            g[i] += SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.07
        }
    }

    /// Adds a tap. `amp` is the peak force pulse in g (random log-uniform 60..400 mg when nil).
    /// Returns the true start time.
    @discardableResult
    mutating func addTap(_ z: ZoneSpec, at t0: Double, amp: Double? = nil, jitter: Double = 1) -> Double {
        let A = amp ?? rng.logUniform(0.06, 0.4)
        let px = z.x + 0.025 * jitter * rng.gaussian(), py = z.y + 0.025 * jitter * rng.gaussian()
        var F = z.force + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.06 * jitter
        F /= (F * F).sum().squareRoot()
        let mode = z.mode + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.08 * jitter
        let f = z.freq * (1 + 0.05 * jitter * rng.gaussian())
        let decay = z.decay * (1 + 0.1 * jitter * rng.gaussian())
        let tp = rng.uniform(0.003, 0.006)
        let w = SIMD3(-(py - 0.5) * F.z, (px - 0.5) * F.z + 0.1 * F.x, (px - 0.5) * F.y - (py - 0.5) * F.x)
        addImpulse(at: t0, amp: A, force: F, mode: mode, ringAmp: 0.6, freq: f, decay: decay, pulse: tp, twist: w * 80)
        return t0
    }

    /// A keystroke: small, short, sharp, from the middle of the keyboard.
    mutating func addKeystroke(at t0: Double, amp: Double? = nil) {
        let A = amp ?? rng.logUniform(0.03, 0.12)
        let px = rng.uniform(0.25, 0.75), py = rng.uniform(0.3, 0.55)
        var F = SIMD3<Double>(0.1 * rng.gaussian(), 0.1 * rng.gaussian(), 1)
        F /= (F * F).sum().squareRoot()
        let mode = SIMD3<Double>(0.5 * rng.gaussian(), 0.5 * rng.gaussian(), 1)
        let w = SIMD3(-(py - 0.5) * F.z, (px - 0.5) * F.z, 0)
        addImpulse(at: t0, amp: A, force: F, mode: mode, ringAmp: 0.8, freq: rng.uniform(260, 330),
                   decay: rng.uniform(0.002, 0.004), pulse: rng.uniform(0.0015, 0.0025), twist: w * 30)
    }

    mutating func addImpulse(at t0: Double, amp A: Double, force F: SIMD3<Double>, mode: SIMD3<Double>, ringAmp: Double,
                             freq f: Double, decay: Double, pulse tp: Double, twist w: SIMD3<Double>) {
        let i0 = Int((t0 * fs).rounded(.up))
        let frac = Double(i0) / fs - t0
        for k in 0..<Int(0.25 * fs) {
            let i = i0 + k
            guard i < n else { break }
            let tau = Double(k) / fs + frac
            let p = tau < tp ? sin(.pi * tau / tp) : 0
            let ring = exp(-tau / decay) * sin(2 * .pi * f * tau)
            a[i] += A * (F * p + mode * (ringAmp * ring))
            g[i] += A * w * (exp(-tau / 0.010) * cos(2 * .pi * 30 * tau))
        }
    }

    /// A sustained vibration (e.g. the machine being bumped along), `seconds` long.
    mutating func addVibration(at t0: Double, seconds: Double, amp: Double, freq: Double = 90) {
        let i0 = Int(t0 * fs)
        for k in 0..<Int(seconds * fs) where i0 + k < n {
            let tau = Double(k) / fs
            a[i0 + k] += SIMD3(0.3, 0.2, 1) * (amp * sin(2 * .pi * freq * tau))
        }
    }

    /// Rotates gravity by `degrees` about the front-back axis (roll) from t0, ramping over `ramp` s,
    /// holding for `hold` s and ramping back when `back` is true.
    mutating func addRoll(at t0: Double, degrees: Double, ramp: Double, hold: Double, back: Bool = true) {
        for i in 0..<n {
            let t = Double(i) / fs
            var angle = 0.0
            if t >= t0 {
                let u = t - t0
                if u < ramp { angle = degrees * u / ramp }
                else if u < ramp + hold || !back { angle = degrees }
                else if u < 2 * ramp + hold { angle = degrees * (1 - (u - ramp - hold) / ramp) }
            }
            guard angle != 0 else { continue }
            // Right side down (positive roll) tilts "up" toward -x. Replace the static gravity part
            // with the rotated one, keep the noise and any taps.
            let r = angle * .pi / 180
            let up = SIMD3<Double>(-sin(r), 0, -cos(r))
            a[i] = up * 0.9898 + (a[i] - StreamBuilder.restGravity)
        }
    }

    /// A short rock of the whole machine: roll goes to `degrees` and back as a smooth bump lasting
    /// `duration` s (what a firm tap does to a laptop resting on a lap).
    mutating func addRock(at t0: Double, degrees: Double, duration: Double) {
        let i0 = Int(t0 * fs)
        for k in 0..<Int(duration * fs) where i0 + k < n {
            let u = Double(k) / fs / duration
            let r = degrees * pow(sin(.pi * u), 2) * .pi / 180
            let up = SIMD3<Double>(-sin(r), 0, -cos(r))
            a[i0 + k] = up * 0.9898 + (a[i0 + k] - StreamBuilder.restGravity)
        }
    }

    func samples() -> [IMUSample] {
        (0..<n).map { i in
            let gq = (g[i] / 0.061).rounded(.toNearestOrEven) * 0.061
            return IMUSample(t: Double(i) / fs, a: a[i], g: gq)
        }
    }
}

/// Loads the real 12 s rest recording.
func restRecording() -> [IMUSample] {
    let data = Data(base64Encoded: RestRecording.base64, options: .ignoreUnknownCharacters)!
    var out: [IMUSample] = []
    out.reserveCapacity(RestRecording.sampleCount)
    data.withUnsafeBytes { raw in
        let p = raw.bindMemory(to: Int32.self)
        for i in 0..<(p.count / 6) {
            let v = (0..<6).map { Double(Int32(littleEndian: p[i * 6 + $0])) / 65536 }
            out.append(IMUSample(t: Double(i) / fs, a: [v[0], v[1], v[2]], g: [v[3], v[4], v[5]]))
        }
    }
    return out
}

/// Input activity for the context: key and mouse event times, delivered `delay` s late.
struct InputScript {
    var keys: [Double] = []
    var mouse: [Double] = []
    var paused: ClosedRange<Double>? = nil
    var modifiers: Set<String> = []
    var delay = 0.0

    func context(at t: Double) -> InputContext {
        let k = keys.last(where: { $0 + delay <= t })
        let m = mouse.last(where: { $0 + delay <= t })
        return InputContext(secondsSinceKey: k.map { t - $0 } ?? 99, secondsSinceMouse: m.map { t - $0 } ?? 99,
                            modifiers: modifiers, paused: paused?.contains(t) ?? false)
    }
}

/// Runs samples through an engine, returning events with the sample time at which they were emitted.
func run(_ engine: TapEngine, _ samples: [IMUSample], input: InputScript = InputScript()) -> [(at: Double, event: DetectorEvent)] {
    var out: [(Double, DetectorEvent)] = []
    let simple = input.keys.isEmpty && input.mouse.isEmpty && input.paused == nil && input.modifiers.isEmpty
    let idle = InputContext()
    for s in samples {
        for e in engine.ingest(s, context: simple ? idle : input.context(at: s.t)) { out.append((s.t, e)) }
    }
    return out
}

extension Array where Element == (at: Double, event: DetectorEvent) {
    var candidates: [TapFeatures] { compactMap { if case .candidate(let f) = $0.event { return f }; return nil } }
    var rejections: [(t: Double, reason: RejectReason)] {
        compactMap { if case .rejected(let t, let r) = $0.event { return (t, r) }; return nil }
    }
    var taps: [TapEvent] { compactMap { if case .tap(let t) = $0.event { return t }; return nil } }
    var gestures: [(at: Double, g: GestureEvent)] {
        compactMap { if case .gesture(let g) = $0.event { return ($0.at, g) }; return nil }
    }
}

/// Matches detected times to true times within `tolerance`; returns (hits, falsePositives).
func match(detected: [Double], truth: [Double], tolerance: Double = 0.02) -> (hits: Int, falsePositives: Int) {
    var used = Set<Int>()
    var hits = 0, fp = 0
    for d in detected {
        if let j = truth.indices.first(where: { !used.contains($0) && abs(truth[$0] - d) <= tolerance }) {
            used.insert(j); hits += 1
        } else { fp += 1 }
    }
    return (hits, fp)
}

/// Captures labeled calibration features for zones by running a synthetic session through an engine.
func captureCalibration(zones: [ZoneSpec], perZone: Int, keystrokes: Int = 0, seed: UInt64 = 7)
    -> (features: [TapFeatures], labels: [String]) {
    var feats: [TapFeatures] = [], labels: [String] = []
    for (zi, z) in zones.enumerated() {
        var b = StreamBuilder(seconds: 1 + Double(perZone) * 0.7, seed: seed &+ UInt64(zi) &* 101)
        var truth: [Double] = []
        for k in 0..<perZone { truth.append(b.addTap(z, at: 1 + Double(k) * 0.7)) }
        let engine = TapEngine(settings: DetectionSettings())
        for f in run(engine, b.samples()).candidates where truth.contains(where: { abs($0 - f.t) < 0.02 }) {
            feats.append(f); labels.append(z.name)
        }
    }
    if keystrokes > 0 {
        var b = StreamBuilder(seconds: 1 + Double(keystrokes) * 0.25, seed: seed &+ 999)
        for k in 0..<keystrokes { b.addKeystroke(at: 1 + Double(k) * 0.25) }
        let engine = TapEngine(settings: DetectionSettings())
        engine.bypassInputGates = true
        for f in run(engine, b.samples()).candidates { feats.append(f); labels.append("none") }
    }
    return (feats, labels)
}

/// JSON encode + decode (lives here because test files that import Testing avoid Foundation).
func jsonRoundTrip<T: Codable>(_ v: T) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONEncoder().encode(v))
}
