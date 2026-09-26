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
    private var lastRenew = 0.0
    private(set) var sonarOn = false
    private(set) var tapTypesOn = false

    var onGesture: (Gesture) -> Void = { _ in }
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
    func start(wantSonar: Bool, userInitiated: Bool) -> String? {
        guard !running else { return nil }
        let classifier = (try? Data(contentsOf: tapModelURL)).flatMap { try? JSONDecoder().decode(TapTypeClassifier.self, from: $0) }
        var opts = SoundModeProcessor.Options()
        opts.sonar = wantSonar
        opts.tapTypes = classifier != nil
        let proc = SoundModeProcessor(options: opts, tapClassifier: classifier)
        tapTypesOn = classifier != nil

        if simulate {
            processor = proc
            sonarOn = wantSonar
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
        if wantSonar {
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
        session?.stop()           // also stops the pilot tone immediately
        session = nil
        pilot = nil
        processor?.reset()
        processor = nil
        sonarOn = false
        tapTypesOn = false
    }

    /// Keep the pilot tone alive in long sessions (the generator stops itself after 60 s otherwise).
    func tick() {
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

    private func process(_ chunk: AcousticSession.Chunk) {
        guard let processor, session != nil else { return }
        for event in processor.process(chunk.samples, time: chunk.time) {
            switch event {
            case .gesture(let g):
                var extra: [String: Any] = [:]
                if let d = g.duration { extra["duration"] = (d * 1000).rounded() / 1000 }
                if let s = g.speedProxy { extra["speed"] = (s * 1000).rounded() / 1000 }
                onGesture(Gesture(name: g.name, time: g.time, confidence: g.confidence, extra: extra))
            case .tapClassified(let onset, let c):
                onTapType(onset, c.type?.rawValue)
            default:
                break
            }
        }
    }
}
