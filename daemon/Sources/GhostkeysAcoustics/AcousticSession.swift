// ============================================================================================================
// NOT USED IN TESTS. This file is the only code in GhostkeysAcoustics that touches hardware: it OPENS THE
// MICROPHONE (macOS shows the orange mic indicator and may show a permission prompt) and can PLAY the pilot tone
// on the speaker. Tests drive the detectors with synthetic buffers instead. Keep sessions short; see README.md.
// ============================================================================================================
import AVFoundation
import Foundation

/// Microphone capture for sound mode: mono, 48 kHz, requested 256-frame buffers, plus a 200 ms ring buffer.
///
/// Voice processing is deliberately NOT enabled: Apple's voice processing (echo cancellation, noise suppression,
/// automatic gain) treats taps, rubs and the 20 kHz pilot as noise and removes them.
public final class AcousticSession: @unchecked Sendable {
    public struct Chunk: Sendable {
        /// Mono samples at `sampleRate`.
        public let samples: [Float]
        /// Host time of `samples[0]`, seconds (same clock as `mach_absolute_time`, which the IMU path also uses).
        public let time: Double
        public let sampleRate: Double
    }

    public enum SessionError: Error, Equatable {
        case microphoneDenied
        case noInputDevice
        case formatUnsupported
    }

    public static let sampleRate = GhostkeysAcousticsInfo.sampleRate
    /// Requested tap size. macOS treats this as a hint and may deliver larger buffers (often 480 to 4800 frames);
    /// the detectors accept any chunk size.
    public static let bufferFrames: AVAudioFrameCount = 256

    /// Last 200 ms of microphone audio, for looking back at a tap the IMU reported slightly after the sound arrived.
    public let ringBuffer: AudioRingBuffer
    public private(set) var isRunning = false
    public private(set) var isPilotPlaying = false

    private let onAudio: (Chunk) -> Void
    private var engine: AVAudioEngine?
    private var converter: AVAudioConverter?
    private var pilotNode: AVAudioSourceNode?
    private var stopPilot: ((Bool) -> Void)?
    private var configObserver: NSObjectProtocol?
    private let targetFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: AcousticSession.sampleRate,
                                             channels: 1, interleaved: false)!

    /// `onAudio` runs on an AVFoundation background thread for every captured buffer.
    public init(ringDuration: Double = 0.2, onAudio: @escaping (Chunk) -> Void) {
        ringBuffer = AudioRingBuffer(duration: ringDuration, sampleRate: Self.sampleRate)
        self.onAudio = onAudio
    }

    deinit { stop() }

    /// Current microphone permission. `.notDetermined` means starting will make macOS prompt the user.
    public static var microphoneAuthorization: AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .audio) }

    /// Opens the microphone. The orange indicator appears until `stop()`.
    public func start() throws {
        guard !isRunning else { return }
        switch Self.microphoneAuthorization {
        case .denied, .restricted: throw SessionError.microphoneDenied
        default: break
        }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        // Intentionally no `input.setVoiceProcessingEnabled(true)` (see type comment).
        let hwFormat = input.outputFormat(forBus: 0)
        guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else { throw SessionError.noInputDevice }
        if hwFormat.sampleRate != Self.sampleRate {
            guard let monoHw = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: hwFormat.sampleRate, channels: 1, interleaved: false),
                  let conv = AVAudioConverter(from: monoHw, to: targetFormat) else { throw SessionError.formatUnsupported }
            converter = conv
        }
        input.installTap(onBus: 0, bufferSize: Self.bufferFrames, format: hwFormat) { [weak self] buffer, time in
            self?.handle(buffer, time: time)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        isRunning = true
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            // Device or route changed (headphones plugged in, Bluetooth connected...): silence the pilot at once.
            self?.stopPilotTone(immediately: true)
        }
    }

    /// Closes the microphone (the orange indicator goes away) and stops the pilot tone.
    public func stop() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        stopPilotTone(immediately: true)
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        converter = nil
        ringBuffer.clear()
        isRunning = false
    }

    /// Plays the generator's output on the default output device. The generator enforces its own safety limits
    /// (level cap, built-in speaker only, 60 s sessions, cooldown); this throws whatever `generator.start()` throws.
    public func startPilotTone(_ generator: PilotToneGenerator) throws {
        guard engine != nil else { return }
        try generator.start()
        try attachSource(channels: 1, sampleRate: generator.sampleRate) { buffers, frames in
            for buffer in buffers {
                guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
                generator.render(into: data, count: frames)
            }
        }
        stopPilot = { immediately in immediately ? generator.stopImmediately() : generator.stop() }
        isPilotPlaying = true
    }

    /// Plays the SonarField pilots: the left tone on the left speaker channel, the right tone on the right.
    /// Same safety limits (enforced by the generator for the pair as one session).
    public func startStereoPilots(_ generator: StereoPilotGenerator) throws {
        guard engine != nil else { return }
        try generator.start()
        try attachSource(channels: 2, sampleRate: generator.sampleRate) { buffers, frames in
            guard buffers.count >= 2,
                  let l = buffers[0].mData?.assumingMemoryBound(to: Float.self),
                  let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) else {
                for b in buffers { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
                return
            }
            generator.render(left: l, right: r, count: frames)
        }
        stopPilot = { immediately in immediately ? generator.stopImmediately() : generator.stop() }
        isPilotPlaying = true
    }

    private func attachSource(channels: AVAudioChannelCount, sampleRate: Double,
                              render: @escaping (UnsafeMutableAudioBufferListPointer, Int) -> Void) throws {
        guard let engine else { return }
        if let old = pilotNode { engine.disconnectNodeOutput(old); engine.detach(old); pilotNode = nil }
        let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels)!
        let node = AVAudioSourceNode(format: format) { _, _, frameCount, audioBufferList -> OSStatus in
            render(UnsafeMutableAudioBufferListPointer(audioBufferList), Int(frameCount))
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        if !engine.isRunning { try engine.start() }
        pilotNode = node
    }

    public func stopPilotTone(immediately: Bool = false) {
        stopPilot?(immediately)
        if immediately, let node = pilotNode, let engine {
            engine.disconnectNodeOutput(node)
            engine.detach(node)
            pilotNode = nil
            stopPilot = nil
        }
        isPilotPlaying = false
    }

    private func handle(_ buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        let n = Int(buffer.frameLength)
        guard n > 0, let channels = buffer.floatChannelData else { return }
        let channelCount = Int(buffer.format.channelCount)
        var mono = [Float](repeating: 0, count: n)
        for c in 0..<channelCount {
            let src = channels[c]
            for i in 0..<n { mono[i] += src[i] }
        }
        if channelCount > 1 { let s = 1 / Float(channelCount); for i in 0..<n { mono[i] *= s } }

        var samples = mono
        if let converter { samples = resample(mono, from: buffer.format.sampleRate, with: converter) }
        let seconds = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : ProcessInfo.processInfo.systemUptime
        ringBuffer.write(samples, time: seconds)
        onAudio(Chunk(samples: samples, time: seconds, sampleRate: Self.sampleRate))
    }

    private func resample(_ mono: [Float], from rate: Double, with converter: AVAudioConverter) -> [Float] {
        guard let inFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let input = AVAudioPCMBuffer(pcmFormat: inFormat, frameCapacity: AVAudioFrameCount(mono.count)) else { return [] }
        input.frameLength = AVAudioFrameCount(mono.count)
        mono.withUnsafeBufferPointer { input.floatChannelData![0].update(from: $0.baseAddress!, count: mono.count) }
        let capacity = AVAudioFrameCount(Double(mono.count) * Self.sampleRate / rate) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else { return [] }
        var fed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true
            status.pointee = .haveData
            return input
        }
        guard error == nil, let data = output.floatChannelData else { return [] }
        return Array(UnsafeBufferPointer(start: data[0], count: Int(output.frameLength)))
    }
}
