// Synthetic audio for tests. Nothing here touches a microphone or a speaker.
import Foundation
@testable import GhostkeysAcoustics

struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    mutating func uniform() -> Float { Float(next() >> 40) / Float(1 << 24) * 2 - 1 }
    mutating func range(_ lo: Double, _ hi: Double) -> Double { lo + (hi - lo) * Double(next() >> 11) / Double(1 << 53) }
}

enum Synth {
    static let sr = 48_000.0

    static func noise(_ count: Int, _ rng: inout SeededRNG, amplitude: Float = 1) -> [Float] {
        (0..<count).map { _ in rng.uniform() * amplitude }
    }

    static func filter(_ x: [Float], _ coefficients: [Double]) -> [Float] {
        BiquadFilter(coefficients: coefficients).process(x)
    }

    static func rms(_ x: [Float]) -> Float { (x.reduce(0) { $0 + $1 * $1 } / Float(max(1, x.count))).squareRoot() }

    static func scaled(_ x: [Float], toRms target: Float) -> [Float] {
        let r = rms(x)
        return r > 0 ? x.map { $0 * target / r } : x
    }

    static func add(_ a: inout [Float], _ b: [Float], at offset: Int) {
        for i in 0..<b.count where offset + i >= 0 && offset + i < a.count { a[offset + i] += b[i] }
    }

    static func db(_ v: Double) -> Float { Float(pow(10, v / 20)) }

    // MARK: Taps

    /// A 40 ms window with a synthetic tap starting at 2 ms (the aligner's preroll). The three types differ the way
    /// real ones do: fingertip is soft, low and slow to decay; knuckle is mid-band, sharper and louder; nail is a
    /// short, bright click.
    static func tapWindow(_ type: TapType, _ rng: inout SeededRNG, onsetOffset: Int = 96, length: Int = 1920) -> [Float] {
        var out = noise(length, &rng, amplitude: 0.0005)
        let n = length - onsetOffset
        var burst = noise(n, &rng)
        let tau: Double, attack: Double, level: Double
        switch type {
        case .fingertip:
            burst = filter(burst, BiquadFilter.lowpass(cutoff: rng.range(500, 900), sampleRate: sr) + BiquadFilter.lowpass(cutoff: 900, sampleRate: sr))
            tau = rng.range(0.009, 0.016); attack = 0.002; level = rng.range(0.05, 0.12)
        case .knuckle:
            burst = filter(burst, BiquadFilter.bandpass(center: rng.range(1_800, 2_800), q: 1.2, sampleRate: sr))
            tau = rng.range(0.004, 0.008); attack = 0.0004; level = rng.range(0.15, 0.35)
        case .nail:
            burst = filter(burst, BiquadFilter.highpass(cutoff: rng.range(5_000, 7_000), sampleRate: sr) + BiquadFilter.highpass(cutoff: 5_000, sampleRate: sr))
            tau = rng.range(0.0012, 0.003); attack = 0.0001; level = rng.range(0.05, 0.15)
        }
        burst = scaled(burst, toRms: 1)
        for i in 0..<n {
            let t = Double(i) / sr
            let env = min(1, t / attack) * exp(-t / tau)
            burst[i] *= Float(env * level)
        }
        add(&out, burst, at: onsetOffset)
        return out
    }

    // MARK: Rubs and distractors

    /// Friction noise in 2 to 12 kHz with soft 15 ms edges. `trendDb` is the loudness change start to end;
    /// `combHz` > 0 adds grille-hole amplitude modulation at that rate.
    static func rub(duration: Double, levelDb: Double = -30, trendDb: Double = 0, combHz: Double = 0, combDepth: Double = 0.8,
                    _ rng: inout SeededRNG) -> [Float] {
        let n = Int(duration * sr)
        var x = noise(n, &rng)
        x = filter(x, BiquadFilter.highpass(cutoff: 2_000, sampleRate: sr) + BiquadFilter.highpass(cutoff: 2_000, sampleRate: sr)
                   + BiquadFilter.lowpass(cutoff: 12_000, sampleRate: sr) + BiquadFilter.lowpass(cutoff: 12_000, sampleRate: sr))
        x = scaled(x, toRms: db(levelDb))
        let edge = 0.015
        for i in 0..<n {
            let t = Double(i) / sr
            let ramp = min(1, t / edge, (duration - t) / edge)
            let trend = pow(10, (trendDb * (t / duration - 0.5)) / 20)
            let comb = combHz > 0 ? 1 + combDepth * sin(2 * .pi * combHz * t) : 1
            x[i] *= Float(max(0, ramp) * trend * comb)
        }
        return x
    }

    /// Key clicks: 1 ms broadband burst with a 5 ms tail, at `rate` per second with jitter.
    static func typing(duration: Double, rate: Double = 9, _ rng: inout SeededRNG) -> [Float] {
        let n = Int(duration * sr)
        var x = [Float](repeating: 0, count: n)
        var t = 0.05
        while t < duration - 0.05 {
            let len = Int(0.03 * sr)
            var click = noise(len, &rng)
            click = filter(click, BiquadFilter.highpass(cutoff: 1_500, sampleRate: sr))
            let level = rng.range(0.1, 0.3)
            for i in 0..<len {
                let tt = Double(i) / sr
                click[i] *= Float(level * (tt < 0.001 ? 1 : exp(-(tt - 0.001) / 0.005)))
            }
            add(&x, click, at: Int(t * sr))
            t += 1 / rate * rng.range(0.7, 1.3)
        }
        return x
    }

    /// Voice-like: a glottal pulse train (f0 110 to 220 Hz with vibrato) and syllable-rate loudness.
    /// `bright` high-passes it at 2 kHz so its energy sits in the friction band and only harmonicity can reject it.
    static func speechLike(duration: Double, bright: Bool, _ rng: inout SeededRNG) -> [Float] {
        let n = Int(duration * sr)
        var x = [Float](repeating: 0, count: n)
        var phase = 0.0
        let f0 = rng.range(110, 220)
        for i in 0..<n {
            let t = Double(i) / sr
            let f = f0 * (1 + 0.03 * sin(2 * .pi * 5 * t))
            phase += f / sr
            if phase >= 1 { phase -= 1; x[i] = 1 }
        }
        x = filter(x, BiquadFilter.lowpass(cutoff: 5_000, sampleRate: sr))
        if bright {
            x = filter(x, BiquadFilter.highpass(cutoff: 2_000, sampleRate: sr) + BiquadFilter.highpass(cutoff: 2_000, sampleRate: sr))
        }
        x = scaled(x, toRms: db(-28))
        for i in 0..<n {
            let t = Double(i) / sr
            x[i] *= Float(0.55 + 0.45 * sin(2 * .pi * 4 * t))
        }
        let breath = noise(n, &rng, amplitude: 0.0005)
        for i in 0..<n { x[i] += breath[i] }
        return x
    }

    /// Music-like: a sustained chord of pure tones reaching into the friction band.
    static func musicLike(duration: Double) -> [Float] {
        let n = Int(duration * sr)
        let tones: [Double] = [523.25, 659.25, 783.99, 2_093, 2_637, 3_136, 4_186, 6_272]
        var x = [Float](repeating: 0, count: n)
        for i in 0..<n {
            let t = Double(i) / sr
            var v = 0.0
            for (j, f) in tones.enumerated() { v += sin(2 * .pi * f * t + Double(j)) / Double(tones.count) }
            x[i] = Float(v * 0.1)
        }
        return x
    }

    // MARK: Sonar

    enum Motion { case toward, away, sweep }

    /// Pilot tone plus hand reflections: eight scatterers whose Doppler shift follows a smooth speed profile.
    static func sonar(duration: Double, pilotAmplitude: Double = 0.03, motions: [(start: Double, length: Double, kind: Motion)],
                      maxShiftHz: Double = 80, reflectionDb: Double = -25, _ rng: inout SeededRNG) -> [Float] {
        let n = Int(duration * sr)
        let f0 = SonarConfig.defaultPilotHz
        var x = noise(n, &rng, amplitude: 0.00003)
        for i in 0..<n { x[i] += Float(pilotAmplitude * sin(2 * .pi * f0 * Double(i) / sr)) }
        let reflAmp = pilotAmplitude * pow(10, reflectionDb / 20)
        for m in motions {
            let scatter = (0..<8).map { _ in (u: rng.range(0.4, 1.0), phase: rng.range(0, 2 * .pi)) }
            var phases = scatter.map(\.phase)
            let i0 = Int(m.start * sr), len = Int(m.length * sr)
            for i in 0..<len where i0 + i < n {
                let tau = Double(i) / Double(len)
                let shape = sin(.pi * tau)
                let shift: Double
                switch m.kind {
                case .toward: shift = maxShiftHz * shape
                case .away: shift = -maxShiftHz * shape
                case .sweep: shift = maxShiftHz * sin(2 * .pi * tau)
                }
                var v = 0.0
                for (j, s) in scatter.enumerated() {
                    phases[j] += 2 * .pi * (f0 + shift * s.u) / sr
                    v += sin(phases[j])
                }
                x[i0 + i] += Float(reflAmp * shape * v)
            }
        }
        return x
    }

    /// Feeds `x` to `body` in chunks, like the audio tap does. Returns everything `body` returned.
    static func stream<T>(_ x: [Float], chunk: Int = 256, startTime: Double = 0, _ body: (UnsafeBufferPointer<Float>, Double) -> [T]) -> [T] {
        var out: [T] = []
        x.withUnsafeBufferPointer { p in
            var i = 0
            while i < x.count {
                let n = min(chunk, x.count - i)
                out += body(UnsafeBufferPointer(rebasing: p[i..<(i + n)]), startTime + Double(i) / sr)
                i += n
            }
        }
        return out
    }
}

/// JSON round trip, kept in a file that does not import Testing (the Command Line Tools lack the
/// Foundation + Testing cross-import overlay).
func jsonRoundTrip<T: Codable>(_ value: T) throws -> T {
    try JSONDecoder().decode(T.self, from: JSONEncoder().encode(value))
}

// MARK: SonarField scenes

/// Laptop geometry for synthetic SonarField scenes, meters. x: left to right, y: hinge (0) toward the front lip,
/// z: up from the deck. Speakers under the side grilles; the microphone array near the hinge on the left.
enum FieldGeometry {
    static let leftSpeaker = SIMD3<Double>(-0.145, 0.08, 0)
    static let rightSpeaker = SIMD3<Double>(0.145, 0.08, 0)
    static let mic = SIMD3<Double>(-0.12, 0.01, 0)

    static func dist(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double { ((a - b) * (a - b)).sum().squareRoot() }
    /// Speaker -> hand -> mic path length for each side.
    static func paths(_ p: SIMD3<Double>) -> (left: Double, right: Double) {
        (dist(p, leftSpeaker) + dist(p, mic), dist(p, rightSpeaker) + dist(p, mic))
    }
}

extension Synth {
    /// Smooth 0 -> 1 between t0 and t1 (half-cosine).
    static func ease(_ t: Double, _ t0: Double, _ t1: Double) -> Double {
        if t <= t0 { return 0 }
        if t >= t1 { return 1 }
        return 0.5 - 0.5 * cos(Double.pi * (t - t0) / (t1 - t0))
    }

    static func lerp(_ a: SIMD3<Double>, _ b: SIMD3<Double>, _ u: Double) -> SIMD3<Double> { a + (b - a) * u }

    /// Mono microphone signal with both SonarField pilots (direct path) plus one reflector following `hand(t)`.
    /// The echo of each pilot travels speaker -> hand -> mic, so its phase and Doppler follow the true path length.
    /// `driftHz` shifts both received pilots (a speaker/mic clock mismatch). `reflect` limits which pilots echo.
    static func field(duration: Double, hand: (Double) -> SIMD3<Double>, reflectionDb: Double = -25,
                      pilotAmplitude: Double = 0.0158, driftHz: Double = 0, reflect: Set<SpeakerSide> = [.left, .right],
                      noise: Float = 0.00003, _ rng: inout SeededRNG) -> [Float] {
        let n = Int(duration * sr)
        let fL = SonarFieldConfig.defaultLeftPilotHz + driftHz, fR = SonarFieldConfig.defaultRightPilotHz + driftHz
        let echo = pilotAmplitude * pow(10, reflectionDb / 20)
        var x = Synth.noise(n, &rng, amplitude: noise)
        let c = 343.0
        for i in 0..<n {
            let t = Double(i) / sr
            let (pl, pr) = FieldGeometry.paths(hand(t))
            var v = pilotAmplitude * (cos(2 * .pi * fL * t + 0.3) + cos(2 * .pi * fR * t + 1.1))
            if reflect.contains(.left) { v += echo * cos(2 * .pi * fL * (t - pl / c) + 0.7) }
            if reflect.contains(.right) { v += echo * cos(2 * .pi * fR * (t - pr / c) + 2.0) }
            x[i] += Float(v)
        }
        return x
    }

    /// Friction noise with its ultrasonic tail removed (real fingertip friction carries little energy at 19-21 kHz).
    static func quietRub(duration: Double, levelDb: Double = -34, _ rng: inout SeededRNG) -> [Float] {
        let lp = BiquadFilter.lowpass(cutoff: 11_000, sampleRate: sr)
        return filter(rub(duration: duration, levelDb: levelDb, &rng), lp + lp + lp + lp)
    }
}
