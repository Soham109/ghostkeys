import Darwin
import Testing
@testable import GhostkeysAcoustics

@Suite struct FrictionDetectorTests {
    /// 0.5 s of quiet room, the signal, then 0.5 s of quiet room.
    static func scene(_ signal: [Float], seed: UInt64 = 7) -> [Float] {
        var rng = SeededRNG(seed)
        var x = Synth.noise(24_000, &rng, amplitude: 0.0003) + signal + Synth.noise(24_000, &rng, amplitude: 0.0003)
        let bg = Synth.noise(x.count, &rng, amplitude: 0.0003)
        for i in 0..<x.count { x[i] += bg[i] }
        return x
    }

    static func run(_ x: [Float], config: FrictionDetectorConfig = .init()) -> [FrictionEvent] {
        let d = FrictionDetector(config: config)
        return Synth.stream(x, chunk: 256) { d.process($0, time: $1) }
    }

    static func summaries(_ events: [FrictionEvent]) -> [RubSummary] {
        events.compactMap { if case .ended(let s) = $0 { return s }; return nil }
    }

    @Test func detectsASteadyRub() throws {
        var rng = SeededRNG(1)
        let events = Self.run(Self.scene(Synth.rub(duration: 0.6, &rng)))
        let rubs = Self.summaries(events)
        try #require(rubs.count == 1, "\(events)")
        let r = rubs[0]
        #expect(abs(r.duration - 0.6) < 0.1, "duration \(r.duration)")
        #expect(abs(r.startTime - 0.5) < 0.06, "start \(r.startTime)")
        #expect(r.direction == .unknown || r.directionConfidence < 0.7)
        #expect(events.first == .started(time: r.startTime))
        let g = SoundModeProcessor.gesture(for: r, config: .init())
        #expect(g.kind == .rub)
    }

    @Test func loudnessTrendGivesDirection() throws {
        var rng = SeededRNG(2)
        let rising = Self.summaries(Self.run(Self.scene(Synth.rub(duration: 0.8, trendDb: 14, &rng))))
        let falling = Self.summaries(Self.run(Self.scene(Synth.rub(duration: 0.8, trendDb: -14, &rng))))
        try #require(rising.count == 1 && falling.count == 1)
        #expect(rising[0].direction == .towardMics && rising[0].directionConfidence >= 0.7, "\(rising[0])")
        #expect(falling[0].direction == .awayFromMics && falling[0].directionConfidence >= 0.7, "\(falling[0])")
        // Mics on the left: getting louder means moving left.
        #expect(SoundModeProcessor.gesture(for: rising[0], config: .init()).kind == .rubLeft)
        #expect(SoundModeProcessor.gesture(for: falling[0], config: .init()).kind == .rubRight)
        var mirrored = FrictionDetectorConfig()
        mirrored.micSide = .right
        #expect(SoundModeProcessor.gesture(for: rising[0], config: mirrored).kind == .rubRight)
    }

    @Test func tooShortAndTooLongAreNotRubs() {
        var rng = SeededRNG(3)
        let short = Self.run(Self.scene(Synth.rub(duration: 0.08, &rng)))
        #expect(Self.summaries(short).isEmpty && short.isEmpty, "\(short)")
        let long = Self.run(Self.scene(Synth.rub(duration: 3.0, &rng)))
        #expect(Self.summaries(long).isEmpty)
        #expect(long.contains(.cancelled(time: long.compactMap { if case .cancelled(let t, _) = $0 { return t }; return nil }.first ?? -1, reason: .tooLong)))
    }

    @Test func typingIsNotARub() {
        var rng = SeededRNG(4)
        for rate in [6.0, 9.0, 14.0] {
            let events = Self.run(Self.scene(Synth.typing(duration: 3, rate: rate, &rng)))
            #expect(Self.summaries(events).isEmpty, "rate \(rate): \(events)")
        }
    }

    @Test func speechLikeHarmonicSoundIsNotARub() {
        var rng = SeededRNG(5)
        for bright in [false, true] {
            let events = Self.run(Self.scene(Synth.speechLike(duration: 1.2, bright: bright, &rng)))
            #expect(Self.summaries(events).isEmpty, "bright \(bright): \(events)")
        }
    }

    @Test func brightSpeechIsRejectedByHarmonicity() {
        // The high-passed voice sits in the friction band, so only the pitch test can reject it.
        var rng = SeededRNG(6)
        let d = FrictionDetector()
        var reasons: [String: Int] = [:]
        _ = Synth.stream(Self.scene(Synth.speechLike(duration: 1.2, bright: true, &rng)), chunk: 480) { chunk, t -> [Int] in
            _ = d.process(chunk, time: t)
            if let f = d.lastFrame, let r = f.rejectReason { reasons[r, default: 0] += 1 }
            return []
        }
        #expect((reasons["harmonic"] ?? 0) > 10, "\(reasons)")
    }

    @Test func musicLikeTonesAreNotARub() {
        let events = Self.run(Self.scene(Synth.musicLike(duration: 1.0)))
        #expect(Self.summaries(events).isEmpty, "\(events)")
    }

    @Test func silenceProducesNothing() {
        var rng = SeededRNG(8)
        #expect(Self.run(Synth.noise(96_000, &rng, amplitude: 0.0003)).isEmpty)
    }

    @Test func combToneGivesSpeedWithin15Percent() throws {
        var rng = SeededRNG(9)
        for combHz in [80.0, 180.0, 350.0, 600.0] {
            let rubs = Self.summaries(Self.run(Self.scene(Synth.rub(duration: 0.7, combHz: combHz, &rng))))
            try #require(rubs.count == 1, "comb \(combHz)")
            let est = try #require(rubs[0].combHz, "no comb found for \(combHz), strength \(rubs[0].combStrength)")
            #expect(abs(est - combHz) / combHz < 0.15, "true \(combHz) estimated \(est)")
            let speed = try #require(rubs[0].speedMetersPerSecond)
            #expect(abs(speed - est * FrictionDetectorConfig().grilleHolePitchMeters) < 1e-9)
        }
        // Plain friction (no grille) reports no comb.
        let plain = Self.summaries(Self.run(Self.scene(Synth.rub(duration: 0.7, &rng))))
        #expect(plain.first?.combHz == nil)
    }

    @Test func combEstimatorOnCleanEnvelope() throws {
        let rate = 4_000.0
        let env = (0..<4_000).map { Float(1 + 0.5 * sin(2 * Double.pi * 237 * Double($0) / rate)) }
        let r = try #require(FrictionDetector.estimateCombFrequency(envelope: env, envelopeRate: rate, minHz: 40, maxHz: 1_000))
        #expect(abs(r.hz - 237) / 237 < 0.03)
        #expect(r.strength > 0.8)
    }

    @Test func brighterRubHasHigherSpeedProxy() throws {
        var rng = SeededRNG(10)
        let slow = Self.summaries(Self.run(Self.scene(BiquadFilter(coefficients: BiquadFilter.lowpass(cutoff: 4_000, sampleRate: 48_000)).process(Synth.rub(duration: 0.6, levelDb: -25, &rng)))))
        let fast = Self.summaries(Self.run(Self.scene(Synth.rub(duration: 0.6, &rng))))
        try #require(slow.count == 1 && fast.count == 1)
        #expect(fast[0].speedProxy > slow[0].speedProxy)
    }
}
