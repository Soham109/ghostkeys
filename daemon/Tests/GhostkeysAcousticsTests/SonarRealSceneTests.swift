import Darwin
import Testing
@testable import GhostkeysAcoustics

/// SonarField on a REAL static recording from the M5 Pro MacBook Pro (tones on, nobody there, volume slider at 19%)
/// with synthetic hand echoes on top (`RealScene`). Skipped when the recording is not on disk.
@Suite(.enabled(if: RealRecording.exists("static_run1.wav"))) struct SonarRealSceneTests {
    typealias P = SIMD3<Double>
    static let recording = RealRecording.load("static_run1.wav") ?? []
    static let scene = RealScene(recording: recording)

    struct Result {
        var gestures: [AcousticGesture] = []
        var air: [AcousticAirEvent] = []
        var snaps: [SonarFieldDebug] = []
    }

    /// Config under test; SONAR_CFG="gateOverFloorDb=6,minTrackedShare=0.5" overrides numeric fields (tuning runs).
    static func config() -> SonarFieldConfig {
        var c = SonarFieldConfig()
        guard let raw = getenv("SONAR_CFG").map({ String(cString: $0) }) else { return c }
        for item in raw.split(separator: ",") {
            let kv = item.split(separator: "="); guard kv.count == 2, let v = Double(kv[1]) else { continue }
            switch kv[0] {
            case "gateOverFloorDb": c.gateOverFloorDb = v
            case "minTrackedShare": c.minTrackedShare = v
            case "pushMinPathMm": c.pushMinPathMm = v
            case "hoverMinPathMm": c.hoverMinPathMm = v
            case "hoverMinProgressMm": c.hoverMinProgressMm = v
            case "movingSpeedMmPerSec": c.movingSpeedMmPerSec = v
            case "staticTimeConstant": c.staticTimeConstant = v
            case "basebandLowpassHz": c.basebandLowpassHz = v
            case "gatePowerSmoothing": c.gatePowerSmoothing = v
            case "burstVoidDb": c.burstVoidDb = v
            case "sweepMinDiffMm": c.sweepMinDiffMm = v
            case "pushMaxDuration": c.pushMaxDuration = v
            case "minCoherence": c.minCoherence = v
            case "minEpisodeCoherence": c.minEpisodeCoherence = v
            default: print("unknown SONAR_CFG key \(kv[0])")
            }
        }
        return c
    }

    static func run(_ x: [Float], field: SonarField = SonarField(config: config()), suppress: [(Double, Double)] = []) -> Result {
        var r = Result()
        var nextSnap = 0.1
        _ = Synth.stream(x, chunk: 480, startTime: 100) { (c: UnsafeBufferPointer<Float>, t: Double) -> [Int] in
            for (a, b) in suppress where t >= 100 + a && t < 100 + b { field.suppress(until: t + 0.45) }
            for e in field.process(c, time: t) {
                switch e {
                case .gesture(let g): r.gestures.append(g)
                case .air(let a): r.air.append(a)
                default: break
                }
            }
            if t - 100 >= nextSnap { nextSnap += 0.1; r.snaps.append(field.debugSnapshot()) }
            return []
        }
        return r
    }

    static func summary(_ r: Result) -> String {
        let s = r.snaps.dropFirst(10)
        func med(_ v: [Double]) -> Double { let x = v.sorted(); return x.isEmpty ? .nan : x[x.count / 2] }
        return String(format: "ready %.2f interference %.2f (reasons %@) impulses/snap %.0f bursts %d gateL %.2f gateR %.2f snrL %.1f snrR %.1f pilotL %.1f pilotR %.1f pathL %.1f pathR %.1f",
                      Double(s.filter(\.ready).count) / Double(max(1, s.count)),
                      Double(s.filter(\.interference).count) / Double(max(1, s.count)),
                      Set(s.compactMap(\.interferenceReason)).sorted().joined(separator: ","),
                      med(s.map { Double($0.impulseBlocks) }), s.map(\.burstFrames).reduce(0, +),
                      med(s.map(\.left.gateOpenShare)), med(s.map(\.right.gateOpenShare)),
                      med(s.map(\.left.snrDb)), med(s.map(\.right.snrDb)),
                      med(s.map(\.left.pilotDbfs)), med(s.map(\.right.pilotDbfs)),
                      s.last?.left.pathTotalMm ?? 0, s.last?.right.pathTotalMm ?? 0)
    }

    static let reports = getenv("SONAR_REPORT") != nil

    @Test(.enabled(if: reports)) func staticRecordingDiagnostics() {
        let r = Self.run(Self.scene.render(duration: 10, hand: nil))
        print("STATIC:", Self.summary(r), "gestures", r.gestures.map(\.kind), "air", r.air.count)
        for d in r.snaps.prefix(40) {
            print(String(format: "  guard peak %.1f median %.1f pilotL %.1f pilotR %.1f %@ gate %.2f/%.2f",
                         d.guardPeakDbfs, d.guardMedianDbfs, d.left.pilotDbfs, d.right.pilotDbfs, d.interferenceReason ?? "-",
                         d.left.gateOpenShare, d.right.gateOpenShare))
        }
    }

    /// Every static recording (30 s of a still room): nothing may fire.
    static func staticFalseTriggers() -> [String] {
        var out: [String] = []
        for (name, pilots) in [("static_run1.wav", (19_500.0, 20_250.0)), ("static_run2_swapped.wav", (20_250.0, 19_500.0)),
                               ("static_run3_lowload.wav", (19_500.0, 20_250.0)), ("static_run6_final.wav", (19_500.0, 20_250.0))] {
            guard let x = RealRecording.load(name) else { continue }
            var c = config()
            c.leftPilotHz = pilots.0; c.rightPilotHz = pilots.1
            let r = run(x, field: SonarField(config: c))
            out.append("\(name): gestures \(r.gestures.map { "\($0.kind.rawValue)@\(Int(($0.time - 100) * 10))" }) hovers \(r.air.filter { $0.phase == .began }.map { "\($0.kind.rawValue)@\(Int(($0.time - 100) * 10))" }) | \(summary(r))")
        }
        return out
    }

    /// Typing on top of the real recording, with no daemon suppression at all (worst case): key clicks are loud,
    /// broadband and reach the pilots' band.
    static func typingFalseTriggers(seed: UInt64 = 21) -> [String] {
        var rng = SeededRNG(seed)
        var out: [String] = []
        for off in [0.0, 5.0] {
            var x = scene.render(offset: off, duration: 5, hand: { _ in FieldGeometry.leftSpeaker + SIMD3(0.12, 0.02, 0.10) }, relativeDb: -30)
            Synth.add(&x, Synth.typing(duration: 4.2, rate: 8, &rng), at: 36_000)
            let r = run(x)
            let fired = r.gestures.map(\.kind.rawValue) + r.air.filter { $0.phase == .began }.map(\.kind.rawValue)
            out.append("offset \(off): \(fired)")
        }
        return out
    }

    @Test(.enabled(if: reports)) func staticFalseTriggerReport() {
        for line in Self.typingFalseTriggers() { print("TYPING:", line) }
        for line in Self.staticFalseTriggers() { print("FALSE:", line) }
    }

    // MARK: Checks (these run in the normal suite)

    @Test func staticRecordingsNeverFire() {
        for line in Self.staticFalseTriggers() {
            #expect(line.contains("gestures [] hovers []"), "\(line)")
        }
        let r = Self.run(Self.recording)
        let s = r.snaps.dropFirst(10)
        #expect(Double(s.filter(\.ready).count) >= 0.8 * Double(s.count), "ready only \(s.filter(\.ready).count) of \(s.count)")
    }

    @Test func typingOnTheRealRecordingNeverFires() {
        for line in Self.typingFalseTriggers() { #expect(line.hasSuffix("[]"), "\(line)") }
    }

    /// What a live static run showed on the weak right pilot: bursts of noise right at 20.25 kHz, 5 to 13 dB over its
    /// floor, opening the gate on and off for seconds. Random-sign path steps must not add up to a gesture.
    static func pilotBandNoiseTriggers(levelDbfs: Double, seed: UInt64) -> [String] {
        var rng = SeededRNG(seed)
        var out: [String] = []
        for name in ["static_run1.wav", "static_run3_lowload.wav"] {
            guard var x = RealRecording.load(name) else { continue }
            var noise = Synth.noise(x.count, &rng)
            let bp = BiquadFilter.bandpass(center: 20_250, q: 60, sampleRate: 48_000)
            noise = Synth.filter(noise, bp + bp)
            noise = Synth.scaled(noise, toRms: Float(pow(10, levelDbfs / 20) / 2.0.squareRoot()))
            var i = 0
            while i < x.count {
                let on = Int(rng.range(0.1, 0.4) * 48_000), off = Int(rng.range(0.05, 0.6) * 48_000)
                for k in i..<min(x.count, i + on) { x[k] += noise[k] }
                i += on + off
            }
            let r = run(x)
            out.append("\(name) \(Int(levelDbfs)) dBFS: \(r.gestures.map(\.kind.rawValue) + r.air.filter { $0.phase == .began }.map(\.kind.rawValue))")
        }
        return out
    }

    @Test func noiseAtTheWeakPilotDoesNotAddUpToGestures() {
        for level in [-112.0, -106.0, -100.0, -94.0] {
            for line in Self.pilotBandNoiseTriggers(levelDbfs: level, seed: 5) {
                print("PILOT NOISE:", line)
                #expect(line.hasSuffix("[]"), "\(line)")
            }
        }
    }

    @Test func strongEchoesAreFoundWhenTheVolumeIsHigher() {
        // +30 dB over the recorded 19% volume, echoes 30 dB under the direct path, three stretches of real noise.
        let m = Self.matrix(volumeGainDb: 30, levels: [-30], offsets: [0, 3.3, 6.6])
        print("REAL SCENES +30 dB, -30 dB echoes: ok \(m.ok)/\(m.total), wrong \(m.wrong)\n\(m.table)")
        #expect(m.ok >= 10, "\(m.table)")
        #expect(m.wrong <= 7, "\(m.table)")
    }

    @Test func atTheRecordedVolumeItStaysQuiet() {
        let m = Self.matrix(volumeGainDb: 0, levels: [-30], offsets: [0, 3.3, 6.6])
        #expect(m.wrong <= 1, "\(m.table)")
    }

    // MARK: Gesture scenes

    static let aboveLeft = FieldGeometry.leftSpeaker, aboveRight = FieldGeometry.rightSpeaker
    static func move(_ a: P, _ b: P, at start: Double = 1.2, over: Double) -> (Double) -> P {
        { t in Synth.lerp(a, b, Synth.ease(t, start, start + over)) }
    }

    enum Expect: Equatable { case gesture(AcousticGestureKind), hover(SpeakerSide) }
    struct Case { var name: String; var hand: (Double) -> P; var expect: Expect; var duration = 3.4 }

    static let cases: [Case] = [
        Case(name: "hover up L", hand: move(aboveLeft + P(0, 0, 0.12), aboveLeft + P(0, 0, 0.22), over: 1.0), expect: .hover(.left)),
        Case(name: "hover down L", hand: move(aboveLeft + P(0, 0, 0.25), aboveLeft + P(0, 0, 0.13), over: 1.0), expect: .hover(.left)),
        Case(name: "hover up R", hand: move(aboveRight + P(0, 0, 0.12), aboveRight + P(0, 0, 0.22), over: 1.0), expect: .hover(.right)),
        Case(name: "push L", hand: move(aboveLeft + P(0, 0, 0.25), aboveLeft + P(0, 0, 0.12), over: 0.3), expect: .gesture(.push), duration: 2.6),
        Case(name: "pull L", hand: move(aboveLeft + P(0, 0, 0.12), aboveLeft + P(0, 0, 0.25), over: 0.3), expect: .gesture(.pull), duration: 2.6),
        Case(name: "push R", hand: move(aboveRight + P(0, 0, 0.25), aboveRight + P(0, 0, 0.12), over: 0.3), expect: .gesture(.push), duration: 2.6),
        Case(name: "pull R", hand: move(aboveRight + P(0, 0, 0.12), aboveRight + P(0, 0, 0.26), over: 0.3), expect: .gesture(.pull), duration: 2.6),
        Case(name: "sweep right", hand: move(P(-0.30, 0.08, 0.12), P(0.30, 0.08, 0.12), over: 0.6), expect: .gesture(.sweepRight), duration: 2.8),
        Case(name: "sweep left", hand: move(P(0.30, 0.10, 0.15), P(-0.30, 0.10, 0.15), over: 0.5), expect: .gesture(.sweepLeft), duration: 2.8),
    ]

    /// Outcome of one scene: right, missed, or wrong (anything else fired).
    static func score(_ r: Result, _ e: Expect) -> String {
        let hovers = r.air.filter { $0.kind == .hoverLevel && $0.phase == .began }
        switch e {
        case .hover(let side):
            if !r.gestures.isEmpty { return "wrong" }
            if hovers.contains(where: { $0.side == side }) { return "ok" }
            return hovers.isEmpty ? "miss" : "wrong"
        case .gesture(let k):
            if r.gestures.map(\.kind) == [k] && hovers.isEmpty { return "ok" }
            return r.gestures.isEmpty && hovers.isEmpty ? "miss" : "wrong"
        }
    }

    static func matrix(volumeGainDb: Double, levels: [Double], offsets: [Double]) -> (table: String, ok: Int, wrong: Int, total: Int) {
        let split = (getenv("SONAR_SPLIT").map { String(cString: $0) } ?? "0,0").split(separator: ",").compactMap { Double($0) }
        let scene = volumeGainDb == 0 && split == [0, 0] ? Self.scene
            : RealScene(recording: recording, volumeGainDb: volumeGainDb, leftGainDb: split[0], rightGainDb: split[1])
        var lines: [String] = [], ok = 0, wrong = 0, total = 0
        var details: [String] = []
        for c in cases {
            var row = c.name.padding(toLength: 13, withPad: " ", startingAt: 0)
            for level in levels {
                var cell = ""
                for off in offsets {
                    let r = run(scene.render(offset: off, duration: c.duration, hand: c.hand, relativeDb: level))
                    let s = score(r, c.expect)
                    total += 1
                    if s == "ok" { ok += 1; cell += "+" } else if s == "miss" { cell += "." } else {
                        wrong += 1; cell += "x"
                        if getenv("SONAR_VERBOSE") != nil {
                            details.append("    \(c.name) \(Int(level)) dB @\(off): \(r.gestures.map { "\($0.kind.rawValue)/\($0.side?.rawValue ?? "-")" }) hovers \(r.air.filter { $0.kind == .hoverLevel && $0.phase == .began }.map { $0.side?.rawValue ?? "-" })")
                        }
                    }
                }
                row += " \(Int(level)):\(cell)"
            }
            lines.append(row)
        }
        return ((lines + details).joined(separator: "\n"), ok, wrong, total)
    }

    /// SONAR_REPORT=1 (optionally SONAR_GAINS=0,15,30 SONAR_VERBOSE=1 SONAR_CFG=... SONAR_SPLIT=l,r): the full table.
    @Test(.enabled(if: reports)) func sceneMatrixReport() {
        let gains = (getenv("SONAR_GAINS").map { String(cString: $0) } ?? "0,15").split(separator: ",").compactMap { Double($0) }
        for gain in gains {
            let m = Self.matrix(volumeGainDb: gain, levels: [-30, -35, -40, -45], offsets: [0, 3.3, 6.6])
            print("MATRIX volume +\(Int(gain)) dB (+ right, . missed, x wrong): ok \(m.ok)/\(m.total), wrong \(m.wrong)\n\(m.table)")
        }
    }

    /// SONAR_CASE=n [SONAR_GAIN SONAR_OFF SONAR_LEVEL]: per-0.1 s trace of one scene.
    @Test(.enabled(if: getenv("SONAR_CASE") != nil)) func traceOneScene() {
        let env = { (k: String, d: String) in getenv(k).map { String(cString: $0) } ?? d }
        let c = Self.cases[Int(env("SONAR_CASE", "3"))!]
        let gain = Double(env("SONAR_GAIN", "0"))!, off = Double(env("SONAR_OFF", "0"))!, level = Double(env("SONAR_LEVEL", "-30"))!
        let scene = gain == 0 ? Self.scene : RealScene(recording: Self.recording, volumeGainDb: gain)
        let r = Self.run(scene.render(offset: off, duration: c.duration, hand: c.hand, relativeDb: level))
        print("TRACE \(c.name) +\(Int(gain)) dB @\(off) \(Int(level)) dB: gestures \(r.gestures.map { "\($0.kind.rawValue)/\($0.side?.rawValue ?? "-")" }) hovers \(r.air.filter { $0.phase == .began }.map { $0.side?.rawValue ?? "-" })")
        for (i, d) in r.snaps.enumerated() where i >= 6 {
            print(String(format: "  t %.1f L over %5.1f gate %.2f dPath %6.1f | R over %5.1f gate %.2f dPath %6.1f | ready %@ %@ ep %@ hov %@",
                         Double(i + 1) * 0.1, d.left.overFloorDb, d.left.gateOpenShare, d.left.pathDeltaMm,
                         d.right.overFloorDb, d.right.gateOpenShare, d.right.pathDeltaMm, d.ready ? "Y" : "n", d.interferenceReason ?? "", d.episodeActive ? "Y" : "n", d.hoverActive ? "Y" : "n"))
        }
    }
}
