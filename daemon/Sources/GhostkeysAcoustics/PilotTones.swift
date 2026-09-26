// Inaudible pilot tones and the speaker-safety rules every tone goes through.
import CoreAudio
import Foundation

/// Where the system's default audio output currently goes.
public enum OutputRoute: Equatable, Sendable {
    /// The laptop's own speakers: the only route a pilot tone may play on.
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

/// The hard limits, shared by every tone generator. Not overridable:
/// - level: never above -30 dBFS per channel, and the channels' amplitudes together never above -30 dBFS either;
/// - 20 ms fade in and out;
/// - a session stops by itself after 60 s of rendered audio unless renewed;
/// - 10 s cooldown after a session before the next may start;
/// - built-in speaker only (headphones, external or unknown output: refused).
public enum SpeakerSafety {
    /// -30 dBFS.
    public static let maxAmplitude: Float = 0.031_622_777
    public static let fadeDuration: Double = 0.020
    public static let maxSessionDuration: Double = 60
    public static let cooldown: Double = 10
}

public enum ToneState: Equatable, Sendable { case idle, playing, fadingOut }

/// Session state machine and gain ramp. `nextGain()` runs on the audio thread (no locks, no allocation); control
/// calls come from another thread, the shared state is single machine words, and the worst race is one render
/// quantum of lag.
final class ToneSafetyCore: @unchecked Sendable {
    private(set) var state: ToneState = .idle
    private(set) var autoStopped = false
    private let routeCheck: () -> OutputRoute
    private let clock: () -> Double
    private var gain: Float = 0
    private var targetGain: Float = 0
    private let gainStep: Float
    private var sessionSamples = 0
    private var renewedAtSample = 0
    private let sessionLimitSamples: Int
    private var stoppedAt: Double?

    init(sampleRate: Double, routeCheck: @escaping () -> OutputRoute, clock: @escaping () -> Double) {
        self.routeCheck = routeCheck
        self.clock = clock
        gainStep = 1 / Float(max(1, SpeakerSafety.fadeDuration * sampleRate))
        sessionLimitSamples = Int(SpeakerSafety.maxSessionDuration * sampleRate)
    }

    var cooldownRemaining: Double {
        guard let stoppedAt else { return 0 }
        return max(0, stoppedAt + SpeakerSafety.fadeDuration + SpeakerSafety.cooldown - clock())
    }

    func start() throws {
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

    @discardableResult
    func renew() -> Bool {
        guard state == .playing else { return false }
        guard routeCheck().allowsPilotTone else { stop(); return false }
        renewedAtSample = sessionSamples
        return true
    }

    func stop() {
        guard state == .playing else { return }
        targetGain = 0
        state = .fadingOut
        stoppedAt = clock()
    }

    func stopImmediately() {
        if state == .playing { stoppedAt = clock() }
        targetGain = 0
        gain = 0
        state = .idle
    }

    /// Gain (0...1) for the next sample, or nil once the tone has gone silent (idle).
    @inline(__always) func nextGain() -> Float? {
        if state == .idle { return nil }
        if state == .playing && sessionSamples - renewedAtSample >= sessionLimitSamples {
            autoStopped = true
            targetGain = 0
            state = .fadingOut
            stoppedAt = clock()
        }
        if gain < targetGain { gain = min(targetGain, gain + gainStep) } else if gain > targetGain { gain = max(targetGain, gain - gainStep) }
        sessionSamples += 1
        if state == .fadingOut && gain == 0 { state = .idle }
        return gain
    }
}

/// Generates the continuous ~20 kHz pilot tone for `SonarWaveDetector`. It only renders samples; whoever owns the
/// audio engine decides when to play them (see `AcousticSession.startPilotTone`). All `SpeakerSafety` limits apply.
public final class PilotToneGenerator: @unchecked Sendable {
    public static let maxAmplitude = SpeakerSafety.maxAmplitude
    public static let fadeDuration = SpeakerSafety.fadeDuration
    public static let maxSessionDuration = SpeakerSafety.maxSessionDuration
    public static let cooldown = SpeakerSafety.cooldown
    public typealias State = ToneState

    public let frequency: Double
    public let sampleRate: Double
    /// Effective amplitude after the cap.
    public let amplitude: Float
    public var state: ToneState { core.state }
    /// True when the last session ended on its own (60 s without renew).
    public var autoStopped: Bool { core.autoStopped }
    public var cooldownRemaining: Double { core.cooldownRemaining }
    private let core: ToneSafetyCore
    private var phase: Double = 0

    /// - Parameters:
    ///   - amplitude: requested linear amplitude; silently capped at -30 dBFS.
    ///   - routeCheck: injectable for tests; defaults to reading CoreAudio.
    ///   - clock: seconds, monotonic; injectable for tests.
    public init(frequency: Double = SonarConfig.defaultPilotHz, sampleRate: Double = GhostkeysAcousticsInfo.sampleRate,
                amplitude: Float = SpeakerSafety.maxAmplitude,
                routeCheck: @escaping () -> OutputRoute = OutputRoute.current,
                clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.frequency = frequency
        self.sampleRate = sampleRate
        self.amplitude = min(max(0, amplitude.isFinite ? amplitude : 0), SpeakerSafety.maxAmplitude)
        core = ToneSafetyCore(sampleRate: sampleRate, routeCheck: routeCheck, clock: clock)
    }

    /// Starts a session (fades in). Throws if the output route is not the built-in speaker or during cooldown.
    /// Calling it while already playing just renews the session.
    public func start() throws { try core.start() }
    /// Extends the running session by another 60 s from now. Re-checks the route; stops if it is no longer allowed.
    @discardableResult public func renew() -> Bool { core.renew() }
    /// Fades out (20 ms) and starts the cooldown.
    public func stop() { core.stop() }
    /// Stops at once without a fade (the device is going away, for example a route change).
    public func stopImmediately() { core.stopImmediately() }

    public func render(count: Int) -> [Float] {
        var out = [Float](repeating: 0, count: count)
        out.withUnsafeMutableBufferPointer { render(into: $0.baseAddress!, count: count) }
        return out
    }

    /// Writes `count` samples. Silence when idle.
    public func render(into out: UnsafeMutablePointer<Float>, count: Int) {
        let increment = 2 * Double.pi * frequency / sampleRate
        for i in 0..<count {
            guard let g = core.nextGain() else { (out + i).update(repeating: 0, count: count - i); return }
            out[i] = amplitude * g * Float(sin(phase))
            phase += increment
            if phase > 2 * Double.pi { phase -= 2 * Double.pi }
        }
    }
}

/// Two pilot tones for `SonarField`: one on the left speaker channel, one on the right. All `SpeakerSafety` limits
/// apply to the pair as one session, and the two amplitudes together are capped at -30 dBFS (so even a mono downmix of
/// both channels never exceeds the cap).
public final class StereoPilotGenerator: @unchecked Sendable {
    public let leftFrequency: Double
    public let rightFrequency: Double
    public let sampleRate: Double
    /// Effective per-channel amplitudes after the caps.
    public let leftAmplitude: Float
    public let rightAmplitude: Float
    public var state: ToneState { core.state }
    public var autoStopped: Bool { core.autoStopped }
    public var cooldownRemaining: Double { core.cooldownRemaining }
    private let core: ToneSafetyCore
    private var phaseL: Double = 0
    private var phaseR: Double = 0

    /// Requested amplitudes are clamped to -30 dBFS each, then scaled down together if their sum exceeds -30 dBFS.
    /// The default splits the cap evenly (-36 dBFS per channel).
    public init(leftFrequency: Double = SonarFieldConfig.defaultLeftPilotHz,
                rightFrequency: Double = SonarFieldConfig.defaultRightPilotHz,
                sampleRate: Double = GhostkeysAcousticsInfo.sampleRate,
                leftAmplitude: Float = SpeakerSafety.maxAmplitude / 2, rightAmplitude: Float = SpeakerSafety.maxAmplitude / 2,
                routeCheck: @escaping () -> OutputRoute = OutputRoute.current,
                clock: @escaping () -> Double = { ProcessInfo.processInfo.systemUptime }) {
        self.leftFrequency = leftFrequency
        self.rightFrequency = rightFrequency
        self.sampleRate = sampleRate
        func clamp(_ a: Float) -> Float { min(max(0, a.isFinite ? a : 0), SpeakerSafety.maxAmplitude) }
        var l = clamp(leftAmplitude), r = clamp(rightAmplitude)
        if l + r > SpeakerSafety.maxAmplitude {
            let scale = SpeakerSafety.maxAmplitude / (l + r)
            l *= scale; r *= scale
        }
        self.leftAmplitude = l
        self.rightAmplitude = r
        core = ToneSafetyCore(sampleRate: sampleRate, routeCheck: routeCheck, clock: clock)
    }

    public func start() throws { try core.start() }
    @discardableResult public func renew() -> Bool { core.renew() }
    public func stop() { core.stop() }
    public func stopImmediately() { core.stopImmediately() }

    /// Writes `count` samples to each channel. Silence when idle.
    public func render(left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>, count: Int) {
        let incL = 2 * Double.pi * leftFrequency / sampleRate
        let incR = 2 * Double.pi * rightFrequency / sampleRate
        for i in 0..<count {
            guard let g = core.nextGain() else {
                (left + i).update(repeating: 0, count: count - i)
                (right + i).update(repeating: 0, count: count - i)
                return
            }
            left[i] = leftAmplitude * g * Float(sin(phaseL))
            right[i] = rightAmplitude * g * Float(sin(phaseR))
            phaseL += incL; if phaseL > 2 * Double.pi { phaseL -= 2 * Double.pi }
            phaseR += incR; if phaseR > 2 * Double.pi { phaseR -= 2 * Double.pi }
        }
    }

    public func render(count: Int) -> (left: [Float], right: [Float]) {
        var l = [Float](repeating: 0, count: count), r = [Float](repeating: 0, count: count)
        l.withUnsafeMutableBufferPointer { lp in r.withUnsafeMutableBufferPointer { rp in
            render(left: lp.baseAddress!, right: rp.baseAddress!, count: count)
        } }
        return (l, r)
    }
}
