// Read-only CoreAudio device facts for diagnostics. Reading these properties opens nothing, plays nothing and needs
// no permission.
import CoreAudio
import Foundation

public struct AudioDeviceSummary: Sendable, CustomStringConvertible {
    public var name: String
    public var manufacturer: String
    /// CoreAudio transport four-char code (`bltn` built-in, `blue` Bluetooth, `usb ` USB...).
    public var transport: String
    public var nominalSampleRate: Double
    public var inputChannels: Int
    public var outputChannels: Int
    /// Current data source four-char code, if the device has one (`imic` internal mic, `ispk` speakers, `hdpn`...).
    public var dataSource: String?

    public var description: String {
        "\"\(name)\" (\(manufacturer), transport \(transport), \(Int(nominalSampleRate)) Hz, in \(inputChannels) ch, out \(outputChannels) ch"
            + (dataSource.map { ", source \($0)" } ?? "") + ")"
    }

    public var dictionary: [String: Any] {
        var d: [String: Any] = ["name": name, "manufacturer": manufacturer, "transport": transport,
                                "nominalSampleRate": nominalSampleRate, "inputChannels": inputChannels,
                                "outputChannels": outputChannels]
        if let dataSource { d["dataSource"] = dataSource }
        return d
    }

    public static func defaultInput() -> AudioDeviceSummary? { summary(defaultDevice(kAudioHardwarePropertyDefaultInputDevice), input: true) }
    public static func defaultOutput() -> AudioDeviceSummary? { summary(defaultDevice(kAudioHardwarePropertyDefaultOutputDevice), input: false) }

    static func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        var device = AudioObjectID(0)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return nil }
        return device
    }

    static func summary(_ device: AudioObjectID?, input: Bool) -> AudioDeviceSummary? {
        guard let device else { return nil }
        func string(_ selector: AudioObjectPropertySelector) -> String {
            var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
            var value: Unmanaged<CFString>?
            var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
            guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr, let v = value else { return "?" }
            return v.takeRetainedValue() as String
        }
        func uint(_ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope) -> UInt32? {
            var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
            guard AudioObjectHasProperty(device, &address) else { return nil }
            var v: UInt32 = 0
            var size = UInt32(4)
            return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &v) == noErr ? v : nil
        }
        func channels(_ scope: AudioObjectPropertyScope) -> Int {
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope,
                                                     mElement: kAudioObjectPropertyElementMain)
            var size: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
            let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
            defer { raw.deallocate() }
            guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
            let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
            return list.reduce(0) { $0 + Int($1.mNumberChannels) }
        }
        var rate: Float64 = 0
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<Float64>.size)
        _ = AudioObjectGetPropertyData(device, &address, 0, nil, &size, &rate)
        let scope = input ? kAudioDevicePropertyScopeInput : kAudioDevicePropertyScopeOutput
        return AudioDeviceSummary(
            name: string(kAudioObjectPropertyName), manufacturer: string(kAudioObjectPropertyManufacturer),
            transport: uint(kAudioDevicePropertyTransportType, scope: kAudioObjectPropertyScopeGlobal).map(OutputRoute.fourCC) ?? "?",
            nominalSampleRate: rate, inputChannels: channels(kAudioDevicePropertyScopeInput),
            outputChannels: channels(kAudioDevicePropertyScopeOutput),
            dataSource: uint(kAudioDevicePropertyDataSource, scope: scope).map(OutputRoute.fourCC))
    }
}

public extension AudioDeviceSummary {
    /// The default output's volume slider (0...1, the scalar macOS shows) and mute state, or nil if unreadable.
    /// The pilots are rendered at a fixed digital level and then scaled by this slider, so a low volume lowers the
    /// pilot at the microphone one for one (in dB). Reading it changes nothing.
    static func defaultOutputVolume() -> (scalar: Double, muted: Bool)? {
        guard let device = defaultDevice(kAudioHardwarePropertyDefaultOutputDevice) else { return nil }
        func scalar(_ element: UInt32) -> Float32? {
            var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyVolumeScalar,
                                                     mScope: kAudioDevicePropertyScopeOutput, mElement: element)
            guard AudioObjectHasProperty(device, &address) else { return nil }
            var v: Float32 = 0
            var size = UInt32(MemoryLayout<Float32>.size)
            return AudioObjectGetPropertyData(device, &address, 0, nil, &size, &v) == noErr ? v : nil
        }
        let values = [scalar(kAudioObjectPropertyElementMain), scalar(1), scalar(2)].compactMap { $0 }
        guard !values.isEmpty else { return nil }
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute, mScope: kAudioDevicePropertyScopeOutput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var mute: UInt32 = 0
        var size = UInt32(4)
        let muted = AudioObjectHasProperty(device, &address)
            && AudioObjectGetPropertyData(device, &address, 0, nil, &size, &mute) == noErr && mute != 0
        return (Double(values.max()!), muted)
    }
}
