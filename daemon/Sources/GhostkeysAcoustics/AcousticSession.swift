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

    /// What the capture path really looks like (for `sonar_debug`). Static parts are filled at `start()`, live parts
    /// (measured rate, per-channel pilot levels) as audio arrives.
    public struct InputPathInfo: Sendable {
        /// Format the input node delivers (the hardware format).
        public var hardwareSampleRate: Double = 0
        public var hardwareChannels: Int = 0
        public var hardwareFormat: String = ""
        /// True when the capture is resampled to 48 kHz (hardware rate differs).
        public var resampled = false
        public var voiceProcessingEnabled = false
        public var voiceProcessingAGCEnabled = false
        public var voiceProcessingBypassed = false
        /// macOS microphone mode from Control Center (standard, wideSpectrum, voiceIsolation) and the app's preference.
        public var microphoneMode: String = "?"
        public var preferredMicrophoneMode: String = "?"
        public var device: AudioDeviceSummary?
        /// Sample rate measured from delivered frames and host time, Hz.
        public var measuredSampleRate: Double = 0
        public var callbacks = 0
        public var minBufferFrames = 0
        public var maxBufferFrames = 0
        /// Largest gap between one buffer's end and the next buffer's start, ms (timestamps).
        public var maxTimestampGapMs: Double = 0
        /// Per input channel: level at each probe frequency (dBFS, Hann-windowed 4096-sample DFT at the hardware rate)
        /// and overall RMS (dBFS). Index `hardwareChannels` holds the mono mix the detectors actually get.
        public var channelProbeDbfs: [[Double]] = []
        public var channelRmsDbfs: [Double] = []
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
    private var player: TonePlayer?
    private var stopPilot: ((Bool) -> Void)?
    private var configObserver: NSObjectProtocol?
    /// Called (on an arbitrary thread) after the audio hardware configuration changed: output route, device, sample
    /// rate or channel count. The tones are already cut and AVAudioEngine has stopped itself (the microphone delivers
    /// nothing more); the owner should `stop()` and open a new session.
    public var onConfigurationChange: (() -> Void)?
    /// Frequencies (Hz) to measure per input channel, e.g. the two SonarField pilots. Set before `start()`.
    public var probeFrequencies: [Double] = []
    private let statsLock = NSLock()
    private var info = InputPathInfo()
    private var firstHostTime: Double?
    private var framesSinceFirst = 0
    private var expectedNext: Double?
    private var probeBuffers: [[Float]] = []
    private var probeFill = 0
    private var probeSinceLast = 0
    private var probeCos: [[Float]] = []
    private var probeSin: [[Float]] = []
    private var probeWindowSum: Float = 1
    private static let probeLength = 4096
    private let rawLock = NSLock()
    private var raw: RawCapture?
    /// Plain flag read on the tap thread without the lock (a stale read only delays the capture by one buffer).
    private var rawArmed = false

    private struct RawCapture {
        var url: URL
        var startAt: Double
        var frames: Int
        var channels = 0
        var rate = 0.0
        var samples: [Float] = []
        var firstTime: Double?
        var done: (String) -> Void
    }

    /// Tone playback formats (source rendered by the generator, output device), nil while no tone engine runs.
    public var tonePlayerFormats: (source: String, device: String)? {
        guard let player, let src = player.sourceFormat, let dev = player.deviceFormat else { return nil }
        return (src, dev)
    }

    /// Snapshot of the capture path (thread safe).
    public var inputPathInfo: InputPathInfo {
        statsLock.lock(); defer { statsLock.unlock() }
        return info
    }

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
        var i = InputPathInfo()
        i.hardwareSampleRate = hwFormat.sampleRate
        i.hardwareChannels = Int(hwFormat.channelCount)
        i.hardwareFormat = "\(hwFormat)"
        i.resampled = converter != nil
        i.voiceProcessingEnabled = input.isVoiceProcessingEnabled
        i.voiceProcessingAGCEnabled = input.isVoiceProcessingAGCEnabled
        i.voiceProcessingBypassed = input.isVoiceProcessingBypassed
        if #available(macOS 12.0, *) {
            i.microphoneMode = Self.name(AVCaptureDevice.activeMicrophoneMode)
            i.preferredMicrophoneMode = Self.name(AVCaptureDevice.preferredMicrophoneMode)
        }
        i.device = AudioDeviceSummary.defaultInput()
        setUpProbes(rate: hwFormat.sampleRate, channels: Int(hwFormat.channelCount))
        statsLock.lock(); info = i; firstHostTime = nil; framesSinceFirst = 0; expectedNext = nil; statsLock.unlock()
        input.installTap(onBus: 0, bufferSize: Self.bufferFrames, format: hwFormat) { [weak self] buffer, time in
            self?.handle(buffer, time: time)
        }
        engine.prepare()
        try engine.start()
        self.engine = engine
        isRunning = true
        configObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            // Device or route changed (headphones plugged in, Bluetooth connected...): silence the pilot at once.
            // AVAudioEngine also stops itself here, so the microphone is dead until the owner reopens it.
            self?.stopPilotTone(immediately: true)
            self?.onConfigurationChange?()
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

    /// Plays the generator's output on the default output device, on a separate output-only engine (`TonePlayer`)
    /// so the capture engine is never rewired. The generator enforces its own safety limits (level cap, built-in
    /// speaker only, renewal watchdog, cooldown after a refusal); this throws whatever `generator.start()` or the
    /// player throws (the generator is stopped again if the player fails).
    public func startPilotTone(_ generator: PilotToneGenerator) throws {
        guard engine != nil else { return }
        try generator.start()
        do {
            try startPlayer(channels: 1, sampleRate: generator.sampleRate) { buffers, frames in
                for buffer in buffers {
                    guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
                    generator.render(into: data, count: frames)
                }
            }
        } catch { generator.stopImmediately(); throw error }
        stopPilot = { immediately in immediately ? generator.stopImmediately() : generator.stop() }
        isPilotPlaying = true
    }

    /// Plays the SonarField pilots: the left tone on the left speaker channel, the right tone on the right.
    /// Same safety limits (enforced by the generator for the pair as one session). Create the generator at
    /// `TonePlayer.outputSampleRate()` so no resampling happens.
    public func startStereoPilots(_ generator: StereoPilotGenerator) throws {
        guard engine != nil else { return }
        try generator.start()
        do {
            try startPlayer(channels: 2, sampleRate: generator.sampleRate) { buffers, frames in
                guard buffers.count >= 2,
                      let l = buffers[0].mData?.assumingMemoryBound(to: Float.self),
                      let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) else {
                    for b in buffers { if let d = b.mData { memset(d, 0, Int(b.mDataByteSize)) } }
                    return
                }
                generator.render(left: l, right: r, count: frames)
            }
        } catch { generator.stopImmediately(); throw error }
        stopPilot = { immediately in immediately ? generator.stopImmediately() : generator.stop() }
        isPilotPlaying = true
    }

    private func startPlayer(channels: AVAudioChannelCount, sampleRate: Double,
                             render: @escaping (UnsafeMutableAudioBufferListPointer, Int) -> Void) throws {
        player?.stop()
        let p = TonePlayer()
        // Output changed (headphones, Bluetooth...): cut the tone at once. The owner's renewal notices it is no
        // longer playing and starts again only after its route check.
        p.onConfigurationChange = { [weak self] in self?.stopPilotTone(immediately: true) }
        try p.start(channels: channels, sampleRate: sampleRate, render: render)
        player = p
    }

    public func stopPilotTone(immediately: Bool = false) {
        stopPilot?(immediately)
        if immediately {
            player?.stop()
            player = nil
            stopPilot = nil
        }
        isPilotPlaying = false
    }

    /// Diagnostics only (tuning sonar on real hardware): records the raw input, every channel at the hardware rate,
    /// starting `delay` seconds from now, for `seconds` (at most 30), and writes it as a 32-bit float WAV to `url` (a
    /// local file; nothing is sent anywhere). `done` gets a one-line result on a background thread.
    public func captureRaw(to url: URL, seconds: Double, delay: Double, done: @escaping (String) -> Void) {
        let start = ProcessInfo.processInfo.systemUptime + max(0, delay)
        rawLock.lock()
        raw = RawCapture(url: url, startAt: start, frames: Int(min(30, max(0.5, seconds)) * 48_000), done: done)
        rawArmed = true
        rawLock.unlock()
    }

    private func recordRaw(_ channels: UnsafePointer<UnsafeMutablePointer<Float>>, channelCount: Int, frames n: Int,
                           rate: Double, time: Double) {
        rawLock.lock()
        guard var r = raw, time >= r.startAt else { rawLock.unlock(); return }
        if r.firstTime == nil {
            r.firstTime = time; r.channels = channelCount; r.rate = rate
            r.frames = Int(Double(r.frames) / 48_000 * rate)
            r.samples.reserveCapacity(r.frames * channelCount)
        }
        let take = min(n, r.frames - r.samples.count / max(1, r.channels))
        if channelCount == r.channels, take > 0 {
            for i in 0..<take { for c in 0..<channelCount { r.samples.append(channels[c][i]) } }
        }
        let finished = r.samples.count / max(1, r.channels) >= r.frames
        raw = finished ? nil : r
        if finished { rawArmed = false }
        rawLock.unlock()
        guard finished else { return }
        DispatchQueue.global(qos: .utility).async {
            do {
                try Self.writeFloatWav(r.samples, channels: r.channels, rate: r.rate, to: r.url)
                r.done("raw capture written: \(r.url.path) (\(r.channels) ch, \(Int(r.rate)) Hz, \(r.frames) frames, starts at host time \(r.firstTime ?? 0))")
            } catch {
                r.done("raw capture failed: \(error)")
            }
        }
    }

    /// 32-bit float WAV (format 3), interleaved.
    public static func writeFloatWav(_ samples: [Float], channels: Int, rate: Double, to url: URL) throws {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 4)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(3); u16(UInt16(channels)); u32(UInt32(rate))
        u32(UInt32(rate) * UInt32(channels) * 4); u16(UInt16(channels * 4)); u16(32)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        samples.withUnsafeBufferPointer { d.append(UnsafeBufferPointer(start: UnsafeRawPointer($0.baseAddress!).assumingMemoryBound(to: UInt8.self), count: samples.count * 4)) }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try d.write(to: url, options: .atomic)
    }

    private func handle(_ buffer: AVAudioPCMBuffer, time: AVAudioTime) {
        let n = Int(buffer.frameLength)
        guard n > 0, let channels = buffer.floatChannelData else { return }
        let channelCount = Int(buffer.format.channelCount)
        if rawArmed {
            let t = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : ProcessInfo.processInfo.systemUptime
            recordRaw(channels, channelCount: channelCount, frames: n, rate: buffer.format.sampleRate, time: t)
        }
        var mono = [Float](repeating: 0, count: n)
        for c in 0..<channelCount {
            let src = channels[c]
            for i in 0..<n { mono[i] += src[i] }
        }
        if channelCount > 1 { let s = 1 / Float(channelCount); for i in 0..<n { mono[i] *= s } }
        let hostSeconds = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : ProcessInfo.processInfo.systemUptime
        recordStats(channels: channels, channelCount: channelCount, mono: mono, frames: n, rate: buffer.format.sampleRate, time: hostSeconds)

        var samples = mono
        if let converter { samples = resample(mono, from: buffer.format.sampleRate, with: converter) }
        let seconds = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : ProcessInfo.processInfo.systemUptime
        ringBuffer.write(samples, time: seconds)
        onAudio(Chunk(samples: samples, time: seconds, sampleRate: Self.sampleRate))
    }

    @available(macOS 12.0, *)
    static func name(_ mode: AVCaptureDevice.MicrophoneMode) -> String {
        switch mode {
        case .standard: return "standard"
        case .wideSpectrum: return "wideSpectrum"
        case .voiceIsolation: return "voiceIsolation"
        @unknown default: return "other(\(mode.rawValue))"
        }
    }

    private func setUpProbes(rate: Double, channels: Int) {
        let n = Self.probeLength
        let w = DSPMath.periodicHann(n)
        probeWindowSum = w.reduce(0, +)
        probeCos = probeFrequencies.map { f in (0..<n).map { w[$0] * Float(cos(2 * Double.pi * f * Double($0) / rate)) } }
        probeSin = probeFrequencies.map { f in (0..<n).map { w[$0] * Float(sin(2 * Double.pi * f * Double($0) / rate)) } }
        probeBuffers = [[Float]](repeating: [Float](repeating: 0, count: n), count: channels + 1)
        probeFill = 0
        probeSinceLast = 0
    }

    /// Runs on the tap thread. Keeps the last 4096 raw samples per channel (plus the mono mix) and, about every 0.1 s,
    /// measures each probe frequency per channel.
    private func recordStats(channels: UnsafePointer<UnsafeMutablePointer<Float>>, channelCount: Int, mono: [Float],
                             frames n: Int, rate: Double, time: Double) {
        let len = Self.probeLength
        var probe: [[Double]]? = nil
        var rms: [Double]? = nil
        if !probeBuffers.isEmpty, probeBuffers.count == channelCount + 1 {
            let take = min(n, len)
            for c in 0...channelCount {
                probeBuffers[c].withUnsafeMutableBufferPointer { b in
                    let p = b.baseAddress!
                    p.update(from: p + take, count: len - take)
                    if c < channelCount { (p + len - take).update(from: channels[c] + (n - take), count: take) }
                    else { mono.withUnsafeBufferPointer { (p + len - take).update(from: $0.baseAddress! + (n - take), count: take) } }
                }
            }
            probeFill = min(len, probeFill + take)
            probeSinceLast += n
            if probeFill == len && probeSinceLast >= Int(rate / 10) {
                probeSinceLast = 0
                var levels: [[Double]] = [], r: [Double] = []
                for c in 0...channelCount {
                    probeBuffers[c].withUnsafeBufferPointer { b in
                        var row: [Double] = []
                        for k in probeCos.indices {
                            let re = probeCos[k].withUnsafeBufferPointer { Double(DSPMath.dot(b.baseAddress!, $0.baseAddress!, len)) }
                            let im = probeSin[k].withUnsafeBufferPointer { Double(DSPMath.dot(b.baseAddress!, $0.baseAddress!, len)) }
                            let amp = 2 * (re * re + im * im).squareRoot() / Double(probeWindowSum)
                            row.append(20 * log10(max(amp, 1e-10)))
                        }
                        levels.append(row)
                        r.append(10 * log10(max(Double(DSPMath.meanSquare(b.baseAddress!, len)), 1e-20)))
                    }
                }
                probe = levels
                rms = r
            }
        }
        statsLock.lock()
        info.callbacks += 1
        info.minBufferFrames = info.minBufferFrames == 0 ? n : min(info.minBufferFrames, n)
        info.maxBufferFrames = max(info.maxBufferFrames, n)
        if let e = expectedNext { info.maxTimestampGapMs = max(info.maxTimestampGapMs, abs(time - e) * 1000) }
        expectedNext = time + Double(n) / rate
        if let first = firstHostTime {
            framesSinceFirst += n
            if time > first { info.measuredSampleRate = Double(framesSinceFirst - n) / (time - first) }
        } else {
            firstHostTime = time
            framesSinceFirst = n
        }
        if let probe { info.channelProbeDbfs = probe }
        if let rms { info.channelRmsDbfs = rms }
        statsLock.unlock()
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
