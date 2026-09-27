// Realistic SonarField scenes: a REAL static microphone recording from the MacBook (both pilots playing, nobody
// moving) plus synthetic hand echoes at realistic levels. Nothing here touches a microphone or a speaker; the
// recordings are local files made with the daemon's GHOSTKEYS_SONAR_CAPTURE knob (see SONAR_REPORT.md).
import Foundation
@testable import GhostkeysAcoustics

enum RealRecording {
    /// daemon/analysis/data/sonar, found by walking up from this file (the test runner may compile a copy of it
    /// under daemon/.build-tests), or GHOSTKEYS_SONAR_DATA.
    static let directory: URL = {
        if let env = ProcessInfo.processInfo.environment["GHOSTKEYS_SONAR_DATA"] { return URL(fileURLWithPath: env) }
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("analysis/data/sonar")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        return dir
    }()

    static func exists(_ name: String) -> Bool { FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path) }

    /// Mono float32 WAV (as written by `AcousticSession.writeFloatWav`); first channel if there are several.
    static func load(_ name: String) -> [Float]? {
        guard let d = try? Data(contentsOf: directory.appendingPathComponent(name)), d.count > 44 else { return nil }
        let channels = Int(d[22]) | Int(d[23]) << 8
        var out: [Float] = []
        d.withUnsafeBytes { raw in
            // Find the "data" chunk.
            var i = 12
            while i + 8 <= raw.count {
                let id = String(bytes: raw[i..<i + 4], encoding: .ascii)
                let size = Int(raw.loadUnaligned(fromByteOffset: i + 4, as: UInt32.self))
                if id == "data" {
                    let n = min(size, raw.count - i - 8) / 4
                    out.reserveCapacity(n / max(1, channels))
                    var k = 0
                    while k < n { out.append(raw.loadUnaligned(fromByteOffset: i + 8 + 4 * k, as: Float.self)); k += max(1, channels) }
                    return
                }
                i += 8 + size
            }
        }
        return out
    }
}

/// Builds hand echoes on top of a real recording. Each pilot's complex envelope is taken from the recording itself,
/// so the echo carries the real pilot's level, clock drift and fluctuations; only the hand's path and reflection are
/// synthetic. Echo amplitude follows a point reflector: emitted level x R / (speaker-hand distance x hand-mic
/// distance). Both speakers are assumed to emit the same level; the right speaker's direct path to the mic is just
/// weaker (farther, shadowed), as measured.
struct RealScene {
    let base: [Float]
    let leftHz: Double
    let rightHz: Double
    private let uL: [Cx], uR: [Cx]   // unit-mean complex envelopes of each pilot
    let leftAmplitude: Double         // direct left pilot amplitude at the mic (linear)
    let rightAmplitude: Double
    /// Right speaker's emitted level relative to the left (1 when both channels play the same level).
    let rightEmitRatio: Double
    static let sr = 48_000.0
    static let c = 343.0

    /// `volumeGainDb` models a higher macOS output volume: the pilots (and whatever varies with them within about
    /// 20 Hz) are scaled up; the microphone's own noise is not.
    /// `leftGainDb` / `rightGainDb` add a per-channel level change on top (a different split of the tone budget).
    init(recording: [Float], leftHz: Double = SonarFieldConfig.defaultLeftPilotHz, rightHz: Double = SonarFieldConfig.defaultRightPilotHz,
         volumeGainDb: Double = 0, leftGainDb: Double = 0, rightGainDb: Double = 0) {
        self.leftHz = leftHz
        self.rightHz = rightHz
        let (zl, al) = Self.envelope(recording, hz: leftHz)
        let (zr, ar) = Self.envelope(recording, hz: rightHz)
        uL = zl; uR = zr
        let gl = pow(10, (volumeGainDb + leftGainDb) / 20), gr = pow(10, (volumeGainDb + rightGainDb) / 20)
        leftAmplitude = al * gl; rightAmplitude = ar * gr
        rightEmitRatio = pow(10, (rightGainDb - leftGainDb) / 20)
        var x = recording
        if gl != 1 || gr != 1 {
            let wl = 2 * Double.pi * leftHz / Self.sr, wr = 2 * Double.pi * rightHz / Self.sr
            for i in x.indices {
                let pl = al * (zl[i].re * cos(wl * Double(i)) - zl[i].im * sin(wl * Double(i)))
                let pr = ar * (zr[i].re * cos(wr * Double(i)) - zr[i].im * sin(wr * Double(i)))
                x[i] += Float((gl - 1) * pl + (gr - 1) * pr)
            }
        }
        base = x
    }

    /// Complex envelope at `hz` (three centred moving averages of `window` samples, about 40 Hz wide, no delay), normalised to unit mean
    /// magnitude, plus the mean amplitude.
    static func envelope(_ x: [Float], hz: Double, window: Int = 1200) -> ([Cx], Double) {
        let n = x.count
        var re = [Double](repeating: 0, count: n), im = [Double](repeating: 0, count: n)
        let w = 2 * Double.pi * hz / sr
        for i in 0..<n { re[i] = Double(x[i]) * cos(w * Double(i)); im[i] = -Double(x[i]) * sin(w * Double(i)) }
        func smooth(_ a: [Double]) -> [Double] {
            var cur = a
            for _ in 0..<3 {
                var prefix = [Double](repeating: 0, count: n + 1)
                for i in 0..<n { prefix[i + 1] = prefix[i] + cur[i] }
                var next = cur
                for i in 0..<n {
                    let lo = max(0, i - window / 2), hi = min(n, i + window / 2)
                    next[i] = (prefix[hi] - prefix[lo]) / Double(hi - lo)
                }
                cur = next
            }
            return cur
        }
        let sre = smooth(re), sim = smooth(im)
        var mean = 0.0
        for i in 0..<n { mean += (sre[i] * sre[i] + sim[i] * sim[i]).squareRoot() }
        mean /= Double(max(1, n))
        let u = (0..<n).map { Cx(re: sre[$0] / max(mean, 1e-20), im: sim[$0] / max(mean, 1e-20)) }
        return (u, 2 * mean)
    }

    /// Reflection strength so that a hand `referenceHeight` above the left speaker echoes `relativeDb` below the
    /// left pilot's direct path (literature: -30 to -45 dB).
    static func reflectivity(relativeDb: Double, referenceHeight: Double = 0.15) -> Double {
        let p = FieldGeometry.leftSpeaker + SIMD3(0, 0, referenceHeight)
        let d0 = FieldGeometry.dist(FieldGeometry.leftSpeaker, FieldGeometry.mic)
        let d1 = FieldGeometry.dist(p, FieldGeometry.leftSpeaker), d2 = FieldGeometry.dist(p, FieldGeometry.mic)
        return pow(10, relativeDb / 20) * d1 * d2 / d0
    }

    /// The recording from `offset` for `duration` seconds, with the echoes of a hand following `hand(t)` added.
    func render(offset: Double = 0, duration: Double, hand: ((Double) -> SIMD3<Double>)?, relativeDb: Double = -35) -> [Float] {
        let start = Int(offset * Self.sr)
        let n = min(Int(duration * Self.sr), base.count - start)
        var x = Array(base[start..<(start + n)])
        guard let hand else { return x }
        let r = Self.reflectivity(relativeDb: relativeDb)
        // Emitted level (in "amplitude at 1 m" units) from the left direct path; the same for both speakers.
        let emit = leftAmplitude * FieldGeometry.dist(FieldGeometry.leftSpeaker, FieldGeometry.mic)
        let emitR = emit * rightEmitRatio
        let wl = 2 * Double.pi * leftHz, wr = 2 * Double.pi * rightHz
        for i in 0..<n {
            let t = Double(i) / Self.sr
            let p = hand(t)
            let dm = FieldGeometry.dist(p, FieldGeometry.mic)
            let dl = FieldGeometry.dist(p, FieldGeometry.leftSpeaker), dr = FieldGeometry.dist(p, FieldGeometry.rightSpeaker)
            let tl = Double(start + i) / Self.sr - (dl + dm) / Self.c
            let tr = Double(start + i) / Self.sr - (dr + dm) / Self.c
            let ul = uL[start + i], ur = uR[start + i]
            // Re{u * e^{j w t'}}; u is the pilot's envelope (the phase of the emitted tone at the mic).
            let el = ul.re * cos(wl * tl) - ul.im * sin(wl * tl)
            let er = ur.re * cos(wr * tr) - ur.im * sin(wr * tr)
            x[i] += Float(emit * r / (dl * dm) * el + emitR * r / (dr * dm) * er)
        }
        return x
    }
}
