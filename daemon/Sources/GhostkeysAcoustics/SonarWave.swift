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

/// Streaming Doppler detector. Feed microphone audio (mono, 48 kHz); not thread safe.
public final class SonarWaveDetector {
    public let config: SonarConfig
    public private(set) var lastFrame: SonarFrameInfo?
    private let fft: RealFFT
    private let framer: SlidingFramer
    private let window: [Float]
    private var power: [Float]
    private let expectedBin: Int
    private var baseLeft: Double?
    private var baseRight: Double?
    private var episode: Episode?
    private var refractoryUntil = -Double.infinity
    private var expectedNextTime: Double?

    private struct Episode {
        var start: Double
        var lastActive: Double
        var framesLeft = 0, framesRight = 0
        var sumLeft = 0.0, sumRight = 0.0
        var maxShift = 0.0
        var quietFrames = 0
    }

    public init(config: SonarConfig = .init()) {
        precondition(config.fftSize & (config.fftSize - 1) == 0)
        self.config = config
        fft = RealFFT(size: config.fftSize)
        framer = SlidingFramer(frameSize: config.fftSize, hop: config.hopSize)
        window = DSPMath.periodicHann(config.fftSize)
        power = [Float](repeating: 0, count: fft.bins)
        expectedBin = Int((config.pilotHz / config.binHz).rounded())
        precondition(expectedBin + config.noiseReferenceBins.upperBound < fft.bins, "pilot too close to Nyquist for the noise reference")
    }

    public func reset() {
        framer.reset()
        baseLeft = nil; baseRight = nil
        episode = nil
        refractoryUntil = -.infinity
        expectedNextTime = nil
        lastFrame = nil
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
            analyze(frame, center: end - half, events: &events)
        }
        return events
    }

    private func analyze(_ frame: UnsafePointer<Float>, center t: Double, events: inout [SonarWaveEvent]) {
        window.withUnsafeBufferPointer { w in
            power.withUnsafeMutableBufferPointer { p in fft.powerSpectrum(frame, count: config.fftSize, window: w.baseAddress!, into: p.baseAddress!) }
        }
        let p = power
        var peakBin = expectedBin
        for k in (expectedBin - config.pilotSearchBins)...(expectedBin + config.pilotSearchBins) where p[k] > p[peakBin] { peakBin = k }
        let peakDb = DSPMath.db(p[peakBin])
        var noise: [Float] = []
        for d in config.noiseReferenceBins {
            noise.append(DSPMath.db(p[peakBin + d]))
            if peakBin - d >= 1 { noise.append(DSPMath.db(p[peakBin - d])) }
        }
        let noiseDb = DSPMath.median(noise)
        let present = Double(peakDb - noiseDb) >= config.minPilotSnrDb
        var info = SonarFrameInfo(time: t, pilotPresent: present, pilotDb: peakDb, noiseDb: noiseDb,
                                  leftBins: 0, rightBins: 0, leftShift: 0, rightShift: 0)
        guard present else {
            lastFrame = info
            episode = nil // no pilot, no evidence either way
            return
        }
        let thresholdDb = max(Double(peakDb) - config.thresholdBelowPeakDb, Double(noiseDb) + config.noiseMarginDb)
        let threshold = Float(pow(10, thresholdDb / 10))
        func scan(_ direction: Int) -> Int {
            var last = 0, gap = 0
            for d in 1...config.maxScanBins {
                let k = peakBin + direction * d
                guard k >= 1 && k < fft.bins else { break }
                if p[k] > threshold { last = d; gap = 0 } else { gap += 1; if gap > config.maxGapBins { break } }
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
            guard active, t >= refractoryUntil else { return }
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
        if t - episode!.start > config.maxEpisodeDuration {
            episode = nil
            refractoryUntil = t + config.refractory
        } else if episode!.quietFrames >= config.releaseFrames {
            if let e = classify(episode!) { events.append(e); refractoryUntil = t + config.refractory }
            episode = nil
        }
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

// MARK: - Pilot tone and speaker safety

/// Where the system's default audio output currently goes.
public enum OutputRoute: Equatable, Sendable {
    /// The laptop's own speakers: the only route the pilot tone may play on.
    case builtInSpeaker
    /// Wired headphones (built-in jack). Never play: 20 kHz at the ear is the thing to avoid.
    case headphones
    /// Bluetooth, USB, HDMI, AirPlay, aggregate devices... The transport is a CoreAudio four-char code.
    case external(transport: String)
    /// Could not be determined. Treated like headphones.
    case unknown

    public var allowsPilotTone: Bool { self == .builtInSpeaker }

    /// Reads the default output device's transport type and data source from CoreAudio.
    /// Built-in speakers report transport `bltn` and data source `ispk`; the headphone jack reports `hdpn`.
    /// Reading these properties plays nothing and needs no permission.
    public static func current() -> OutputRoute {
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return .unknown }
        var transport: UInt32 = 0
        size = 4
        address.mSelector = kAudioDevicePropertyTransportType
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &transport) == noErr else { return .unknown }
        guard transport == kAudioDeviceTransportTypeBuiltIn else { return .external(transport: fourCC(transport)) }
        var source: UInt32 = 0
        size = 4
        address.mSelector = kAudioDevicePropertyDataSource
        address.mScope = kAudioDevicePropertyScopeOutput
        guard AudioObjectHasProperty(device, &address),
              AudioObjectGetPropertyData(device, &address, 0, nil, &size, &source) == noErr else { return .unknown }
        switch fourCC(source) {
        case "ispk": return .builtInSpeaker
        case "hdpn": return .headphones
        default: return .unknown
        }
    }

    static func fourCC(_ v: UInt32) -> String {
        let bytes = [UInt8(v >> 24 & 0xFF), UInt8(v >> 16 & 0xFF), UInt8(v >> 8 & 0xFF), UInt8(v & 0xFF)]
        return String(bytes: bytes, encoding: .ascii) ?? String(v)
    }
}

public enum PilotToneError: Error, Equatable {
    /// Output is not the built-in speaker (headphones, Bluetooth, unknown...).
    case routeNotAllowed(OutputRoute)
    /// A new session was requested before the cooldown ended.
    case coolingDown(secondsLeft: Double)
}

/// Generates the continuous ~20 kHz pilot tone for `SonarWaveDetector`. It only renders samples; whoever owns the
/// audio engine decides when to play them (see `AcousticSession.startPilotTone`).
///
/// Hard safety limits, not overridable:
/// - amplitude never above -30 dBFS (`maxAmplitude`), whatever is requested;
/// - 20 ms fade in and out, so starting and stopping never clicks;
/// - a session stops by itself after 60 s of rendered audio unless `renew()` is called;
/// - a new session cannot start until 10 s after the previous one stopped;
/// - `start()` refuses unless the default output is the built-in speaker (headphones or unknown: refused).
///
/// `render` is safe to call from the real-time audio thread (no locks, no allocation). Control calls come from another
/// thread; the shared state is single machine words, and the worst race is one render quantum of lag.
public final class PilotToneGenerator: @unchecked Sendable {
    /// -30 dBFS.
    public static let maxAmplitude: Float = 0.031_622_777
    public static let fadeDuration: Double = 0.020
    public static let maxSessionDuration: Double = 60
    public static let cooldown: Double = 10

    public enum State: Equatable, Sendable { case idle, playing, fadingOut }

    public let frequency: Double
    public let sampleRate: Double
    /// Effective amplitude after the cap.
    public let amplitude: Float
    public private(set) var state: State = .idle
    /// Why the last session ended on its own (nil if stopped by the caller).
    public private(set) var autoStopped = false

    private let routeCheck: () -> OutputRoute
    private let clock: () -> Double
    private var phase: Double = 0
    private var gain: Float = 0
    private var targetGain: Float = 0
    private let gainStep: Float
    private var sessionSamples = 0
    private var renewedAtSample = 0
    private let sessionLimitSamples: Int
    private var stoppedAt: Double?

    /// - Parameters:
    ///   - amplitude: requested linear amplitude; silently capped at `maxAmplitude`.
    ///   - routeCheck: injectable for tests; defaults to reading CoreAudio.
    ///   - clock: seconds, monotonic; injectable for tests.
    public init(frequency: Double = SonarConfig.defaultPilotHz, sampleRate: Double = GhostkeysAcousticsInfo.sampleRate,
                amplitude: Float = PilotToneGenerator.maxAmplitude,
                routeCheck: @escaping () -> OutputRoute = OutputRoute.current,
                clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.frequency = frequency
        self.sampleRate = sampleRate
        self.amplitude = min(max(0, amplitude.isFinite ? amplitude : 0), Self.maxAmplitude)
        self.routeCheck = routeCheck
        self.clock = clock
        gainStep = 1 / Float(max(1, Self.fadeDuration * sampleRate))
        sessionLimitSamples = Int(Self.maxSessionDuration * sampleRate)
    }

    /// Seconds until a new session may start (0 when allowed).
    public var cooldownRemaining: Double {
        guard let stoppedAt else { return 0 }
        return max(0, stoppedAt + Self.fadeDuration + Self.cooldown - clock())
    }

    /// Starts a session (fades in). Throws if the output route is not the built-in speaker or during cooldown.
    /// Calling it while already playing just renews the session.
    public func start() throws {
        let route = routeCheck()
        guard route.allowsPilotTone else { throw PilotToneError.routeNotAllowed(route) }
        if state == .playing { renew(); return }
        let left = cooldownRemaining
        guard left <= 0 else { throw PilotToneError.coolingDown(secondsLeft: left) }
        sessionSamples = 0
        renewedAtSample = 0
        autoStopped = false
        targetGain = 1
        state = .playing
    }

    /// Extends the running session by another 60 s from now. Re-checks the route; stops if it is no longer allowed.
    @discardableResult
    public func renew() -> Bool {
        guard state == .playing else { return false }
        guard routeCheck().allowsPilotTone else { stop(); return false }
        renewedAtSample = sessionSamples
        return true
    }

    /// Fades out (20 ms) and starts the cooldown.
    public func stop() {
        guard state == .playing else { return }
        targetGain = 0
        state = .fadingOut
        stoppedAt = clock()
    }

    /// Stops immediately without a fade (use only when the device is going away, for example a route change).
    public func stopImmediately() {
        if state == .playing { stoppedAt = clock() }
        targetGain = 0
        gain = 0
        state = .idle
    }

    public func render(count: Int) -> [Float] {
        var out = [Float](repeating: 0, count: count)
        out.withUnsafeMutableBufferPointer { render(into: $0.baseAddress!, count: count) }
        return out
    }

    /// Writes `count` samples. Silence when idle.
    public func render(into out: UnsafeMutablePointer<Float>, count: Int) {
        if state == .idle { out.update(repeating: 0, count: count); return }
        let increment = 2 * Double.pi * frequency / sampleRate
        for i in 0..<count {
            if state == .playing && sessionSamples - renewedAtSample >= sessionLimitSamples {
                autoStopped = true
                targetGain = 0
                state = .fadingOut
                stoppedAt = clock()
            }
            if gain < targetGain { gain = min(targetGain, gain + gainStep) } else if gain > targetGain { gain = max(targetGain, gain - gainStep) }
            out[i] = amplitude * gain * Float(sin(phase))
            phase += increment
            if phase > 2 * Double.pi { phase -= 2 * Double.pi }
            sessionSamples += 1
            if state == .fadingOut && gain == 0 {
                state = .idle
                if i + 1 < count { (out + i + 1).update(repeating: 0, count: count - i - 1) }
                return
            }
        }
    }
}
