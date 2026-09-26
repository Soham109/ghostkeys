// Inaudible sonar hand-wave detection, after SoundWave (Gupta, Morris, Patel, Tan; CHI 2012).
// The speaker plays a steady ~20 kHz pilot tone; a moving hand reflects it Doppler-shifted, which widens the pilot's
// peak in the microphone spectrum: to the right (higher) when the hand approaches, to the left when it recedes.
import Accelerate
import CoreAudio
import Foundation

public struct SonarConfig: Codable, Equatable, Sendable {
    public var sampleRate: Double = GhostkeysAcousticsInfo.sampleRate
    public var fftSize: Int = 4096
    public var hopSize: Int = 1024
    /// Pilot frequency. The default sits exactly on an FFT bin near 20 kHz so the pilot does not leak into
    /// neighbouring bins (a Hann window then spreads it over only +-1 bin).
    public var pilotHz: Double = SonarConfig.defaultPilotHz
    /// How far from the expected bin to look for the pilot's actual peak.
    public var pilotSearchBins: Int = 4
    /// Farthest bin from the pilot that counts as part of the widened peak (40 bins = 470 Hz = 4 m/s).
    public var maxScanBins: Int = 40
    /// A bin is part of the peak when within this many dB of the pilot's level...
    public var thresholdBelowPeakDb: Double = 35
    /// ...and at least this far above the local noise floor.
    public var noiseMarginDb: Double = 8
    /// Below-threshold bins tolerated inside the widened region while scanning outward.
    public var maxGapBins: Int = 2
    /// Pilot must stand this far above the noise floor, or detection pauses (speaker off, muted, blocked).
    public var minPilotSnrDb: Double = 25
    /// Widening beyond the resting width, in bins, that counts as motion on that side.
    public var minShiftBins: Double = 3
    /// Frames with motion needed on the winning side (each hop is 21 ms).
    public var minActiveFrames: Int = 2
    /// Quiet frames that end a motion episode.
    public var releaseFrames: Int = 5
    /// Episodes longer than this are ambient movement, not a gesture, and are discarded.
    public var maxEpisodeDuration: Double = 1.5
    /// Dead time after an emitted wave (debounce).
    public var refractory: Double = 0.4
    /// A sweep needs the weaker side to reach this share of the stronger side's total shift.
    public var sweepBalance: Double = 0.35
    /// Bins at this distance range from the pilot (both sides) estimate the noise floor.
    public var noiseReferenceBins: ClosedRange<Int> = 60...100

    public static let defaultPilotHz: Double = binAlignedFrequency(near: 20_000, fftSize: 4096, sampleRate: 48_000)

    public static func binAlignedFrequency(near hz: Double, fftSize: Int, sampleRate: Double) -> Double {
        let binHz = sampleRate / Double(fftSize)
        return (hz / binHz).rounded() * binHz
    }

    public var binHz: Double { sampleRate / Double(fftSize) }

    public init() {}
}

public enum SonarWaveKind: String, Codable, Sendable {
    case toward, away, sweep

    public var gesture: AcousticGestureKind {
        switch self {
        case .toward: return .waveToward
        case .away: return .waveAway
        case .sweep: return .waveSweep
        }
    }
}

public struct SonarWaveEvent: Codable, Equatable, Sendable {
    public var kind: SonarWaveKind
    /// Time of the last frame with motion.
    public var time: Double
    public var startTime: Double
    public var confidence: Double
    /// Largest widening seen, Hz.
    public var peakShiftHz: Double
    /// Hand speed implied by the peak shift: shift x c / (2 f0), meters per second.
    public var estimatedSpeed: Double
}

/// Per-frame diagnostics (latest frame only).
public struct SonarFrameInfo: Equatable, Sendable {
    public var time: Double
    public var pilotPresent: Bool
    public var pilotDb: Float
    public var noiseDb: Float
    public var leftBins: Int
    public var rightBins: Int
    public var leftShift: Double
    public var rightShift: Double
}


/// Doppler band analysis of one pilot tone, given a power spectrum. Shared by `SonarWaveDetector` (one pilot) and
/// `SonarField` (one tracker per speaker).
final class DopplerBandTracker {
    let config: SonarConfig
    private(set) var lastFrame: SonarFrameInfo?
    private let expectedBin: Int
    private var baseLeft: Double?
    private var baseRight: Double?
    private var episode: Episode?
    private var refractoryUntil = -Double.infinity

    private struct Episode {
        var start: Double
        var lastActive: Double
        var framesLeft = 0, framesRight = 0
        var sumLeft = 0.0, sumRight = 0.0
        var maxShift = 0.0
        var quietFrames = 0
    }

    init(config: SonarConfig) {
        self.config = config
        expectedBin = Int((config.pilotHz / config.binHz).rounded())
        precondition(expectedBin + config.noiseReferenceBins.upperBound < config.fftSize / 2,
                     "pilot too close to Nyquist for the noise reference")
    }

    func reset() {
        baseLeft = nil; baseRight = nil
        episode = nil
        refractoryUntil = -.infinity
        lastFrame = nil
    }

    /// `p` holds `fftSize / 2 + 1` power values.
    func analyze(_ p: UnsafePointer<Float>, time t: Double) -> SonarWaveEvent? {
        let bins = config.fftSize / 2 + 1
        let search = config.pilotSearchBins, maxScan = config.maxScanBins, maxGap = config.maxGapBins
        let ref = config.noiseReferenceBins
        var peakBin = expectedBin
        var k0 = expectedBin - search
        while k0 <= expectedBin + search { if p[k0] > p[peakBin] { peakBin = k0 }; k0 += 1 }
        let peakDb = DSPMath.db(p[peakBin])
        // Median in the linear domain (monotonic, so the same bin), converted once.
        var noise: [Float] = []
        noise.reserveCapacity(2 * ref.count)
        var d0 = ref.lowerBound
        while d0 <= ref.upperBound {
            if peakBin + d0 < bins { noise.append(p[peakBin + d0]) }
            if peakBin - d0 >= 1 { noise.append(p[peakBin - d0]) }
            d0 += 1
        }
        let noiseDb = DSPMath.db(DSPMath.median(noise))
        let present = Double(peakDb - noiseDb) >= config.minPilotSnrDb
        var info = SonarFrameInfo(time: t, pilotPresent: present, pilotDb: peakDb, noiseDb: noiseDb,
                                  leftBins: 0, rightBins: 0, leftShift: 0, rightShift: 0)
        guard present else {
            lastFrame = info
            episode = nil // no pilot, no evidence either way
            return nil
        }
        let thresholdDb = max(Double(peakDb) - config.thresholdBelowPeakDb, Double(noiseDb) + config.noiseMarginDb)
        let threshold = Float(pow(10, thresholdDb / 10))
        func scan(_ direction: Int) -> Int {
            var last = 0, gap = 0
            var d = 1
            while d <= maxScan {
                let k = peakBin + direction * d
                guard k >= 1 && k < bins else { break }
                if p[k] > threshold { last = d; gap = 0 } else { gap += 1; if gap > maxGap { break } }
                d += 1
            }
            return last
        }
        let left = scan(-1), right = scan(1)
        let baseL = baseLeft ?? Double(left), baseR = baseRight ?? Double(right)
        let shiftL = Double(left) - baseL, shiftR = Double(right) - baseR
        info.leftBins = left; info.rightBins = right; info.leftShift = shiftL; info.rightShift = shiftR
        lastFrame = info

        let activeL = shiftL >= config.minShiftBins, activeR = shiftR >= config.minShiftBins
        let active = activeL || activeR
        if !active && episode == nil {
            // Resting width adapts slowly (room reflections, speaker level changes).
            baseLeft = baseLeft.map { 0.95 * $0 + 0.05 * Double(left) } ?? Double(left)
            baseRight = baseRight.map { 0.95 * $0 + 0.05 * Double(right) } ?? Double(right)
        }
        if episode == nil {
            guard active, t >= refractoryUntil else { return nil }
            episode = Episode(start: t, lastActive: t)
        }
        if activeL { episode!.framesLeft += 1; episode!.sumLeft += shiftL }
        if activeR { episode!.framesRight += 1; episode!.sumRight += shiftR }
        if active {
            episode!.lastActive = t
            episode!.quietFrames = 0
            episode!.maxShift = max(episode!.maxShift, max(shiftL, shiftR))
        } else {
            episode!.quietFrames += 1
        }
        var result: SonarWaveEvent?
        if t - episode!.start > config.maxEpisodeDuration {
            episode = nil
            refractoryUntil = t + config.refractory
        } else if episode!.quietFrames >= config.releaseFrames {
            result = classify(episode!)
            if result != nil { refractoryUntil = t + config.refractory }
            episode = nil
        }
        return result
    }

    private func classify(_ e: Episode) -> SonarWaveEvent? {
        guard max(e.framesLeft, e.framesRight) >= config.minActiveFrames else { return nil }
        let strong = max(e.sumLeft, e.sumRight), weak = min(e.sumLeft, e.sumRight)
        let balance = strong > 0 ? weak / strong : 0
        let strength = min(1, e.maxShift / (2 * config.minShiftBins))
        let kind: SonarWaveKind
        let confidence: Double
        if e.framesLeft >= config.minActiveFrames && e.framesRight >= config.minActiveFrames && balance >= config.sweepBalance {
            kind = .sweep
            confidence = strength * min(1, 0.5 + balance)
        } else {
            kind = e.sumRight >= e.sumLeft ? .toward : .away
            confidence = strength * (strong / (e.sumLeft + e.sumRight))
        }
        let shiftHz = e.maxShift * config.binHz
        return SonarWaveEvent(kind: kind, time: e.lastActive, startTime: e.start, confidence: confidence,
                              peakShiftHz: shiftHz, estimatedSpeed: shiftHz * 343 / (2 * config.pilotHz))
    }
}

/// Streaming single-pilot Doppler detector. Feed microphone audio (mono, 48 kHz); not thread safe.
public final class SonarWaveDetector {
    public let config: SonarConfig
    public var lastFrame: SonarFrameInfo? { tracker.lastFrame }
    private let fft: RealFFT
    private let framer: SlidingFramer
    private let window: [Float]
    private var power: [Float]
    private let tracker: DopplerBandTracker
    private var expectedNextTime: Double?

    public init(config: SonarConfig = .init()) {
        precondition(config.fftSize & (config.fftSize - 1) == 0)
        self.config = config
        fft = RealFFT(size: config.fftSize)
        framer = SlidingFramer(frameSize: config.fftSize, hop: config.hopSize)
        window = DSPMath.periodicHann(config.fftSize)
        power = [Float](repeating: 0, count: fft.bins)
        tracker = DopplerBandTracker(config: config)
    }

    public func reset() {
        framer.reset()
        tracker.reset()
        expectedNextTime = nil
    }

    public func process(_ samples: [Float], time: Double) -> [SonarWaveEvent] {
        samples.withUnsafeBufferPointer { process($0, time: time) }
    }

    public func process(_ samples: UnsafeBufferPointer<Float>, time: Double) -> [SonarWaveEvent] {
        guard !samples.isEmpty else { return [] }
        if let expected = expectedNextTime, abs(expected - time) > 0.01 { reset() }
        expectedNextTime = time + Double(samples.count) / config.sampleRate
        var events: [SonarWaveEvent] = []
        let half = Double(config.fftSize) / 2 / config.sampleRate
        framer.push(samples, time: time, sampleRate: config.sampleRate) { frame, end in
            window.withUnsafeBufferPointer { w in
                power.withUnsafeMutableBufferPointer { p in
                    fft.powerSpectrum(frame, count: config.fftSize, window: w.baseAddress!, into: p.baseAddress!)
                    if let e = tracker.analyze(p.baseAddress!, time: end - half) { events.append(e) }
                }
            }
        }
        return events
    }
}
