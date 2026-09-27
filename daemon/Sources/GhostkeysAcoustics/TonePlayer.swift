// ============================================================================================================
// NOT USED IN TESTS. Touches hardware: it PLAYS whatever the render callback writes on the default output device.
// The pilot generators decide what that is (capped, faded, built-in speakers only); see README.md.
// ============================================================================================================
import AVFoundation
import CoreAudio
import Foundation

/// Output-only playback on its own AVAudioEngine, separate from the capture engine in `AcousticSession`.
///
/// Why separate: on Apple Silicon MacBooks the built-in microphone and the built-in speakers are two different
/// CoreAudio devices. Adding an output source to the running capture engine made its I/O unit fail to start
/// (`kAudioUnitErr_CannotDoInCurrentContext`, -10867, from `PerformCommand(*ioNode, kAUStartIO)`). An engine that only
/// plays starts and stops without ever touching the microphone engine, in any order.
public final class TonePlayer: @unchecked Sendable {
    public enum PlayerError: Error, Equatable {
        case formatUnsupported
        case notRunning
    }

    private var engine: AVAudioEngine?
    private var node: AVAudioSourceNode?
    private var observer: NSObjectProtocol?
    /// Called (on an arbitrary thread) when the output hardware changed under the player. The engine has stopped
    /// itself; the owner cuts the tone and may start again later (after its route check).
    public var onConfigurationChange: (() -> Void)?
    public var isPlaying: Bool { engine?.isRunning ?? false }

    public init() {}
    deinit { stop() }

    /// Nominal sample rate of the default output device (48 kHz on current MacBooks), or nil if unreadable.
    /// Reading it plays nothing and needs no permission.
    public static func outputSampleRate() -> Double? {
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        var rate: Float64 = 0
        size = UInt32(MemoryLayout<Float64>.size)
        address.mSelector = kAudioDevicePropertyNominalSampleRate
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate) == noErr, rate > 0 else { return nil }
        return rate
    }

    /// Builds a fresh output-only engine with one source node (`channels` at `sampleRate`) and starts it.
    /// `render` runs on the real-time audio thread: no locks, no allocation.
    public func start(channels: AVAudioChannelCount, sampleRate: Double,
                      render: @escaping (UnsafeMutableAudioBufferListPointer, Int) -> Void) throws {
        stop()
        guard let format = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: channels) else {
            throw PlayerError.formatUnsupported
        }
        let engine = AVAudioEngine()
        let node = AVAudioSourceNode(format: format) { _, _, frameCount, audioBufferList -> OSStatus in
            render(UnsafeMutableAudioBufferListPointer(audioBufferList), Int(frameCount))
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        // The mixer to the output: the output device's own format, so the engine does no device renegotiation.
        let hw = engine.outputNode.outputFormat(forBus: 0)
        if hw.sampleRate > 0, hw.channelCount > 0 {
            engine.connect(engine.mainMixerNode, to: engine.outputNode, format: hw)
        }
        engine.prepare()
        try engine.start()
        guard engine.isRunning else { engine.stop(); throw PlayerError.notRunning }
        self.engine = engine
        self.node = node
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine,
                                                          queue: nil) { [weak self] _ in
            self?.onConfigurationChange?()
        }
    }

    public func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        engine?.stop()
        if let engine, let node { engine.detach(node) }
        engine = nil
        node = nil
    }
}
