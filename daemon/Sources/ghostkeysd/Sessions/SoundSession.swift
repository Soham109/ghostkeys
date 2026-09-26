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
    /// Returns an error message, or nil on success.
    func start(wantSonar: Bool, userInitiated: Bool, sonarField: Bool = false) -> String? {
        guard !running else { return nil }
        let classifier = (try? Data(contentsOf: tapModelURL)).flatMap { try? JSONDecoder().decode(TapTypeClassifier.self, from: $0) }
        var opts = SoundModeProcessor.Options()
        opts.sonar = wantSonar && !sonarField        // SonarField replaces the single pilot
        opts.sonarField = sonarField
        opts.tapTypes = classifier != nil
        let proc = SoundModeProcessor(options: opts, tapClassifier: classifier)
        tapTypesOn = classifier != nil

        if simulate {
            processor = proc
            sonarOn = wantSonar
            sonarFieldOn = sonarField
            Log.info("sound session started (simulated: no microphone opened)")
            return nil
        }
        guard Self.hardwarePresent else { return "no microphone on this Mac" }
        switch Self.permission {
        case "denied": return "microphone access is denied (System Settings > Privacy & Security > Microphone)"
        case "not_determined" where !userInitiated: return "microphone permission not granted yet; start a session from the app first"
        default: break
        }
        let s = AcousticSession { [weak self] chunk in
            self?.queue.async { self?.process(chunk) }
        }
        do { try s.start() } catch {
            return "could not open the microphone: \(error)"
        }
        session = s
        processor = proc
        sonarOn = false
        sonarFieldOn = false
        MicMarker.set(true)
        if sonarField {
            // The generator enforces its own limits (-30 dBFS combined, built-in speakers only, 60 s, 10 s cooldown).
            let g = StereoPilotGenerator()
            do {
                try s.startStereoPilots(g)
                stereo = g
                sonarFieldOn = true
                lastRenew = Clock.now()
            } catch {
                Log.info("sonar tones refused, running without sonar: \(error)")
            }
        } else if wantSonar {
            // The generator enforces its own limits (-30 dBFS, built-in speaker only, 60 s, 10 s cooldown).
            let g = PilotToneGenerator()
            do {
                try s.startPilotTone(g)
                pilot = g
                sonarOn = true
                lastRenew = Clock.now()
            } catch {
                Log.info("sonar off for this session: \(error)")
            }
        }
        Log.info("sound session started (microphone open\(sonarOn ? ", sonar on" : ""))")
        return nil
    }

    func stop() {
        if session != nil { MicMarker.set(false) }
        session?.stop()           // also stops the pilot tones immediately
        session = nil
        pilot = nil
        stereo = nil
        sonarFieldOn = false
        processor?.reset()
        processor = nil
        sonarOn = false
        tapTypesOn = false
    }

    /// Keep the pilot tone alive in long sessions (the generator stops itself after 60 s otherwise).
    func tick() {
        if let stereo, let session, sonarFieldOn, Clock.now() - lastRenew > 30 {
            if stereo.renew() { lastRenew = Clock.now() } else {
                session.stopPilotTone(immediately: true)
                sonarFieldOn = false
                Log.info("sonar stopped: output is no longer the built-in speakers")
            }
        }
        guard let pilot, let session, sonarOn, Clock.now() - lastRenew > 30 else { return }
        if pilot.renew() {
            lastRenew = Clock.now()
        } else {
            // renew() re-checks the output route; anything but the built-in speaker stops the tone.
            session.stopPilotTone(immediately: true)
            sonarOn = false
            Log.info("sonar stopped: output is no longer the built-in speaker")
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
