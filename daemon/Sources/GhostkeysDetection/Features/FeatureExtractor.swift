// Tap feature vector.
//
// Window: 20 ms before the onset to 80 ms after it (16 + 64 samples at 797 Hz). Gravity and gyro bias
// are removed with the mean of the 100 ms that precede the window (the "pre-window").
//
// Why these features (physics):
// - Where a finger lands decides the direction of the force (down on the palm rest, sideways on an
//   edge, into the lid) and so the sign pattern of the first accel impulse.
// - A force off the centre of mass also rotates the machine a tiny bit. The torque is r x F, so a
//   downward tap left of centre twists one way about the front-back axis and a tap right of centre
//   the other way. The first 30 ms of gyro, integrated, captures that twist. Dividing twist by
//   impulse cancels how hard the tap was and leaves a lever arm, i.e. a position estimate.
// - Different parts of the chassis ring at different frequencies and decay at different rates
//   (the grille is a thin perforated sheet, the palm rest is backed by the battery, the lid is a
//   long cantilever), so spectral shape and decay tell zones apart too.
// - Keystrokes are small, short, sharp spikes centred on the keyboard: low twist, high frequency,
//   short decay. The "none" class learns them.
//
// Feature index table (TapFeatures.values). Units: accel g, gyro deg/s, time ms, frequency Hz.
//
//   0  impulseX       signed accel impulse, onset-3 samples .. +15 ms (g*ms)
//   1  impulseY
//   2  impulseZ
//   3  peakAccelX     signed accel value with the largest magnitude in the window (mg)
//   4  peakAccelY
//   5  peakAccelZ
//   6  twistX         signed integrated gyro, onset-3 samples .. +30 ms (millidegrees)
//   7  twistY
//   8  twistZ
//   9  peakGyroX      signed gyro value with the largest magnitude in the window (deg/s)
//  10  peakGyroY
//  11  peakGyroZ
//  12  xHat           twistY / impulseZ, clamped to +-100 (lever arm along x, arbitrary units)
//  13  yHat           -twistX / impulseZ, clamped to +-100
//  14  energyRatioX   accel energy on x / total accel energy (0..1)
//  15  energyRatioY
//  16  energyRatioZ
//  17  gyroAccelRatio log10(gyro energy / accel energy), with small floors
//  18  band20to60     fraction of accel spectral energy in 20..60 Hz (64-point DFT from onset)
//  19  band60to120    fraction in 60..120 Hz
//  20  band120to250   fraction in 120..250 Hz
//  21  band250to400   fraction in 250..400 Hz
//  22  ringFrequency  dominant frequency 20..400 Hz, parabolic-interpolated (Hz)
//  23  decayTime      peak to the last sample whose magnitude is >= 25% of peak (ms)
//  24  riseTime       last sample before the peak below 10% of peak, to the peak (ms)
//  25  pulseWidth     time the detection level stayed above half the trigger threshold (ms)
//  26  strength       log10(peak accel magnitude in mg)
//  27  impulseDirX    impulse vector / its length (unit direction of the first hit)
//  28  impulseDirY
//  29  impulseDirZ
//  30  twistPerImpX   twist / |impulse| (millidegrees per g*ms): lever arm, independent of force
//  31  twistPerImpY
//  32  twistPerImpZ

import Foundation

public enum FeatureIndex: Int, CaseIterable, Sendable {
    case impulseX = 0, impulseY, impulseZ
    case peakAccelX, peakAccelY, peakAccelZ
    case twistX, twistY, twistZ
    case peakGyroX, peakGyroY, peakGyroZ
    case xHat, yHat
    case energyRatioX, energyRatioY, energyRatioZ
    case gyroAccelRatio
    case band20to60, band60to120, band120to250, band250to400
    case ringFrequency, decayTime, riseTime, pulseWidth, strength
    case impulseDirX, impulseDirY, impulseDirZ
    case twistPerImpX, twistPerImpY, twistPerImpZ
}

extension TapFeatures {
    /// Length of `values`.
    public static let count = FeatureIndex.allCases.count
    /// Human readable name of each index, for logs and debugging.
    public static let names: [String] = FeatureIndex.allCases.map { "\($0)" }
    public subscript(_ i: FeatureIndex) -> Double { values[i.rawValue] }
}

struct FeatureExtractor {
    let sampleRate: Double
    let preSamples: Int        // 20 ms
    let postSamples: Int       // 80 ms (also the DFT length, 64 at 797 Hz)
    let baselineSamples: Int   // 100 ms
    let impulseSamples: Int    // 15 ms
    let twistSamples: Int      // 30 ms
    let leadIn = 3             // start integrals 3 samples before the threshold crossing
    private let dftN: Int
    private let cosTable: [Double]
    private let sinTable: [Double]

    init(sampleRate: Double = 797) {
        self.sampleRate = sampleRate
        preSamples = Int((0.020 * sampleRate).rounded())
        postSamples = Int((0.080 * sampleRate).rounded())
        baselineSamples = Int((0.100 * sampleRate).rounded())
        impulseSamples = Int((0.015 * sampleRate).rounded())
        twistSamples = Int((0.030 * sampleRate).rounded())
        dftN = postSamples
        var c = [Double](repeating: 0, count: dftN * dftN), s = c
        for k in 0..<dftN {
            for n in 0..<dftN {
                let ph = 2 * Double.pi * Double(k * n) / Double(dftN)
                c[k * dftN + n] = cos(ph); s[k * dftN + n] = sin(ph)
            }
        }
        cosTable = c; sinTable = s
    }

    /// Samples needed after the onset before `extract` can run.
    var samplesNeededAfterOnset: Int { postSamples }

    func extract(history h: SampleHistory, onset o: Int, pulseWidth: Double, t: Double) -> TapFeatures {
        let dtMs = 1000 / sampleRate
        let winStart = h.clamp(o - preSamples)
        let winEnd = h.clamp(o + postSamples - 1)
        let baseEnd = max(h.firstIndex, winStart - 1)
        let baseStart = h.clamp(winStart - baselineSamples)

        // Baselines: gravity for accel, bias for gyro.
        var ab = [0.0, 0.0, 0.0], gb = [0.0, 0.0, 0.0]
        let nb = Double(max(1, baseEnd - baseStart + 1))
        for i in baseStart...baseEnd {
            for k in 0..<3 { ab[k] += h.accel(i, k); gb[k] += h.gyro(i, k) }
        }
        for k in 0..<3 { ab[k] /= nb; gb[k] /= nb }

        // Window copies with baselines removed.
        let len = winEnd - winStart + 1
        var d = [[Double]](repeating: [Double](repeating: 0, count: len), count: 3)
        var w = d
        for j in 0..<len {
            let i = winStart + j
            for k in 0..<3 { d[k][j] = h.accel(i, k) - ab[k]; w[k][j] = h.gyro(i, k) - gb[k] }
        }
        let onsetJ = o - winStart
        let startJ = max(0, onsetJ - leadIn)

        var impulse = [0.0, 0.0, 0.0], twist = [0.0, 0.0, 0.0]
        var peakA = [0.0, 0.0, 0.0], peakG = [0.0, 0.0, 0.0]
        var energyA = [0.0, 0.0, 0.0], energyG = 0.0
        for k in 0..<3 {
            for j in startJ..<min(len, startJ + impulseSamples) { impulse[k] += d[k][j] * dtMs }
            for j in startJ..<min(len, startJ + twistSamples) { twist[k] += w[k][j] * dtMs }  // deg/s*ms = millideg
            for j in 0..<len {
                if abs(d[k][j]) > abs(peakA[k]) { peakA[k] = d[k][j] }
                if abs(w[k][j]) > abs(peakG[k]) { peakG[k] = w[k][j] }
            }
            for j in startJ..<len {
                energyA[k] += d[k][j] * d[k][j]
                energyG += w[k][j] * w[k][j]
            }
        }
        let totalA = energyA[0] + energyA[1] + energyA[2]

        // Lever-arm position estimates (see header). Guard the division for sideways hits.
        let eps = 1e-3
        let az = abs(impulse[2]) < eps ? (impulse[2] < 0 ? -eps : eps) : impulse[2]
        let xHat = Stats.clamp(twist[1] / az, -100, 100)
        let yHat = Stats.clamp(-twist[0] / az, -100, 100)

        // Spectrum: 64-point DFT per axis from the impulse start, summed over axes.
        var power = [Double](repeating: 0, count: dftN / 2 + 1)
        for k in 0..<3 {
            var x = [Double](repeating: 0, count: dftN)
            for n in 0..<dftN where startJ + n < len { x[n] = d[k][startJ + n] }
            for b in 1...(dftN / 2) {
                var re = 0.0, im = 0.0
                let row = b * dftN
                for n in 0..<dftN { re += x[n] * cosTable[row + n]; im -= x[n] * sinTable[row + n] }
                power[b] += re * re + im * im
            }
        }
        let binHz = sampleRate / Double(dftN)
        func bandEnergy(_ lo: Double, _ hi: Double) -> Double {
            var e = 0.0
            for b in 1..<power.count {
                let f = Double(b) * binHz
                if f >= lo && f < hi { e += power[b] }
            }
            return e
        }
        let bands = [bandEnergy(20, 60), bandEnergy(60, 120), bandEnergy(120, 250), bandEnergy(250, 400.1)]
        let bandTotal = max(bands.reduce(0, +), 1e-18)
        var peakBin = 2
        for b in 2..<power.count where power[b] > power[peakBin] { peakBin = b }
        var ringHz = Double(peakBin) * binHz
        if peakBin > 1 && peakBin < power.count - 1 {
            let l = power[peakBin - 1], c = power[peakBin], r = power[peakBin + 1]
            let den = l - 2 * c + r
            if abs(den) > 1e-30 { ringHz = (Double(peakBin) + Stats.clamp(0.5 * (l - r) / den, -0.5, 0.5)) * binHz }
        }

        // Envelope (magnitude) timing.
        var env = [Double](repeating: 0, count: len)
        var peakJ = 0
        for j in 0..<len {
            env[j] = (d[0][j] * d[0][j] + d[1][j] * d[1][j] + d[2][j] * d[2][j]).squareRoot()
            if env[j] > env[peakJ] { peakJ = j }
        }
        let peakMag = env[peakJ]
        var lastAbove = peakJ
        for j in peakJ..<len where env[j] >= 0.25 * peakMag { lastAbove = j }
        var riseStart = 0
        if peakJ > 0 {
            for j in stride(from: peakJ - 1, through: 0, by: -1) where env[j] < 0.1 * peakMag { riseStart = j; break }
        }

        let impLen = max((impulse[0] * impulse[0] + impulse[1] * impulse[1] + impulse[2] * impulse[2]).squareRoot(), 1e-6)

        var v = [Double](repeating: 0, count: TapFeatures.count)
        func set(_ i: FeatureIndex, _ x: Double) { v[i.rawValue] = x.isFinite ? x : 0 }
        set(.impulseX, impulse[0]); set(.impulseY, impulse[1]); set(.impulseZ, impulse[2])
        set(.peakAccelX, peakA[0] * 1000); set(.peakAccelY, peakA[1] * 1000); set(.peakAccelZ, peakA[2] * 1000)
        set(.twistX, twist[0]); set(.twistY, twist[1]); set(.twistZ, twist[2])
        set(.peakGyroX, peakG[0]); set(.peakGyroY, peakG[1]); set(.peakGyroZ, peakG[2])
        set(.xHat, xHat); set(.yHat, yHat)
        set(.energyRatioX, energyA[0] / max(totalA, 1e-18))
        set(.energyRatioY, energyA[1] / max(totalA, 1e-18))
        set(.energyRatioZ, energyA[2] / max(totalA, 1e-18))
        // Floors: ~1 mg accel and ~0.1 deg/s gyro per sample, so a quiet axis does not blow up the log.
        set(.gyroAccelRatio, log10((energyG + 0.01) / (totalA + 1e-6)))
        set(.band20to60, bands[0] / bandTotal); set(.band60to120, bands[1] / bandTotal)
        set(.band120to250, bands[2] / bandTotal); set(.band250to400, bands[3] / bandTotal)
        set(.ringFrequency, ringHz)
        set(.decayTime, Double(lastAbove - peakJ) * dtMs)
        set(.riseTime, Double(peakJ - riseStart) * dtMs)
        set(.pulseWidth, pulseWidth * 1000)
        set(.strength, log10(max(peakMag * 1000, 1e-3)))
        set(.impulseDirX, impulse[0] / impLen); set(.impulseDirY, impulse[1] / impLen); set(.impulseDirZ, impulse[2] / impLen)
        set(.twistPerImpX, twist[0] / impLen); set(.twistPerImpY, twist[1] / impLen); set(.twistPerImpZ, twist[2] / impLen)
        return TapFeatures(values: v, t: t)
    }
}
