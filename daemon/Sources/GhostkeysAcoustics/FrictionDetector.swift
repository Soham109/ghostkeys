// Rub and swipe detection from friction sound: broadband 2 to 12 kHz noise, sustained 150 ms to 2 s,
// not impulsive (typing), not harmonic (voice), not tonal (music).
import Accelerate
import Foundation

public enum RubDirection: String, Codable, Sendable {
    /// Getting louder: the finger is moving toward the microphones.
    case towardMics = "toward_mics"
    /// Getting quieter: moving away from the microphones.
    case awayFromMics = "away_from_mics"
    case unknown
}

/// Which side of the laptop the microphone array sits on, used to turn "toward the mics" into left or right.
/// MacBook Air and Pro put their mics near the top left of the keyboard deck, hence `.left` by default.
/// Verify per model before shipping `rub_left` / `rub_right` bindings.
public enum MicSide: String, Codable, Sendable { case left, right }

public enum RubCancelReason: String, Codable, Sendable {
    /// Lasted longer than `maxDuration` (a fan, a shower, a long scrape: not a gesture).
    case tooLong = "too_long"
    /// Too many frames inside the rub were not friction-like.
    case notSustained = "not_sustained"
    /// Level jumped around too much for a steady rub (bursts).
    case irregular
}

public struct FrictionDetectorConfig: Codable, Equatable, Sendable {
    public var bandLowHz: Double = 2_000
    public var bandHighHz: Double = 12_000
    public var minDuration: Double = 0.15
    public var maxDuration: Double = 2.0
    /// Frame RMS must be at least this loud, dB full scale.
    public var minLevelDbfs: Double = -65
    /// Band energy must be at least this far above the tracked background floor, dB.
    public var minSnrDb: Double = 10
    /// Share of 100 Hz to 18 kHz energy (the ultrasonic sonar pilot is excluded) that must fall inside the friction band.
    public var minBandFraction: Double = 0.5
    /// Autocorrelation pitch strength above which a frame is voice-like (0...1).
    public var maxHarmonicity: Double = 0.5
    /// Share of energy in strong narrow peaks (> 10x the band mean) above which a frame is tonal (music, beeps).
    public var maxTonalFraction: Double = 0.3
    /// Peak-to-mean ratio of 1 ms block energies above which a frame is impulsive (typing, taps).
    public var maxCrest: Double = 6
    /// Longest non-friction gap tolerated inside one rub, seconds.
    public var gapTolerance: Double = 0.06
    /// Share of frames inside the rub that must be friction-like.
    public var minRubFrameFraction: Double = 0.75
    /// Standard deviation of frame level around the linear trend above which the rub is `irregular`, dB.
    public var maxLevelJitterDb: Double = 6
    /// `rub_left` / `rub_right` only above this direction confidence; otherwise plain `rub`.
    public var directionConfidenceThreshold: Double = 0.7
    /// Loudness change over the rub that counts as a full-confidence direction cue, dB.
    public var directionFullChangeDb: Double = 6
    public var micSide: MicSide = .left
    /// Distance between speaker-grille holes, meters. Speed = comb frequency x hole pitch. Measure per model.
    public var grilleHolePitchMeters: Double = 0.0009
    public var combMinHz: Double = 40
    public var combMaxHz: Double = 1_000
    /// Minimum normalized envelope autocorrelation for a comb tone to be reported.
    public var combMinStrength: Double = 0.25
    /// Seconds at start (or after a reset) used only to learn the background floor.
    public var warmup: Double = 0.25

    public init() {}
}

/// Measurements of one accepted rub.
public struct RubSummary: Codable, Equatable, Sendable {
    public var startTime: Double
    public var endTime: Double
    public var duration: Double
    /// Mean band level above the background floor, dB.
    public var snrDb: Double
    /// Mean spectral centroid within 2 to 12 kHz.
    public var centroidHz: Double
    /// 0...1, uncalibrated: faster rubs are brighter. `(centroid - 3 kHz) / 4 kHz`, clamped.
    public var speedProxy: Double
    /// Periodic comb tone found in the envelope (speaker grille), Hz.
    public var combHz: Double?
    public var combStrength: Double
    /// combHz x grille hole pitch, when a comb tone was found.
    public var speedMetersPerSecond: Double?
    public var direction: RubDirection
    public var directionConfidence: Double
    public var trendDbPerSecond: Double
    public var rubFrameFraction: Double
}

public enum FrictionEvent: Equatable, Sendable {
    case started(time: Double)
    case ended(RubSummary)
    case cancelled(time: Double, reason: RubCancelReason)
}

/// Per-frame diagnostics (latest frame only), for the visualizer and for tuning.
public struct FrictionFrameInfo: Equatable, Sendable {
    public var time: Double
    public var levelDbfs: Float
    public var bandDb: Float
    public var floorDb: Float
    public var bandFraction: Float
    public var crest: Float
    public var tonalFraction: Float
    public var harmonicity: Float
    public var centroidHz: Float
    public var isFriction: Bool
    /// Why the frame was not friction: quiet, below_floor, not_band, impulsive, tonal, harmonic, warmup.
    public var rejectReason: String?
}

/// Streaming rub detector. Feed mono audio in any chunk size; not thread safe.
public final class FrictionDetector {
    public let config: FrictionDetectorConfig
    public let sampleRate: Double
    public private(set) var lastFrame: FrictionFrameInfo?
    public var isRubbing: Bool { segment?.startedEmitted == true }

    let frameSize: Int
    let hopSize: Int
    private let hopSeconds: Double
    private let fft: RealFFT
    private let framer: SlidingFramer
    private let window: [Float]
    private let windowAutocorr: [Float]
    private let freqs: [Float]
    private let kLo: Int, kHi: Int, k100: Int, k150: Int, k20k: Int
    private let minLag: Int, maxLag: Int
    private var power: [Float]
    private var scratch: [Float]
    private var acf: [Float]

    // Envelope for the comb tone: high-passed signal, squared, averaged over 12-sample blocks (4 kHz at 48 kHz).
    private let envBlock: Int
    let envelopeRate: Double
    private let highpass: BiquadFilter
    private var hpScratch: [Float] = []
    private var envTmp: [Float] = []
    private let envOnes: [Float]
    private var envAcc: Float = 0
    private var envAccCount = 0
    private var envelope: [Float] = []
    private var envelopeStart: Double = 0
    private var expectedNextTime: Double?

    private var floorDb: Float?
    private var firstFrameTime: Double?
    private var segment: Segment?
    private var suppressed = false
    private var lastFrictionTime: Double = -.infinity

    private struct Segment {
        var start: Double
        var lastFriction: Double
        var frames = 0
        var frictionFrames = 0
        var framesUpToLastFriction = 0
        var times: [Double] = []
        var bandDb: [Double] = []
        var snr: [Double] = []
        var centroid: [Double] = []
        var startedEmitted = false
    }

    public init(config: FrictionDetectorConfig = .init(), sampleRate: Double = GhostkeysAcousticsInfo.sampleRate) {
        self.config = config
        self.sampleRate = sampleRate
        frameSize = DSPMath.nextPowerOfTwo(atLeast: Int(0.04 * sampleRate))
        hopSize = Int((0.02 * sampleRate).rounded())
        hopSeconds = Double(hopSize) / sampleRate
        fft = RealFFT(size: frameSize * 2)
        framer = SlidingFramer(frameSize: frameSize, hop: hopSize)
        window = DSPMath.periodicHann(frameSize)
        let binHz = sampleRate / Double(fft.size)
        let lastBin = fft.bins - 1
        func bin(_ hz: Double) -> Int { min(lastBin, max(1, Int((hz / binHz).rounded()))) }
        kLo = bin(config.bandLowHz); kHi = bin(config.bandHighHz)
        k100 = bin(100); k150 = bin(150); k20k = bin(min(18_000, sampleRate / 2)) // stop below the sonar pilot
        minLag = Int(sampleRate / 500)
        maxLag = min(frameSize / 2, Int(sampleRate / 90))
        freqs = (0..<fft.bins).map { Float(Double($0) * binHz) }
        power = [Float](repeating: 0, count: fft.bins)
        scratch = [Float](repeating: 0, count: fft.bins)
        acf = [Float](repeating: 0, count: maxLag + 1)
        // Autocorrelation of the analysis window, to undo its taper when measuring pitch strength (Boersma 1993).
        var wacf = [Float](repeating: 0, count: maxLag + 1)
        let lags = maxLag + 1
        var wpow = [Float](repeating: 0, count: fft.bins)
        let f = fft, size = frameSize
        window.withUnsafeBufferPointer { w in
            wpow.withUnsafeMutableBufferPointer { p in
                f.powerSpectrum(w.baseAddress!, count: size, window: nil, into: p.baseAddress!)
                wacf.withUnsafeMutableBufferPointer { a in f.inverseEvenSpectrum(p.baseAddress!, into: a.baseAddress!, count: lags) }
            }
        }
        let w0 = wacf[0]
        windowAutocorr = wacf.map { max($0 / w0, 1e-3) }

        envBlock = max(1, Int(sampleRate / 4_000))
        envelopeRate = sampleRate / Double(envBlock)
        highpass = BiquadFilter(coefficients: BiquadFilter.highpass(cutoff: 1_500, sampleRate: sampleRate)
                                + BiquadFilter.highpass(cutoff: 1_500, sampleRate: sampleRate))
        envOnes = [Float](repeating: 1 / Float(envBlock), count: envBlock)
    }

    public func reset() {
        framer.reset()
        highpass.reset()
        envAcc = 0; envAccCount = 0
        envelope.removeAll(keepingCapacity: true)
        expectedNextTime = nil
        floorDb = nil
        firstFrameTime = nil
        segment = nil
        suppressed = false
        lastFrictionTime = -.infinity
        lastFrame = nil
    }

    public func process(_ samples: [Float], time: Double) -> [FrictionEvent] {
        samples.withUnsafeBufferPointer { process($0, time: time) }
    }

    /// Feeds mono samples whose first sample is at `time` (seconds). Returns events completed by this chunk.
    public func process(_ samples: UnsafeBufferPointer<Float>, time: Double) -> [FrictionEvent] {
        guard let x = samples.baseAddress, !samples.isEmpty else { return [] }
        var events: [FrictionEvent] = []
        if let expected = expectedNextTime, abs(expected - time) > 0.01 {
            // Discontinuity (session restarted): finish cleanly and start over.
            if let seg = segment, seg.startedEmitted { events.append(.cancelled(time: seg.lastFriction, reason: .notSustained)) }
            reset()
        }
        expectedNextTime = time + Double(samples.count) / sampleRate
        appendEnvelope(x, count: samples.count, time: time)
        let half = Double(frameSize) / 2 / sampleRate
        framer.push(samples, time: time, sampleRate: sampleRate) { frame, end in
            analyze(frame, center: end - half, events: &events)
        }
        if segment == nil { trimEnvelope(keep: Int(0.3 * envelopeRate)) }
        return events
    }

    // MARK: Envelope

    private func appendEnvelope(_ x: UnsafePointer<Float>, count n: Int, time: Double) {
        if hpScratch.count < n { hpScratch = [Float](repeating: 0, count: n); envTmp = [Float](repeating: 0, count: n / envBlock + 1) }
        if envelope.isEmpty && envAccCount == 0 { envelopeStart = time + Double(envBlock) / 2 / sampleRate }
        hpScratch.withUnsafeMutableBufferPointer { hp in
            let y = hp.baseAddress!
            highpass.process(x, y, count: n)
            vDSP_vsq(y, 1, y, 1, vDSP_Length(n))
            var i = 0
            while envAccCount > 0 && i < n {
                envAcc += y[i]; envAccCount += 1; i += 1
                if envAccCount == envBlock { envelope.append(envAcc / Float(envBlock)); envAcc = 0; envAccCount = 0 }
            }
            let full = (n - i) / envBlock
            if full > 0 {
                envTmp.withUnsafeMutableBufferPointer { t in
                    envOnes.withUnsafeBufferPointer { ones in
                        vDSP_desamp(y + i, vDSP_Stride(envBlock), ones.baseAddress!, t.baseAddress!, vDSP_Length(full), vDSP_Length(envBlock))
                    }
                    envelope.append(contentsOf: UnsafeBufferPointer(start: t.baseAddress!, count: full))
                }
                i += full * envBlock
            }
            while i < n { envAcc += y[i]; envAccCount += 1; i += 1 }
        }
    }

    private func trimEnvelope(keep: Int) {
        guard envelope.count > 2 * keep else { return }
        let drop = envelope.count - keep
        envelope.removeFirst(drop)
        envelopeStart += Double(drop) / envelopeRate
    }

    // MARK: Frames

    private func analyze(_ frame: UnsafePointer<Float>, center t: Double, events: inout [FrictionEvent]) {
        if firstFrameTime == nil { firstFrameTime = t }
        let level = DSPMath.db(DSPMath.meanSquare(frame, frameSize))
        window.withUnsafeBufferPointer { w in
            power.withUnsafeMutableBufferPointer { p in fft.powerSpectrum(frame, count: frameSize, window: w.baseAddress!, into: p.baseAddress!) }
        }
        var info = FrictionFrameInfo(time: t, levelDbfs: level, bandDb: 0, floorDb: 0, bandFraction: 0, crest: 0,
                                     tonalFraction: 0, harmonicity: 0, centroidHz: 0, isFriction: false, rejectReason: nil)
        power.withUnsafeBufferPointer { pb in
            let p = pb.baseAddress!
            let bandE = DSPMath.sum(p + kLo, kHi - kLo + 1)
            let totalE = DSPMath.sum(p + k100, k20k - k100 + 1)
            let bandDb = DSPMath.db(bandE)
            info.bandDb = bandDb
            info.bandFraction = totalE > 0 ? bandE / totalE : 0
            info.centroidHz = bandE > 0 ? freqs.withUnsafeBufferPointer { DSPMath.dot(p + kLo, $0.baseAddress! + kLo, kHi - kLo + 1) } / bandE : 0

            // Background floor: learned during warmup, then tracked outside rubs (falls fast, rises 3 dB/s).
            let warm = t - firstFrameTime! < config.warmup
            var floor = floorDb ?? bandDb
            if warm { floor = min(floor, bandDb) } else if segment == nil && !suppressed {
                floor += bandDb < floor ? 0.3 * (bandDb - floor) : min(bandDb - floor, Float(3 * hopSeconds))
            }
            floorDb = max(floor, -200)
            info.floorDb = floorDb!

            if warm { info.rejectReason = "warmup"; return }
            if Double(level) < config.minLevelDbfs { info.rejectReason = "quiet"; return }
            if Double(bandDb - floorDb!) < config.minSnrDb { info.rejectReason = "below_floor"; return }
            if Double(info.bandFraction) < config.minBandFraction { info.rejectReason = "not_band"; return }

            // Impulsiveness: 1 ms block energies.
            let block = max(1, Int(sampleRate / 1000))
            let nb = frameSize / block
            var maxE: Float = 0, sumE: Float = 0
            for b in 0..<nb {
                let e = DSPMath.meanSquare(frame + b * block, block)
                maxE = max(maxE, e); sumE += e
            }
            info.crest = sumE > 0 ? maxE / (sumE / Float(nb)) : 0
            if Double(info.crest) > config.maxCrest { info.rejectReason = "impulsive"; return }

            // Tonality: energy in bins more than 10x the mean of 150 Hz ... band top.
            let m = kHi - k150 + 1
            let sumT = DSPMath.sum(p + k150, m)
            var thr = 10 * sumT / Float(m)
            scratch.withUnsafeMutableBufferPointer { s in
                vDSP_vthres(p + k150, 1, &thr, s.baseAddress!, 1, vDSP_Length(m))
                info.tonalFraction = sumT > 0 ? DSPMath.sum(s.baseAddress!, m) / sumT : 0
            }
            if Double(info.tonalFraction) > config.maxTonalFraction { info.rejectReason = "tonal"; return }

            // Harmonicity: normalized autocorrelation peak over 90 to 500 Hz pitch lags, window-corrected.
            acf.withUnsafeMutableBufferPointer { a in fft.inverseEvenSpectrum(p, into: a.baseAddress!, count: maxLag + 1) }
            let r0 = acf[0]
            var best: Float = 0
            if r0 > 0 {
                for lag in minLag...maxLag { best = max(best, acf[lag] / r0 / windowAutocorr[lag]) }
            }
            info.harmonicity = min(best, 1)
            if Double(info.harmonicity) > config.maxHarmonicity { info.rejectReason = "harmonic"; return }
            info.isFriction = true
        }
        lastFrame = info
        step(info, events: &events)
    }

    private func step(_ info: FrictionFrameInfo, events: inout [FrictionEvent]) {
        let t = info.time
        if info.isFriction {
            lastFrictionTime = t
            if suppressed { return }
            if segment == nil { segment = Segment(start: t, lastFriction: t) }
            segment!.frames += 1
            segment!.frictionFrames += 1
            segment!.framesUpToLastFriction = segment!.frames
            segment!.lastFriction = t
            segment!.times.append(t)
            segment!.bandDb.append(Double(info.bandDb))
            segment!.snr.append(Double(info.bandDb - info.floorDb))
            segment!.centroid.append(Double(info.centroidHz))
            let duration = t - segment!.start + hopSeconds
            let fraction = Double(segment!.frictionFrames) / Double(segment!.frames)
            if !segment!.startedEmitted && duration >= config.minDuration && fraction >= config.minRubFrameFraction {
                segment!.startedEmitted = true
                events.append(.started(time: segment!.start))
            }
            if duration > config.maxDuration {
                if segment!.startedEmitted { events.append(.cancelled(time: t, reason: .tooLong)) }
                segment = nil
                suppressed = true
            }
        } else {
            if suppressed {
                if t - lastFrictionTime > config.gapTolerance { suppressed = false }
                return
            }
            guard segment != nil else { return }
            segment!.frames += 1
            if t - segment!.lastFriction > config.gapTolerance {
                finish(segment!, events: &events)
                segment = nil
            }
        }
    }

    private func finish(_ seg: Segment, events: inout [FrictionEvent]) {
        let duration = seg.lastFriction - seg.start + hopSeconds
        guard duration >= config.minDuration else { return }
        let fraction = Double(seg.frictionFrames) / Double(max(1, seg.framesUpToLastFriction))
        guard fraction >= config.minRubFrameFraction else {
            if seg.startedEmitted { events.append(.cancelled(time: seg.lastFriction, reason: .notSustained)) }
            return
        }

        // Loudness trend over the middle 80% of the rub (edges are the finger landing and lifting).
        let n = seg.times.count
        let trim = n >= 10 ? n / 10 : 0
        let xs = Array(seg.times[trim..<(n - trim)]), ys = Array(seg.bandDb[trim..<(n - trim)])
        let fit = DSPMath.linearFit(x: xs, y: ys)
        var jitter = 0.0
        for i in xs.indices { let r = ys[i] - (fit.intercept + fit.slope * xs[i]); jitter += r * r }
        jitter = (jitter / Double(max(1, xs.count))).squareRoot()
        guard jitter <= config.maxLevelJitterDb else {
            if seg.startedEmitted { events.append(.cancelled(time: seg.lastFriction, reason: .irregular)) }
            return
        }
        let change = fit.slope * ((xs.last ?? 0) - (xs.first ?? 0))
        let dirConfidence = xs.count >= 4 ? fit.r2 * min(1, abs(change) / config.directionFullChangeDb) : 0
        let direction: RubDirection = dirConfidence < 0.2 ? .unknown : (change > 0 ? .towardMics : .awayFromMics)

        let centroid = seg.centroid.reduce(0, +) / Double(max(1, seg.centroid.count))
        let half = Double(frameSize) / 2 / sampleRate
        let comb = combTone(from: seg.start - half, to: seg.lastFriction + half)
        let combHz = comb.flatMap { $0.strength >= config.combMinStrength ? $0.hz : nil }

        let summary = RubSummary(
            startTime: seg.start, endTime: seg.lastFriction + hopSeconds, duration: duration,
            snrDb: seg.snr.reduce(0, +) / Double(max(1, seg.snr.count)),
            centroidHz: centroid, speedProxy: min(1, max(0, (centroid - 3_000) / 4_000)),
            combHz: combHz, combStrength: comb?.strength ?? 0,
            speedMetersPerSecond: combHz.map { $0 * config.grilleHolePitchMeters },
            direction: direction, directionConfidence: dirConfidence, trendDbPerSecond: fit.slope,
            rubFrameFraction: fraction)
        if !seg.startedEmitted { events.append(.started(time: seg.start)) }
        events.append(.ended(summary))
    }

    private func combTone(from start: Double, to end: Double) -> (hz: Double, strength: Double)? {
        let i0 = max(0, Int((start - envelopeStart) * envelopeRate))
        let i1 = min(envelope.count, Int((end - envelopeStart) * envelopeRate))
        guard i1 - i0 > 16 else { return nil }
        return Self.estimateCombFrequency(envelope: Array(envelope[i0..<i1]), envelopeRate: envelopeRate,
                                          minHz: config.combMinHz, maxHz: config.combMaxHz)
    }

    /// Fundamental of a periodic envelope modulation (the comb tone a finger makes crossing grille holes), found as the
    /// first strong peak of the envelope's autocorrelation. The envelope is first divided by its 50 ms moving average so
    /// slow loudness changes do not dominate. Returns frequency and normalized autocorrelation strength (0...1).
    public static func estimateCombFrequency(envelope: [Float], envelopeRate: Double, minHz: Double, maxHz: Double) -> (hz: Double, strength: Double)? {
        let m = envelope.count
        let w = max(3, Int(0.05 * envelopeRate))
        let minLag = max(2, Int(floor(envelopeRate / maxHz)))
        let maxLag = min(m / 3, Int(ceil(envelopeRate / minHz)))
        guard m > 4 * minLag, maxLag > minLag + 2 else { return nil }
        // Normalize by the local mean (centered moving average via prefix sums).
        var prefix = [Double](repeating: 0, count: m + 1)
        for i in 0..<m { prefix[i + 1] = prefix[i] + Double(envelope[i]) }
        var y = [Float](repeating: 0, count: m)
        for i in 0..<m {
            let a = max(0, i - w / 2), b = min(m, i + w / 2 + 1)
            let local = (prefix[b] - prefix[a]) / Double(b - a)
            y[i] = local > 1e-20 ? Float(Double(envelope[i]) / local - 1) : 0
        }
        let r0 = y.withUnsafeBufferPointer { DSPMath.dot($0.baseAddress!, $0.baseAddress!, m) } / Float(m)
        guard r0 > 0 else { return nil }
        var r = [Float](repeating: 0, count: maxLag + 2)
        y.withUnsafeBufferPointer { yp in
            for lag in max(1, minLag - 1)...(maxLag + 1) where lag < m {
                r[lag] = DSPMath.dot(yp.baseAddress!, yp.baseAddress! + lag, m - lag) / Float(m - lag) / r0
            }
        }
        var peaks: [Int] = []
        for lag in minLag...maxLag where r[lag] > 0 && r[lag] > r[lag - 1] && r[lag] >= r[lag + 1] { peaks.append(lag) }
        guard let top = peaks.map({ r[$0] }).max() else { return nil }
        // Smallest lag that is nearly as strong as the best one (avoids picking a multiple of the period).
        guard let lag = peaks.first(where: { r[$0] >= 0.85 * top }) else { return nil }
        let a = r[lag - 1], b = r[lag], c = r[lag + 1]
        let denom = a - 2 * b + c
        let delta = denom != 0 ? max(-0.5, min(0.5, 0.5 * (a - c) / denom)) : 0
        return (envelopeRate / (Double(lag) + Double(delta)), Double(min(1, b)))
    }
}
