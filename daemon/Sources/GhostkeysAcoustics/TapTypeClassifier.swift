// Tap type from sound: fingertip vs knuckle vs nail. The IMU says *where* and *when*; the microphone says *what hit*.
import Accelerate
import Foundation

public enum TapType: String, Codable, CaseIterable, Sendable {
    case fingertip, knuckle, nail
}

/// Acoustic features of one 40 ms window that starts just before a tap's sound onset.
public struct TapFeatures: Codable, Equatable, Sendable {
    public static let melBandCount = 40
    /// Length of `vector`.
    public static let dimension = melBandCount + 7

    /// Log mel band energies, dB (40 bands, 60 Hz to 16 kHz).
    public var logMel: [Float]
    /// Mean-square level of the window, dB full scale.
    public var logEnergyDb: Float
    public var centroidHz: Float
    /// Frequency below which 85% of the energy lies.
    public var rolloffHz: Float
    /// Spectral shape change between consecutive 10 ms sub-frames (0 = identical shape, 2 = disjoint).
    public var flux: Float
    /// Zero crossings per second.
    public var zeroCrossingRate: Float
    /// Time from the loudest 1 ms block until the level has fallen 20 dB, milliseconds.
    public var decayMs: Float
    /// Energy above 4 kHz relative to energy below 1 kHz, dB.
    public var highLowRatioDb: Float

    /// Flat vector for k-NN. The mel part is mean-removed so it describes spectral *shape*; loudness has its own slot.
    public var vector: [Float] {
        let m = logMel.reduce(0, +) / Float(max(1, logMel.count))
        return logMel.map { $0 - m } + [logEnergyDb, centroidHz / 1000, rolloffHz / 1000, flux,
                                        zeroCrossingRate / 1000, decayMs, highLowRatioDb]
    }
}

/// Computes `TapFeatures`. Not thread safe (reuses scratch buffers); create one per thread.
public final class TapFeatureExtractor {
    public static let windowDuration = 0.040
    public let sampleRate: Double
    /// Samples per analysis window (1920 at 48 kHz).
    public let windowLength: Int
    private let fft: RealFFT
    private let subFFT: RealFFT
    private let subLength: Int
    private let taper: [Float]
    private let subWindow: [Float]
    private let mel: MelFilterbank
    private let freqs: [Float]
    private var frame: [Float]
    private var power: [Float]
    private var subPower: [Float]
    private var melOut: [Float]

    public init(sampleRate: Double = GhostkeysAcousticsInfo.sampleRate) {
        self.sampleRate = sampleRate
        windowLength = Int((Self.windowDuration * sampleRate).rounded())
        let n = DSPMath.nextPowerOfTwo(atLeast: windowLength)
        fft = RealFFT(size: n)
        subLength = Int((0.010 * sampleRate).rounded())
        subFFT = RealFFT(size: DSPMath.nextPowerOfTwo(atLeast: subLength))
        taper = DSPMath.tukey(windowLength, alpha: 0.1)
        subWindow = DSPMath.periodicHann(subLength)
        mel = MelFilterbank(bandCount: TapFeatures.melBandCount, fftSize: n, sampleRate: sampleRate,
                            minHz: 60, maxHz: min(16_000, sampleRate / 2 - 100))
        freqs = (0..<fft.bins).map { Float(Double($0) * sampleRate / Double(n)) }
        frame = [Float](repeating: 0, count: windowLength)
        power = [Float](repeating: 0, count: fft.bins)
        subPower = [Float](repeating: 0, count: subFFT.bins)
        melOut = [Float](repeating: 0, count: TapFeatures.melBandCount)
    }

    public func features(_ window: [Float]) -> TapFeatures {
        window.withUnsafeBufferPointer { features($0) }
    }

    /// `window` should start about 2 ms before the tap's sound onset (see `TapWindowAligner`). Shorter windows are
    /// zero-padded, longer ones truncated to `windowLength`.
    public func features(_ window: UnsafeBufferPointer<Float>) -> TapFeatures {
        let n = windowLength
        let sr = Float(sampleRate)
        frame.withUnsafeMutableBufferPointer { f in
            f.baseAddress!.update(repeating: 0, count: n)
            if let src = window.baseAddress { f.baseAddress!.update(from: src, count: min(n, window.count)) }
        }
        return frame.withUnsafeBufferPointer { fb -> TapFeatures in
            let x = fb.baseAddress!
            let logEnergy = DSPMath.db(DSPMath.meanSquare(x, n))

            // Spectrum of the whole window.
            taper.withUnsafeBufferPointer { w in
                power.withUnsafeMutableBufferPointer { p in fft.powerSpectrum(x, count: n, window: w.baseAddress!, into: p.baseAddress!) }
            }
            var logMel = [Float](repeating: 0, count: TapFeatures.melBandCount)
            var centroid: Float = 0, rolloff: Float = 0, hl: Float = 0
            power.withUnsafeBufferPointer { pb in
                let p = pb.baseAddress!
                melOut.withUnsafeMutableBufferPointer { m in mel.apply(p, into: m.baseAddress!) }
                for i in 0..<logMel.count { logMel[i] = DSPMath.db(melOut[i]) }
                let bins = fft.bins
                let total = DSPMath.sum(p + 1, bins - 1)
                if total > 1e-20 {
                    centroid = freqs.withUnsafeBufferPointer { DSPMath.dot(p + 1, $0.baseAddress! + 1, bins - 1) } / total
                    var acc: Float = 0
                    rolloff = freqs[bins - 1]
                    for k in 1..<bins {
                        acc += p[k]
                        if acc >= 0.85 * total { rolloff = freqs[k]; break }
                    }
                }
                let binHz = Float(sampleRate) / Float(fft.size)
                let k1k = Int(1000 / binHz), k4k = Int(4000 / binHz)
                let low = DSPMath.sum(p + 1, k1k)
                let high = DSPMath.sum(p + k4k, bins - k4k)
                hl = DSPMath.db(high) - DSPMath.db(low)
            }

            // Zero-crossing rate.
            var crossings = 0
            for i in 1..<n where (x[i - 1] >= 0) != (x[i] >= 0) { crossings += 1 }
            let zcr = Float(crossings) / Float(n - 1) * sr

            // Decay: 1 ms blocks.
            let block = max(1, Int(sampleRate / 1000))
            let nb = n / block
            var env = [Float](repeating: 0, count: nb)
            for b in 0..<nb { env[b] = DSPMath.db(DSPMath.meanSquare(x + b * block, block)) }
            var peak = 0
            for b in 1..<nb where env[b] > env[peak] { peak = b }
            var decay = Float(nb - peak)
            let target = env[peak] - 20
            for b in (peak + 1)..<max(peak + 1, nb) where env[b] < target {
                let prev = env[b - 1]
                let frac = prev > env[b] ? (prev - target) / (prev - env[b]) : 1
                decay = Float(b - 1 - peak) + frac
                break
            }

            // Flux between consecutive 10 ms sub-frames (normalized magnitude spectra).
            let subCount = n / subLength
            var previous: [Float]? = nil
            var fluxSum: Float = 0
            var fluxPairs = 0
            for s in 0..<subCount {
                subWindow.withUnsafeBufferPointer { w in
                    subPower.withUnsafeMutableBufferPointer { sp in
                        subFFT.powerSpectrum(x + s * subLength, count: subLength, window: w.baseAddress!, into: sp.baseAddress!)
                    }
                }
                var mag = subPower.map { $0.squareRoot() }
                let total = mag.reduce(0, +)
                guard total > 1e-12 else { previous = nil; continue }
                for i in mag.indices { mag[i] /= total }
                if let prev = previous {
                    var d: Float = 0
                    for i in mag.indices { d += abs(mag[i] - prev[i]) }
                    fluxSum += d
                    fluxPairs += 1
                }
                previous = mag
            }
            let flux = fluxPairs > 0 ? fluxSum / Float(fluxPairs) : 0

            return TapFeatures(logMel: logMel, logEnergyDb: logEnergy, centroidHz: centroid, rolloffHz: rolloff,
                               flux: flux, zeroCrossingRate: zcr, decayMs: decay * Float(block) / sr * 1000,
                               highLowRatioDb: hl)
        }
    }
}

/// Finds the sound onset of a tap near the time the IMU reported it, so every window starts at the same point of the
/// transient (the IMU and microphone clocks agree to a few ms, but the sound's own onset is sharper).
public enum TapWindowAligner {
    /// Samples kept before the detected onset.
    public static let preroll = 0.002

    /// Index of the sound onset inside `samples`, or nil if the region holds no clear transient.
    /// Finds the loudest 0.5 ms block, then walks back to the first block of the rise (10% of the peak energy).
    public static func onsetIndex(in samples: UnsafeBufferPointer<Float>, searchRange: Range<Int>, sampleRate: Double) -> Int? {
        guard let base = samples.baseAddress else { return nil }
        let block = max(1, Int(sampleRate * 0.0005))
        let lo = max(0, searchRange.lowerBound), hi = min(samples.count, searchRange.upperBound)
        let nb = (hi - lo) / block
        guard nb >= 2 else { return nil }
        var e = [Float](repeating: 0, count: nb)
        for b in 0..<nb { e[b] = DSPMath.meanSquare(base + lo + b * block, block) }
        var peak = 0
        for b in 1..<nb where e[b] > e[peak] { peak = b }
        let floor = DSPMath.median(e)
        guard e[peak] > 1e-12, e[peak] > floor * 8 else { return nil }
        var start = peak
        while start > 0 && e[start - 1] > 0.1 * e[peak] { start -= 1 }
        return lo + start * block
    }

    /// Returns the 40 ms window for a tap from a longer stretch of audio (`samples[0]` at `samplesTime`), searching
    /// +-`searchRadius` seconds around `expectedOnset`. Nil when no clear onset is found or the stretch is too short.
    public static func window(from samples: [Float], samplesTime: Double, expectedOnset: Double,
                              searchRadius: Double = 0.015, sampleRate: Double = GhostkeysAcousticsInfo.sampleRate) -> [Float]? {
        let length = Int((TapFeatureExtractor.windowDuration * sampleRate).rounded())
        let center = Int(((expectedOnset - samplesTime) * sampleRate).rounded())
        let radius = Int(searchRadius * sampleRate)
        let onset = samples.withUnsafeBufferPointer {
            onsetIndex(in: $0, searchRange: (center - radius)..<(center + radius), sampleRate: sampleRate)
        }
        guard let onset else { return nil }
        let start = onset - Int(preroll * sampleRate)
        guard start >= 0, start + length <= samples.count else { return nil }
        return Array(samples[start..<(start + length)])
    }
}

/// One labeled training example. Persist these (they are small) so the model can be retrained after a format change.
public struct LabeledTap: Codable, Equatable, Sendable {
    public var features: TapFeatures
    public var label: TapType
    public init(features: TapFeatures, label: TapType) {
        self.features = features
        self.label = label
    }
}

public struct TapClassification: Equatable, Sendable {
    public enum RejectReason: String, Codable, Sendable {
        /// Nothing in the training set looks like this sound.
        case unfamiliar
        /// The nearest examples disagree.
        case ambiguous
        /// No clear transient in the audio (tap too soft, or audio missing).
        case noOnset = "no_onset"
    }
    /// nil when rejected.
    public var type: TapType?
    /// Share of the distance-weighted k-NN vote the winner got (0...1).
    public var confidence: Double
    public var nearestDistance: Double
    public var votes: [TapType: Double]
    public var rejectReason: RejectReason?
}

public enum TapTypeClassifierError: Error, Equatable {
    case notEnoughExamples(needed: Int, got: Int)
}

/// k-nearest-neighbour classifier over z-scored `TapFeatures` vectors, with a reject option. Codable: save it as JSON
/// next to the zone model and load it at startup.
public struct TapTypeClassifier: Codable, Equatable, Sendable {
    public static let formatVersion = 1
    public var formatVersion: Int
    public var k: Int
    /// Reject when the nearest example is farther than this (in the transformed space).
    public var rejectDistance: Float
    /// Reject when the winner's vote share is below this.
    public var minAgreement: Float
    public var sampleRate: Double
    public var mean: [Float]
    public var scale: [Float]
    public var weights: [Float]
    public var labels: [TapType]
    /// Training vectors already z-scored and weighted.
    public var examples: [[Float]]

    public var classes: Set<TapType> { Set(labels) }

    /// Trains from labeled examples. Needs at least 3 examples per class used and `k` examples overall.
    /// `rejectScale` multiplies the 95th percentile of leave-one-out nearest-neighbour distances to set `rejectDistance`.
    public static func train(_ examples: [LabeledTap], k: Int = 5, minAgreement: Float = 0.6, rejectScale: Float = 2.0,
                             sampleRate: Double = GhostkeysAcousticsInfo.sampleRate) throws -> TapTypeClassifier {
        let counts = Dictionary(grouping: examples, by: \.label).mapValues(\.count)
        let smallest = counts.values.min() ?? 0
        guard !examples.isEmpty, smallest >= 3, examples.count >= max(k, 3) else {
            throw TapTypeClassifierError.notEnoughExamples(needed: max(3, k), got: smallest)
        }
        let raw = examples.map { $0.features.vector }
        let d = TapFeatures.dimension
        var mean = [Float](repeating: 0, count: d), scale = [Float](repeating: 0, count: d)
        for v in raw { for i in 0..<d { mean[i] += v[i] } }
        for i in 0..<d { mean[i] /= Float(raw.count) }
        for v in raw { for i in 0..<d { scale[i] += (v[i] - mean[i]) * (v[i] - mean[i]) } }
        for i in 0..<d { scale[i] = max((scale[i] / Float(raw.count)).squareRoot(), 1e-2) }
        // The 40 mel dimensions together count as much as three scalar features.
        let melWeight = (Float(3) / Float(TapFeatures.melBandCount)).squareRoot()
        let weights = (0..<d).map { $0 < TapFeatures.melBandCount ? melWeight : Float(1) }

        var model = TapTypeClassifier(formatVersion: formatVersion, k: k, rejectDistance: .infinity, minAgreement: minAgreement,
                                      sampleRate: sampleRate, mean: mean, scale: scale, weights: weights,
                                      labels: examples.map(\.label), examples: [])
        model.examples = raw.map { model.transform($0) }

        // Leave-one-out nearest-neighbour distances set the "unfamiliar" threshold.
        var nn: [Float] = []
        for i in model.examples.indices {
            var best = Float.infinity
            for j in model.examples.indices where j != i { best = min(best, distance(model.examples[i], model.examples[j])) }
            nn.append(best)
        }
        nn.sort()
        let q = nn[min(nn.count - 1, Int(0.95 * Float(nn.count - 1)))]
        model.rejectDistance = max(q * rejectScale, 1e-3)
        return model
    }

    func transform(_ v: [Float]) -> [Float] {
        var out = [Float](repeating: 0, count: v.count)
        for i in 0..<min(v.count, mean.count) { out[i] = (v[i] - mean[i]) / scale[i] * weights[i] }
        return out
    }

    static func distance(_ a: [Float], _ b: [Float]) -> Float {
        var s: Float = 0
        a.withUnsafeBufferPointer { ap in b.withUnsafeBufferPointer { bp in
            vDSP_distancesq(ap.baseAddress!, 1, bp.baseAddress!, 1, &s, vDSP_Length(min(a.count, b.count)))
        } }
        return s.squareRoot()
    }

    public func classify(_ features: TapFeatures) -> TapClassification {
        let v = transform(features.vector)
        guard v.allSatisfy({ $0.isFinite }) else {
            return TapClassification(type: nil, confidence: 0, nearestDistance: .infinity, votes: [:], rejectReason: .unfamiliar)
        }
        return classify(transformed: v, excluding: nil)
    }

    private func classify(transformed v: [Float], excluding: Int?) -> TapClassification {
        var dists: [(Float, Int)] = []
        dists.reserveCapacity(examples.count)
        for (i, e) in examples.enumerated() where i != excluding { dists.append((Self.distance(v, e), i)) }
        dists.sort { $0.0 < $1.0 }
        var votes: [TapType: Double] = [:]
        for (d, i) in dists.prefix(k) { votes[labels[i], default: 0] += 1 / (Double(d) + 1e-3) }
        let total = votes.values.reduce(0, +)
        let (winner, weight) = votes.max { $0.value < $1.value } ?? (.fingertip, 0)
        let confidence = total > 0 ? weight / total : 0
        let nearest = Double(dists.first?.0 ?? .infinity)
        var result = TapClassification(type: winner, confidence: confidence, nearestDistance: nearest,
                                       votes: votes.mapValues { total > 0 ? $0 / total : 0 }, rejectReason: nil)
        if nearest > Double(rejectDistance) {
            result.type = nil
            result.rejectReason = .unfamiliar
        } else if confidence < Double(minAgreement) {
            result.type = nil
            result.rejectReason = .ambiguous
        }
        return result
    }

    /// Leave-one-out accuracy on the training set (rejections count as wrong). Handy for the calibration report.
    public func leaveOneOutAccuracy() -> Double {
        guard !examples.isEmpty else { return 0 }
        var correct = 0
        for i in examples.indices where classify(transformed: examples[i], excluding: i).type == labels[i] { correct += 1 }
        return Double(correct) / Double(examples.count)
    }
}
