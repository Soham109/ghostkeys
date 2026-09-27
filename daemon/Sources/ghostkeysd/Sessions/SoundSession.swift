import Foundation
import AVFoundation
import GhostkeysAcoustics
// Note: this file must not import GhostkeysDetection (both modules define `TapFeatures`).

/// Runs short microphone sessions for sound mode (GhostkeysAcoustics README "How the daemon should integrate").
/// All methods are called on the daemon's core queue; audio chunks are hopped onto it too.
/// With `simulate`, no device is touched: the session only exists as state and a timer (for tests).
final class SoundSession {
    struct Gesture { var name: String; var time: Double; var confidence: Double; var extra: [String: Any] }

    let simulate: Bool
    private let queue: DispatchQueue
    private let tapModelURL: URL
    private var session: AcousticSession?
    private var processor: SoundModeProcessor?
    private var pilot: PilotToneGenerator?
    private var stereo: StereoPilotGenerator?
    /// SonarField mode (stereo pilots, hover / push / pull / sweep / finger slides).
    private(set) var sonarFieldOn = false
    private var lastSuppress = 0.0
    private var lastRenew = 0.0
    private(set) var sonarOn = false
    private(set) var tapTypesOn = false

    // Tap-type calibration: IMU onsets waiting for their audio window, and the labeled examples so far.
    private var calPending: [(t: Double, label: TapType)] = []
    private(set) var calExamples: [LabeledTap] = []
    private let calExtractor = TapFeatureExtractor()
    /// Called on the core queue for each calibration onset: the label and whether a usable window was found.
    var onCalibrationSample: (_ label: String, _ captured: Bool) -> Void = { _, _ in }

    /// `sonar_debug` on the "debug" stream (~10 Hz while a sonar session runs), wired by the daemon: whether anyone
    /// subscribed, and where to send. Called on the core queue.
    static var debugWanted: () -> Bool = { false }
    static var debugSink: ([String: Any]) -> Void = { _ in }
    private var lastDebugAt = 0.0
    private var loggedToneFormats = false

    var onGesture: (Gesture) -> Void = { _ in }
    /// Continuous SonarField values (hover_level, finger_slide), as `air` message fields.
    var onAir: ([String: Any]) -> Void = { _ in }
    /// onset (Clock seconds) and tap type name, or nil if the sound was not classified.
    var onTapType: (_ onset: Double, _ type: String?) -> Void = { _, _ in }

    init(queue: DispatchQueue, simulate: Bool, modelDirectory: URL) {
        self.queue = queue
        self.simulate = simulate
        tapModelURL = modelDirectory.appendingPathComponent("tap-types.json")
    }

    /// A microphone exists. Does not open it and never prompts.
    static var hardwarePresent: Bool { AVCaptureDevice.default(for: .audio) != nil }

    /// "authorized", "denied", "not_determined".
    static var permission: String {
        switch AcousticSession.microphoneAuthorization {
        case .authorized: return "authorized"
        case .notDetermined: return "not_determined"
        default: return "denied"
        }
    }

    var running: Bool { session != nil || (simulate && processor != nil) }

    /// Opens the microphone. `userInitiated` must be true for anything that could show the permission prompt.
    /// `sonarField`: sonar mode, the stereo tones play (and are kept playing by `maintainSonarTones`) for as long as
    /// the session is open. Returns an error message, or nil on success.
    func start(wantSonar: Bool, userInitiated: Bool, sonarField: Bool = false) -> String? {
        guard !running else { return nil }
        let classifier = (try? Data(contentsOf: tapModelURL)).flatMap { try? JSONDecoder().decode(TapTypeClassifier.self, from: $0) }
        var opts = SoundModeProcessor.Options()
        opts.sonar = wantSonar && !sonarField        // SonarField replaces the single pilot
        opts.sonarField = sonarField
        opts.tapTypes = classifier != nil
        let proc = SoundModeProcessor(options: opts, tapClassifier: classifier)
        tapTypesOn = classifier != nil
        let mode = sonarField ? "sonar" : "sound"

        if simulate {
            processor = proc
            sonarOn = wantSonar
            sonarFieldOn = sonarField
            fieldMode = sonarField
            Log.info("\(mode) session started (simulated: no microphone opened)")
            return nil
        }
        guard Self.hardwarePresent else { return "no microphone on this Mac" }
        switch Self.permission {
        case "denied": return "microphone access is denied (System Settings > Privacy & Security > Microphone)"
        case "not_determined" where !userInitiated: return "microphone permission not granted yet; start a session from the app first"
        default: break
        }
        let s = makeAcousticSession()
        if sonarField { s.probeFrequencies = [proc.field.pilotFrequencies.left, proc.field.pilotFrequencies.right] }
        do { try s.start() } catch {
            return "could not open the microphone: \(error)"
        }
        Self.logAudioPath(s)
        loggedToneFormats = false
        session = s
        processor = proc
        sonarOn = false
        sonarFieldOn = false
        fieldMode = sonarField
        toneRetryAt = 0
        toneProblem = nil
        MicMarker.set(true)
        if sonarField {
            let line = maintainSonarTones()
            Log.info("sonar session started (microphone open; \(line ?? "tones playing"))")
            return nil
        } else if wantSonar {
            // The generator enforces its own limits (-30 dBFS, built-in speaker only, 60 s, cooldown after a refusal).
            let g = PilotToneGenerator()
            do {
                try s.startPilotTone(g)
                pilot = g
                sonarOn = true
                lastRenew = Clock.now()
            } catch {
                Log.info("wave pilot tone off for this session: \(Self.describe(error))")
            }
        }
        Log.info("sound session started (microphone open\(sonarOn ? ", wave pilot tone on" : ""))")
        return nil
    }

    /// Once per session: which devices and formats are really in use.
    private static func logAudioPath(_ s: AcousticSession) {
        let i = s.inputPathInfo
        Log.info("audio input: \(i.device?.description ?? "unknown device"); engine input format \(Int(i.hardwareSampleRate)) Hz, "
                 + "\(i.hardwareChannels) ch\(i.resampled ? " (resampled to 48 kHz)" : ""); voice processing \(i.voiceProcessingEnabled ? "ON" : "off"), "
                 + "AGC \(i.voiceProcessingAGCEnabled ? "on" : "off"), mic mode \(i.microphoneMode) (preferred \(i.preferredMicrophoneMode))")
        Log.info("audio output: \(AudioDeviceSummary.defaultOutput()?.description ?? "unknown device"); route \(describe(OutputRoute.current()))")
    }

    private func makeAcousticSession() -> AcousticSession {
        let s = AcousticSession { [weak self] chunk in
            self?.queue.async { self?.process(chunk) }
        }
        s.onConfigurationChange = { [weak self] in self?.queue.async { self?.audioConfigurationChanged(s) } }
        return s
    }

    func stop() {
        if session != nil { MicMarker.set(false) }
        session?.stop()           // also stops the pilot tones immediately
        session = nil
        pilot = nil
        stereo = nil
        sonarFieldOn = false
        fieldMode = false
        toneProblem = nil
        processor?.reset()
        processor = nil
        sonarOn = false
        tapTypesOn = false
    }

    /// Keep the single wave pilot tone alive in long sound sessions (the generator stops itself after 60 s otherwise).
    func tick() {
        guard let pilot, let session, sonarOn, Clock.now() - lastRenew > 30 else { return }
        if pilot.renew() {
            lastRenew = Clock.now()
        } else {
            // renew() re-checks the output route; anything but the built-in speaker stops the tone.
            session.stopPilotTone(immediately: true)
            sonarOn = false
            Log.info("wave pilot tone stopped: output is no longer the built-in speaker")
        }
    }

    // MARK: Sonar tones (continuous while sonar is on)

    /// Why the tones are not playing in sonar mode (nil while they play).
    private(set) var toneProblem: String?
    private var toneRetryAt = 0.0
    private var fieldMode = false
    private var configChanges: [Double] = []

    /// Sonar mode, called every second: renews the tones (the renewal re-runs the built-in-speakers route check, so a
    /// switch to headphones or Bluetooth stops them within a second, or at once via the audio configuration change),
    /// and restarts them once the route is fine again. A refusal waits the 10 s cooldown before the next try;
    /// renewals never do. Returns a log line when the tone state changed.
    @discardableResult
    func maintainSonarTones() -> String? {
        guard fieldMode, !simulate, let session else { return nil }
        let now = Clock.now()
        if let stereo {
            if stereo.state == .playing {
                if stereo.renew() { return nil }
                session.stopPilotTone(immediately: true)
                self.stereo = nil
                sonarFieldOn = false
                toneRetryAt = now + SpeakerSafety.cooldown
                toneProblem = "output is \(Self.describe(OutputRoute.current()))"
                return "sonar tones stopped: \(toneProblem!); they come back by themselves on the built-in speakers"
            }
            // Cut from outside (audio configuration change) or the 60 s watchdog (renewals stopped).
            session.stopPilotTone(immediately: true)
            self.stereo = nil
            sonarFieldOn = false
            toneRetryAt = max(toneRetryAt, now + 1)
            toneProblem = stereo.autoStopped ? "tones timed out without renewal" : "audio output changed"
            return "sonar tones stopped: \(toneProblem!); retrying"
        }
        guard now >= toneRetryAt else { return nil }
        // At the output device's own rate (48 kHz on current MacBooks), so the playback engine never resamples.
        let g = StereoPilotGenerator(sampleRate: TonePlayer.outputSampleRate() ?? GhostkeysAcousticsInfo.sampleRate)
        do {
            try session.startStereoPilots(g)
            stereo = g
            sonarFieldOn = true
            lastRenew = now
            let was = toneProblem
            toneProblem = nil
            if !loggedToneFormats, let f = session.tonePlayerFormats {
                loggedToneFormats = true
                Log.info("sonar tones: source \(f.source); output device \(f.device); per-channel amplitude "
                         + "\(String(format: "%.1f", 20 * log10(Double(g.leftAmplitude)))) dBFS")
            }
            return was == nil ? "tones playing" : "sonar tones back on (built-in speakers)"
        } catch {
            toneRetryAt = now + SpeakerSafety.cooldown
            let problem = Self.describe(error)
            guard problem != toneProblem else { return nil }
            toneProblem = problem
            return "sonar tones refused: \(problem); trying again every \(Int(SpeakerSafety.cooldown)) s"
        }
    }

    /// Called when the microphone could not be reopened after an audio configuration change.
    var onFailure: (String) -> Void = { _ in }

    /// AVAudioEngine stopped itself (device, route, sample rate or channel count changed): the tones are already cut
    /// and the microphone delivers nothing. Reopen it; sonar tones come back through the next route check.
    private func audioConfigurationChanged(_ changed: AcousticSession) {
        guard let old = session, old === changed else { return }
        let now = Clock.now()
        configChanges = configChanges.filter { now - $0 < 30 } + [now]
        old.stop()
        stereo = nil
        pilot = nil
        sonarFieldOn = false
        sonarOn = false
        let s = makeAcousticSession()
        do { try s.start() } catch {
            session = nil
            MicMarker.set(false)
            processor?.reset()
            processor = nil
            fieldMode = false
            Log.info("audio configuration changed and the microphone could not be reopened: \(error)")
            onFailure("could not reopen the microphone after an audio change: \(error)")
            return
        }
        session = s
        if fieldMode {
            if configChanges.count >= 3 {
                toneRetryAt = now + 30
                toneProblem = "audio configuration keeps changing"
                Log.info("audio configuration changed \(configChanges.count) times in 30 s: microphone reopened, sonar tones wait 30 s")
            } else {
                toneRetryAt = now + 0.5
                toneProblem = "audio output changed"
                Log.info("audio configuration changed: tones cut, microphone reopened; tones resume after the route check")
            }
        } else {
            Log.info("audio configuration changed: microphone reopened")
        }
    }

    static func describe(_ error: Error) -> String {
        switch error {
        case PilotToneError.routeNotAllowed(let route): return "output is \(describe(route)), not the built-in speakers"
        case PilotToneError.coolingDown(let left): return "cooling down (\(Int(left.rounded(.up))) s left)"
        case AcousticSession.SessionError.microphoneDenied: return "microphone access is denied"
        case TonePlayer.PlayerError.notRunning: return "the speakers could not start the tones (the output engine did not run)"
        default:
            let ns = error as NSError
            if ns.domain.contains("coreaudio") || ns.domain == NSOSStatusErrorDomain {
                return "the speakers could not start the tones (CoreAudio error \(ns.code))"
            }
            return "\(error)"
        }
    }

    static func describe(_ route: OutputRoute) -> String {
        switch route {
        case .builtInSpeaker: return "the built-in speakers"
        case .headphones: return "headphones"
        case .external(let t): return t == "blue" ? "a Bluetooth device" : "an external device (\(t.trimmingCharacters(in: .whitespaces)))"
        case .unknown: return "an unknown device"
        }
    }

    func noteTapOnset(_ t: Double) {
        processor?.noteTapOnset(imuTime: t)
    }

    /// Typing and laptop motion make Doppler and phase noise: hold SonarField detection off until `until`
    /// (called at most every 50 ms).
    func suppressSonar(until: Double) {
        guard sonarFieldOn, let processor, until - lastSuppress > 0.05 else { return }
        lastSuppress = until
        processor.suppressSonar(until: until)
    }

    /// Test hook (simulated sessions): feed a SonarField event as if the processor had produced it.
    func simulate(gesture name: String, side: String?, distanceMm: Double?) {
        guard simulate, running else { return }
        var extra: [String: Any] = [:]
        if let side { extra["side"] = side }
        if let distanceMm { extra["distanceMm"] = distanceMm }
        onGesture(Gesture(name: name, time: Clock.now(), confidence: 0.9, extra: extra))
    }

    func simulate(air: [String: Any]) {
        guard simulate, running else { return }
        onAir(air)
    }

    private func process(_ chunk: AcousticSession.Chunk) {
        guard let processor, session != nil else { return }
        let events = processor.process(chunk.samples, time: chunk.time)
        if fieldMode, chunk.time - lastDebugAt >= 0.1, Self.debugWanted() {
            lastDebugAt = chunk.time
            Self.debugSink(sonarDebugMessage(t: chunk.time))
        }
        captureCalibrationWindows(ring: processor.ringBuffer)
        for event in events {
            switch event {
            case .gesture(let g):
                var extra: [String: Any] = [:]
                if let d = g.duration { extra["duration"] = (d * 1000).rounded() / 1000 }
                if let s = g.speedProxy { extra["speed"] = (s * 1000).rounded() / 1000 }
                if let side = g.side { extra["side"] = side.rawValue }
                if let mm = g.distanceMm { extra["distanceMm"] = (mm * 10).rounded() / 10 }
                onGesture(Gesture(name: g.name, time: g.time, confidence: g.confidence, extra: extra))
            case .tapClassified(let onset, let c):
                onTapType(onset, c.type?.rawValue)
            case .air(let a):
                var m: [String: Any] = ["type": "air", "t": Clock.protocolMs(a.time), "gesture": a.kind.rawValue,
                                        "phase": a.phase.rawValue, "value": (a.value * 1000).rounded() / 1000,
                                        "displacementMm": (a.displacementMm * 10).rounded() / 10,
                                        "confidence": (a.confidence * 1000).rounded() / 1000, "source": "sonar"]
                if let s = a.side { m["side"] = s.rawValue }
                if let dx = a.dxMm { m["dxMm"] = (dx * 10).rounded() / 10 }
                if let dy = a.dyMm { m["dyMm"] = (dy * 10).rounded() / 10 }
                if a.cancelled { m["cancelled"] = true }
                onAir(m)
            default:
                break
            }
        }
    }
}

// MARK: - sonar_debug

extension SoundSession {
    private static func r(_ v: Double, _ digits: Double = 10) -> Double { v.isFinite ? (v * digits).rounded() / digits : -999 }

    /// One `sonar_debug` message: per-side levels and tracker state since the previous message, gate states, and the
    /// real capture path. See the GhostkeysAcoustics README ("sonar_debug") for field meanings.
    func sonarDebugMessage(t: Double) -> [String: Any] {
        guard let processor, let session else { return ["type": "sonar_debug", "t": Clock.protocolMs(t), "running": false] }
        let d = processor.field.debugSnapshot()
        func side(_ s: SonarFieldDebug.Side) -> [String: Any] {
            ["hz": s.frequencyHz, "pilotDbfs": Self.r(s.pilotDbfs), "noiseDbfsPerBin": Self.r(s.noiseDbfsPerBin),
             "snrDb": Self.r(s.snrDb), "pilotPresent": s.pilotPresent,
             "sidebandLowDbc": Self.r(s.sidebandLowDbc), "sidebandHighDbc": Self.r(s.sidebandHighDbc),
             "dopplerShiftBins": [Self.r(s.dopplerLeftShiftBins), Self.r(s.dopplerRightShiftBins)],
             "pathDeltaMm": Self.r(s.pathDeltaMm, 100), "pathStepVarMm2": Self.r(s.pathStepVarianceMm2, 1000),
             "pathTotalMm": Self.r(s.pathTotalMm), "dynamicDb": Self.r(s.dynamicDb),
             "gateOpenShare": Self.r(s.gateOpenShare, 100)]
        }
        let i = session.inputPathInfo
        var input: [String: Any] = [
            "hardwareSampleRate": i.hardwareSampleRate, "measuredSampleRate": Self.r(i.measuredSampleRate),
            "channels": i.hardwareChannels, "format": i.hardwareFormat, "resampled": i.resampled,
            "voiceProcessing": i.voiceProcessingEnabled, "agc": i.voiceProcessingAGCEnabled,
            "voiceProcessingBypassed": i.voiceProcessingBypassed,
            "micMode": i.microphoneMode, "preferredMicMode": i.preferredMicrophoneMode,
            "bufferFrames": [i.minBufferFrames, i.maxBufferFrames], "maxTimestampGapMs": Self.r(i.maxTimestampGapMs, 100),
            "highBandRolloffDb": Self.r(d.highBandRolloffDb),
            // Rows: input channels, then the mono mix the detectors use. Columns: left pilot, right pilot (dBFS).
            "channelPilotDbfs": i.channelProbeDbfs.map { $0.map { Self.r($0) } },
            "channelRmsDbfs": i.channelRmsDbfs.map { Self.r($0) }]
        if let dev = i.device { input["device"] = dev.dictionary }
        var gates: [String: Any] = [
            "ready": d.ready, "warmedUp": d.warmedUp, "tonesPlaying": sonarFieldOn,
            "interference": d.interference, "suppressedByDaemon": d.suppressedByDaemon,
            "guardPeakDbfs": Self.r(d.guardPeakDbfs), "guardMedianDbfs": Self.r(d.guardMedianDbfs),
            "impulseBlocks": d.impulseBlocks, "restarts": d.restarts,
            "episode": d.episodeActive, "hover": d.hoverActive, "slide": d.slideActive]
        if let reason = d.interferenceReason { gates["interferenceReason"] = reason }
        if let toneProblem { gates["toneProblem"] = toneProblem }
        return ["type": "sonar_debug", "t": Clock.protocolMs(t), "windowS": Self.r(d.windowSeconds, 1000),
                "basebandSamples": d.basebandSamples, "left": side(d.left), "right": side(d.right),
                "gates": gates, "input": input]
    }
}

// MARK: - Tap-type calibration

extension SoundSession {
    static let tapTypeNames = TapType.allCases.map(\.rawValue)

    func beginTapCalibration() {
        calPending.removeAll()
        calExamples.removeAll()
    }

    func endTapCalibration() {
        calPending.removeAll()
        calExamples.removeAll()
    }

    /// An IMU onset (Clock seconds) that the user made as a `label` tap. The window is cut once its audio has arrived.
    func captureOnset(_ t: Double, label: String) {
        guard let type = TapType(rawValue: label), running else { return }
        if simulate {
            // No microphone in simulated sessions: run a synthetic tap of this type through the real feature extractor.
            let window = Self.syntheticTap(type, seed: UInt64(calExamples.count + calPending.count + 1))
            calExamples.append(LabeledTap(features: calExtractor.features(window), label: type))
            onCalibrationSample(label, true)
            return
        }
        calPending.append((t, type))
    }

    private func captureCalibrationWindows(ring: AudioRingBuffer) {
        guard !calPending.isEmpty, let range = ring.timeRange else { return }
        let radius = 0.015, pre = TapWindowAligner.preroll, win = TapFeatureExtractor.windowDuration
        var keep: [(t: Double, label: TapType)] = []
        for p in calPending {
            let start = p.t - radius - pre, end = p.t + radius + win
            if end > range.upperBound {
                if p.t - range.upperBound < 0.5 { keep.append(p) }       // audio not here yet
                continue
            }
            let count = Int(((end - start) * AcousticSession.sampleRate).rounded())
            if start >= range.lowerBound, let stretch = ring.read(from: start, count: count),
               let window = TapWindowAligner.window(from: stretch, samplesTime: start, expectedOnset: p.t, searchRadius: radius) {
                calExamples.append(LabeledTap(features: calExtractor.features(window), label: p.label))
                onCalibrationSample(p.label.rawValue, true)
            } else {
                onCalibrationSample(p.label.rawValue, false)             // no clear sound onset near the IMU tap
            }
        }
        calPending = keep
    }

    /// Trains, saves (tap-types.json, or tap-types.simulated.json in simulated sessions, so a test never replaces a
    /// real model) and installs the classifier in the running processor. Returns leave-one-out accuracy and counts.
    func trainTapTypes() throws -> (accuracy: Double, counts: [String: Int], path: String) {
        let model = try TapTypeClassifier.train(calExamples)
        let url = simulate ? tapModelURL.deletingPathExtension().appendingPathExtension("simulated.json") : tapModelURL
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let enc = JSONEncoder()
        try enc.encode(model).write(to: url, options: .atomic)
        let samplesURL = url.deletingLastPathComponent().appendingPathComponent(
            simulate ? "tap-type-samples.simulated.json" : "tap-type-samples.json")
        try enc.encode(calExamples).write(to: samplesURL, options: .atomic)
        if let processor {
            processor.tapClassifier = model
            processor.options.tapTypes = true
            tapTypesOn = true
        }
        let counts = Dictionary(grouping: calExamples, by: { $0.label.rawValue }).mapValues(\.count)
        return (model.leaveOneOutAccuracy(), counts, url.path)
    }

    /// Deterministic synthetic 40 ms tap: decaying noise, low-passed. Fingertip: dull and slow; knuckle: mid and fast;
    /// nail: bright click. Only used in simulated sessions (tests).
    static func syntheticTap(_ type: TapType, seed: UInt64) -> [Float] {
        let n = Int(TapFeatureExtractor.windowDuration * AcousticSession.sampleRate)
        let (tauMs, alpha): (Double, Float) = { switch type {
            case .fingertip: return (12, 0.08)
            case .knuckle: return (5, 0.35)
            case .nail: return (2, 0.9)
        } }()
        var state = seed &* 6364136223846793005 &+ 1442695040888963407
        var y: Float = 0
        var out = [Float](repeating: 0, count: n)
        let onset = Int(0.002 * AcousticSession.sampleRate)
        for i in onset..<n {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            let noise = Float(Int64(bitPattern: state >> 11) % 2000) / 1000 - 1
            let env = Float(exp(-Double(i - onset) / (tauMs * AcousticSession.sampleRate / 1000)))
            y += alpha * (noise - y)
            out[i] = 0.5 * env * y
        }
        return out
    }
}

/// `<default daemon dir>/mic.active` exists (with the daemon's pid) while a real microphone session is open, so
/// `ghostkeys-lab sonar-bench` can refuse to run at the same time. Removed on stop and at exit.
enum MicMarker {
    static var url: URL { ConfigStore.defaultDirectory.appendingPathComponent("mic.active") }
    /// At exit: remove the marker if this process wrote it.
    static func clearIfOurs() {
        guard let s = try? String(contentsOf: url, encoding: .utf8),
              Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) == getpid() else { return }
        try? FileManager.default.removeItem(at: url)
    }
    static func set(_ on: Bool) {
        if on { try? "\(getpid())\n".write(to: url, atomically: true, encoding: .utf8) }
        else { try? FileManager.default.removeItem(at: url) }
    }
}
