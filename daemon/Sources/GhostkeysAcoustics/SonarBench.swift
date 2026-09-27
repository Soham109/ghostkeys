// ============================================================================================================
// SonarBench: a ONE-TIME, USER-RUN hardware check for SonarField. It OPENS THE MICROPHONE and PLAYS the two
// inaudible pilot tones (capped at -30 dBFS combined) for at most 20 s. Never called by tests or by the daemon;
// only the lab tool calls it, and only after the user types the consent phrase.
// ============================================================================================================
import AVFoundation
import Foundation

public enum SonarBench {
    public static let maxDuration: Double = 20
    /// The exact text the user must type to proceed.
    public static let consentPhrase = "PLAY INAUDIBLE TONES"

    /// Text the lab tool must show before asking for consent.
    public static let disclosure = """
    SonarBench will, for up to 20 seconds:
      - open the microphone (the orange dot appears; macOS may ask for permission the first time);
      - play two inaudible tones (19.5 kHz left speaker, 20.25 kHz right speaker) at -30 dBFS combined, through the
        built-in speakers only (it refuses headphones, Bluetooth or anything unknown).
    Dogs, cats and some young people can hear 20 kHz tones. Nothing is recorded or saved; readings are printed live.
    While it runs, hold a hand still above one speaker, then raise and lower it, push toward a speaker, sweep across,
    and slide a finger along a grille.
    Type \(consentPhrase) to continue.
    """

    public struct Consent {
        public let granted: Bool
        /// Pass exactly what the user typed.
        public init(typed: String) { granted = typed.trimmingCharacters(in: .whitespacesAndNewlines) == SonarBench.consentPhrase }
    }

    public enum BenchError: Error, Equatable {
        case consentMissing
        case routeNotAllowed(OutputRoute)
        case microphoneDenied
    }

    public struct Report: Sendable {
        public var seconds: Double
        public var route: OutputRoute
        /// Median pilot level above local noise, dB (SonarField needs at least 15; the weaker side of an M5 Pro MacBook Pro measured 27 to 44).
        public var medianSnrLeftDb: Double
        public var medianSnrRightDb: Double
        /// Share of readings with interference flagged (music, other ultrasonic sources, loud noise).
        public var interferenceShare: Double
        /// Largest path change seen per side, mm (a moving hand should reach tens of mm).
        public var maxPathSwingLeftMm: Double
        public var maxPathSwingRightMm: Double
        /// Gesture names recognized during the run, in order.
        public var gestures: [String]
        public var airEvents: Int
    }

    /// Runs the check (blocking) and prints a reading every 250 ms through `printLine`.
    public static func run(consent: Consent, seconds: Double = 15,
                           printLine: @escaping (String) -> Void = { print($0) }) throws -> Report {
        guard consent.granted else { throw BenchError.consentMissing }
        let route = OutputRoute.current()
        guard route.allowsPilotTone else { throw BenchError.routeNotAllowed(route) }
        switch AcousticSession.microphoneAuthorization {
        case .denied, .restricted: throw BenchError.microphoneDenied
        default: break
        }
        let duration = min(max(1, seconds), maxDuration)

        var options = SoundModeProcessor.Options()
        options.sonarField = true
        options.sonar = false
        options.tapTypes = false
        let processor = SoundModeProcessor(options: options)
        let queue = DispatchQueue(label: "ghostkeys.sonarbench")
        var gestures: [String] = []
        var airEvents = 0
        let session = AcousticSession { chunk in
            queue.async {
                for e in processor.process(chunk.samples, time: chunk.time) {
                    switch e {
                    case .gesture(let g):
                        gestures.append(g.name)
                        printLine("  gesture \(g.name) side=\(g.side?.rawValue ?? "-") conf=\(fmt(g.confidence)) mm=\(fmt(g.distanceMm ?? 0))")
                    case .air(let a):
                        airEvents += 1
                        if a.phase != .changed { printLine("  air \(a.kind.rawValue) \(a.phase.rawValue) side=\(a.side?.rawValue ?? "-") mm=\(fmt(a.displacementMm))\(a.cancelled ? " cancelled" : "")") }
                    default: break
                    }
                }
            }
        }
        let generator = StereoPilotGenerator()
        try session.start()
        defer {
            session.stopPilotTone()
            Thread.sleep(forTimeInterval: 0.05) // let the 20 ms fade finish
            session.stop()
        }
        try session.startStereoPilots(generator)

        var snrL: [Double] = [], snrR: [Double] = []
        var interference = 0, readings = 0
        var minL = Double.infinity, maxL = -Double.infinity, minR = Double.infinity, maxR = -Double.infinity
        let start = Date()
        printLine("time  | L snr  R snr | L path mm  R path mm | L dyn  R dyn | state")
        while Date().timeIntervalSince(start) < duration {
            Thread.sleep(forTimeInterval: 0.25)
            let s = queue.sync { processor.field.status }
            readings += 1
            let l = Double(s.left.pilotDb - s.left.noiseDb), r = Double(s.right.pilotDb - s.right.noiseDb)
            snrL.append(l); snrR.append(r)
            if s.interference { interference += 1 }
            if s.warmedUp {
                minL = min(minL, s.left.pathMm); maxL = max(maxL, s.left.pathMm)
                minR = min(minR, s.right.pathMm); maxR = max(maxR, s.right.pathMm)
            }
            let state = s.ready ? "ready" : (!s.warmedUp ? "warming" : s.interference ? "interference"
                        : (!s.left.pilotPresent || !s.right.pilotPresent) ? "pilot missing" : "suppressed")
            printLine("\(fmt(Date().timeIntervalSince(start)))  | \(fmt(l))  \(fmt(r)) | \(fmt(s.left.pathMm))  \(fmt(s.right.pathMm)) | \(fmt(Double(s.left.dynamicDb)))  \(fmt(Double(s.right.dynamicDb))) | \(state)")
        }
        let done = queue.sync { (gestures, airEvents) }
        return Report(seconds: duration, route: route,
                      medianSnrLeftDb: Double(DSPMath.median(snrL.map(Float.init))),
                      medianSnrRightDb: Double(DSPMath.median(snrR.map(Float.init))),
                      interferenceShare: readings > 0 ? Double(interference) / Double(readings) : 0,
                      maxPathSwingLeftMm: maxL.isFinite ? maxL - minL : 0,
                      maxPathSwingRightMm: maxR.isFinite ? maxR - minR : 0,
                      gestures: done.0, airEvents: done.1)
    }

    private static func fmt(_ v: Double) -> String { String(format: "%6.1f", v) }
}
