import Darwin
import Testing
@testable import GhostkeysAcoustics

@Suite struct SonarFieldTests {
    typealias P = SIMD3<Double>
    static let aboveLeft = P(-0.145, 0.08, 0)
    static let aboveRight = P(0.145, 0.08, 0)

    static func run(_ x: [Float], field: SonarField = SonarField()) -> [SonarFieldEvent] {
        Synth.stream(x, chunk: 256) { field.process($0, time: $1) }
    }
    static func gestures(_ e: [SonarFieldEvent]) -> [AcousticGesture] { e.compactMap { if case .gesture(let g) = $0 { return g }; return nil } }
    static func air(_ e: [SonarFieldEvent]) -> [AcousticAirEvent] { e.compactMap { if case .air(let a) = $0 { return a }; return nil } }

    /// Hand held still, moved from `a` to `b` over `moveTime` starting at 1.2 s, then held again.
    static func move(_ a: P, _ b: P, moveTime: Double, total: Double = 3.4) -> (Double) -> P {
        { t in Synth.lerp(a, b, Synth.ease(t, 1.2, 1.2 + moveTime)) }
    }

    @Test func pilotsAreOnTheDemodulationGridAndBinAligned() {
        let c = SonarFieldConfig()
        let f = SonarField()
        for hz in [f.pilotFrequencies.left, f.pilotFrequencies.right] {
            let grid = c.sampleRate / Double(c.decimation) // 750 Hz: the demodulation filter's null spacing
            #expect((hz / grid).rounded() == hz / grid)
            let bin = hz / (c.sampleRate / Double(c.fftSize))
            #expect(bin.rounded() == bin)
        }
        #expect(f.pilotFrequencies == (19_500, 20_250))
    }

    @Test func stillHandProducesNothing() {
        var rng = SeededRNG(1)
        let events = Self.run(Synth.field(duration: 3, hand: { _ in P(-0.1, 0.1, 0.15) }, &rng))
        #expect(Self.gestures(events).isEmpty && Self.air(events).isEmpty, "\(events)")
    }

    @Test func hoverSliderTracksPathWithin20Percent() throws {
        // (start, end) hand positions: 5 to 20 cm vertical moves above each speaker, up and down.
        let cases: [(P, P, SpeakerSide)] = [
            (Self.aboveLeft + P(0, 0, 0.10), Self.aboveLeft + P(0, 0, 0.15), .left),   // 5 cm up
            (Self.aboveLeft + P(0, 0, 0.10), Self.aboveLeft + P(0, 0, 0.30), .left),   // 20 cm up
            (Self.aboveLeft + P(0, 0, 0.25), Self.aboveLeft + P(0, 0, 0.15), .left),   // 10 cm down
            (Self.aboveRight + P(0, 0, 0.10), Self.aboveRight + P(0, 0, 0.20), .right), // 10 cm up
            (Self.aboveRight + P(0, 0, 0.28), Self.aboveRight + P(0, 0, 0.12), .right), // 16 cm down
        ]
        var rng = SeededRNG(2)
        for (a, b, side) in cases {
            let field = SonarField()
            let events = Self.run(Synth.field(duration: 3.4, hand: Self.move(a, b, moveTime: 1.0), &rng), field: field)
            let hover = Self.air(events).filter { $0.kind == .hoverLevel }
            let label = "\(a) -> \(b)"
            try #require(hover.first?.phase == .began, "no hover for \(label): \(events)")
            #expect(hover.last?.phase == .ended, "\(label)")
            #expect(hover.allSatisfy { $0.side == side && !$0.cancelled }, "\(label): \(hover.map { ($0.side, $0.cancelled) })")
            #expect(Self.gestures(events).isEmpty, "\(label): \(Self.gestures(events))")
            let truth = side == .left ? FieldGeometry.paths(b).left - FieldGeometry.paths(a).left
                                      : FieldGeometry.paths(b).right - FieldGeometry.paths(a).right
            let estimate = 2 * hover.last!.displacementMm / 1000
            #expect(abs(estimate - truth) / abs(truth) < 0.2, "\(label): true path \(truth) m, estimated \(estimate) m")
            #expect((hover.last!.value > 0) == (b.z > a.z), "raising must give a positive value")
            // The raw per-side path follows the truth too.
            let raw = (side == .left ? field.status.left.pathMm : field.status.right.pathMm) / 1000
            #expect(abs(raw - truth) / abs(truth) < 0.2, "\(label): raw path \(raw) vs \(truth)")
        }
    }

    @Test func handDisplacementAboveLeftSpeakerWithin20Percent() throws {
        // Above the left speaker (near the mics) half the path change is close to the hand's own movement.
        var rng = SeededRNG(3)
        for dz in [0.05, 0.10, 0.20] {
            let a = Self.aboveLeft + P(0, 0, 0.10), b = a + P(0, 0, dz)
            let hover = Self.air(Self.run(Synth.field(duration: 3.4, hand: Self.move(a, b, moveTime: 1.0), &rng)))
            let mm = try #require(hover.last?.displacementMm)
            #expect(abs(mm / 1000 - dz) / dz < 0.2, "moved \(dz) m, estimated \(mm) mm")
        }
    }

    @Test func quickMovesArePushAndPull() throws {
        var rng = SeededRNG(4)
        let push = Self.gestures(Self.run(Synth.field(duration: 2.6, hand: Self.move(Self.aboveLeft + P(0, 0, 0.25), Self.aboveLeft + P(0, 0, 0.12), moveTime: 0.3), &rng)))
        #expect(push.map(\.kind) == [.push], "\(push)")
        #expect(push.first?.side == .left)
        let pull = Self.gestures(Self.run(Synth.field(duration: 2.6, hand: Self.move(Self.aboveRight + P(0, 0, 0.12), Self.aboveRight + P(0, 0, 0.26), moveTime: 0.3), &rng)))
        #expect(pull.map(\.kind) == [.pull], "\(pull)")
        #expect(pull.first?.side == .right)
    }

    @Test func passesAcrossAreSweeps() {
        var rng = SeededRNG(5)
        let right = Self.gestures(Self.run(Synth.field(duration: 2.8, hand: Self.move(P(-0.30, 0.08, 0.12), P(0.30, 0.08, 0.12), moveTime: 0.6), &rng)))
        #expect(right.map(\.kind) == [.sweepRight], "\(right)")
        let left = Self.gestures(Self.run(Synth.field(duration: 2.8, hand: Self.move(P(0.30, 0.10, 0.15), P(-0.30, 0.10, 0.15), moveTime: 0.5), &rng)))
        #expect(left.map(\.kind) == [.sweepLeft], "\(left)")
    }

    @Test func pilotsAreSeparatedByFrequency() {
        // Only the left pilot echoes: the right side must stay still even though both share one mic channel.
        var rng = SeededRNG(6)
        let field = SonarField()
        let a = Self.aboveLeft + P(0, 0, 0.10), b = a + P(0, 0, 0.15)
        _ = Self.run(Synth.field(duration: 3.4, hand: Self.move(a, b, moveTime: 1.0), reflect: [.left], &rng), field: field)
        #expect(abs(field.status.left.pathMm) > 200)
        #expect(abs(field.status.right.pathMm) < 0.05 * abs(field.status.left.pathMm), "right drifted \(field.status.right.pathMm) mm")
    }

    @Test func clockDriftIsCorrected() throws {
        var rng = SeededRNG(7)
        let still = Self.run(Synth.field(duration: 3, hand: { _ in P(-0.1, 0.1, 0.15) }, driftHz: 0.4, &rng))
        #expect(Self.gestures(still).isEmpty && Self.air(still).isEmpty, "\(still)")
        let a = Self.aboveLeft + P(0, 0, 0.10), b = a + P(0, 0, 0.12)
        let events = Self.run(Synth.field(duration: 3.4, hand: Self.move(a, b, moveTime: 1.0), driftHz: 0.4, &rng))
        let hover = Self.air(events).filter { $0.kind == .hoverLevel }
        let truth = FieldGeometry.paths(b).left - FieldGeometry.paths(a).left
        let mm = try #require(hover.last?.displacementMm)
        #expect(abs(2 * mm / 1000 - truth) / truth < 0.2, "with drift: \(2 * mm) mm vs \(truth * 1000) mm")
    }

    @Test func musicNearThePilotsSuppressesEverything() {
        var rng = SeededRNG(8)
        let a = Self.aboveLeft + P(0, 0, 0.10), b = a + P(0, 0, 0.15)
        var x = Synth.field(duration: 3.4, hand: Self.move(a, b, moveTime: 1.0), &rng)
        for i in x.indices {
            let t = Double(i) / 48_000
            x[i] += Float(0.003 * (sin(2 * .pi * 19_020 * t) + sin(2 * .pi * 20_790 * t + 1)))
        }
        let field = SonarField()
        let events = Self.run(x, field: field)
        #expect(Self.gestures(events).isEmpty && Self.air(events).isEmpty, "\(events)")
        #expect(field.status.interference)
    }

    @Test func typingDoesNotMakeGestures() {
        var rng = SeededRNG(9)
        var x = Synth.field(duration: 4, hand: { _ in P(-0.02, 0.12, 0.08) }, &rng)
        Synth.add(&x, Synth.typing(duration: 3.4, rate: 10, &rng), at: 24_000)
        let events = Self.run(x)
        #expect(Self.gestures(events).isEmpty && Self.air(events).isEmpty, "\(events)")
    }

    @Test func externalSuppressionCancelsAndBlocks() {
        var rng = SeededRNG(10)
        let field = SonarField()
        field.suppress(until: 10)
        let events = Self.run(Synth.field(duration: 2.6, hand: Self.move(Self.aboveLeft + P(0, 0, 0.25), Self.aboveLeft + P(0, 0, 0.12), moveTime: 0.3), &rng), field: field)
        #expect(Self.gestures(events).isEmpty && Self.air(events).isEmpty, "\(events)")
        #expect(field.status.suppressed)
    }

    @Test func noPilotsNoGestures() {
        var rng = SeededRNG(11)
        let field = SonarField()
        let events = Self.run(Synth.noise(96_000, &rng, amplitude: 0.01), field: field)
        #expect(events.isEmpty)
        #expect(!field.status.ready)
    }
}

@Suite struct FingerSlideTests {
    typealias P = SIMD3<Double>

    static func processor() -> SoundModeProcessor {
        var o = SoundModeProcessor.Options()
        o.sonarField = true
        o.tapTypes = false
        return SoundModeProcessor(options: o)
    }

    /// A fingertip touching the surface (z = 5 mm) slides from `a` to `b` over 0.45 s starting at 1.3 s. With
    /// `touching`, friction noise plays during the slide.
    static func scene(_ a: P, _ b: P, touching: Bool, seed: UInt64) -> [Float] {
        var rng = SeededRNG(seed)
        var x = Synth.field(duration: 3.2, hand: { t in Synth.lerp(a, b, Synth.ease(t, 1.3, 1.75)) }, reflectionDb: -28, &rng)
        if touching { Synth.add(&x, Synth.quietRub(duration: 0.5, &rng), at: Int(1.28 * 48_000)) }
        return x
    }

    static func run(_ x: [Float]) -> [AcousticEvent] {
        let p = processor()
        return Synth.stream(x, chunk: 256) { p.process($0, time: $1) }
    }

    static func slides(_ e: [AcousticEvent]) -> [AcousticGestureKind] {
        e.compactMap { if case .gesture(let g) = $0, g.name.hasPrefix("finger_slide") { return g.kind }; return nil }
    }

    @Test func slidesInFourDirections() {
        let cases: [(P, P, AcousticGestureKind)] = [
            (P(-0.145, 0.11, 0.005), P(-0.145, 0.05, 0.005), .fingerSlideUp),     // along the left grille, toward the hinge
            (P(-0.145, 0.05, 0.005), P(-0.145, 0.11, 0.005), .fingerSlideDown),
            (P(-0.03, 0.15, 0.005), P(0.03, 0.15, 0.005), .fingerSlideRight),     // across the palm rest
            (P(0.03, 0.15, 0.005), P(-0.03, 0.15, 0.005), .fingerSlideLeft),
        ]
        for (i, (a, b, kind)) in cases.enumerated() {
            let events = Self.run(Self.scene(a, b, touching: true, seed: UInt64(20 + i)))
            #expect(Self.slides(events) == [kind], "\(a) -> \(b): \(Self.slides(events))")
            let air = events.compactMap { e -> AcousticAirEvent? in if case .air(let a) = e, a.kind == .fingerSlide { return a }; return nil }
            #expect(air.first?.phase == .began && air.last?.phase == .ended, "\(air.map(\.phase))")
            let other = events.compactMap { e -> AcousticGestureKind? in
                if case .gesture(let g) = e, [.push, .pull, .sweepLeft, .sweepRight].contains(g.kind) { return g.kind }; return nil }
            #expect(other.isEmpty, "contact must block air gestures: \(other)")
        }
    }

    @Test func hoveringFingerWithoutContactIsNotASlide() {
        let events = Self.run(Self.scene(P(-0.145, 0.11, 0.005), P(-0.145, 0.05, 0.005), touching: false, seed: 30))
        #expect(Self.slides(events).isEmpty)
    }

    @Test func rubWithoutMovementIsNotASlide() {
        let events = Self.run(Self.scene(P(-0.145, 0.08, 0.005), P(-0.145, 0.08, 0.005), touching: true, seed: 31))
        #expect(Self.slides(events).isEmpty, "\(Self.slides(events))")
        #expect(events.contains { if case .rubEnded = $0 { return true }; return false }, "the rub itself should still be detected")
    }
}

@Suite struct StereoPilotGeneratorTests {
    final class FakeClock: @unchecked Sendable { var now = 1_000.0 }

    static func make(route: OutputRoute = .builtInSpeaker, left: Float = SpeakerSafety.maxAmplitude / 2,
                     right: Float = SpeakerSafety.maxAmplitude / 2, clock: FakeClock = FakeClock()) -> StereoPilotGenerator {
        StereoPilotGenerator(leftAmplitude: left, rightAmplitude: right, routeCheck: { route }, clock: { clock.now })
    }

    @Test func eachChannelAndTheSumAreCapped() throws {
        let g = Self.make(left: 1, right: 1)
        #expect(g.leftAmplitude <= SpeakerSafety.maxAmplitude && g.rightAmplitude <= SpeakerSafety.maxAmplitude)
        #expect(g.leftAmplitude + g.rightAmplitude <= SpeakerSafety.maxAmplitude * 1.0001)
        try g.start()
        let (l, r) = g.render(count: 48_000)
        let peakL = l.map { abs($0) }.max()!, peakR = r.map { abs($0) }.max()!
        let peakSum = zip(l, r).map { abs($0 + $1) }.max()!
        #expect(peakL <= g.leftAmplitude + 1e-6 && peakR <= g.rightAmplitude + 1e-6)
        #expect(peakSum <= SpeakerSafety.maxAmplitude + 1e-6, "mono downmix peak \(peakSum)")
        // One channel asking for the whole cap takes it, the other is scaled down with it.
        let lopsided = Self.make(left: SpeakerSafety.maxAmplitude, right: SpeakerSafety.maxAmplitude / 4)
        #expect(lopsided.leftAmplitude + lopsided.rightAmplitude <= SpeakerSafety.maxAmplitude * 1.0001)
        #expect(Self.make(left: .nan, right: -3).leftAmplitude == 0)
    }

    @Test func fadesAutoStopAndCooldown() throws {
        let clock = FakeClock()
        let g = Self.make(clock: clock)
        try g.start()
        let first = g.render(count: 48)
        #expect(first.left[0] == 0 && first.right[0] == 0)
        var rendered = 48
        while rendered < 59 * 48_000 { _ = g.render(count: 4_800); rendered += 4_800 }
        #expect(g.state == .playing)
        _ = g.render(count: 2 * 48_000)
        #expect(g.state == .idle && g.autoStopped)
        let after = g.render(count: 256)
        #expect(after.left.allSatisfy { $0 == 0 } && after.right.allSatisfy { $0 == 0 })
        #expect(throws: PilotToneError.self) { try g.start() }
        clock.now += 11
        try g.start()
        #expect(g.state == .playing)
    }

    /// Sonar stays on for as long as the user wants: the daemon renews every second. Ten minutes of renewed
    /// playback never exceeds the cap (per channel or as a mono downmix) and never stops by itself.
    @Test func continuousRenewalKeepsTheCap() throws {
        let clock = FakeClock()
        let g = Self.make(left: 1, right: 1, clock: clock)
        try g.start()
        var peakL: Float = 0, peakR: Float = 0, peakSum: Float = 0
        for _ in 0..<600 {
            let (l, r) = g.render(count: 48_000)
            peakL = max(peakL, l.map { abs($0) }.max()!)
            peakR = max(peakR, r.map { abs($0) }.max()!)
            peakSum = max(peakSum, zip(l, r).map { abs($0 + $1) }.max()!)
            clock.now += 1
            #expect(g.renew())
        }
        #expect(g.state == .playing && !g.autoStopped)
        #expect(peakL <= SpeakerSafety.maxAmplitude + 1e-6 && peakR <= SpeakerSafety.maxAmplitude + 1e-6)
        #expect(peakSum <= SpeakerSafety.maxAmplitude + 1e-6, "mono downmix peak \(peakSum)")
        // Renewals never start a cooldown: stop and start again at once.
        g.stop()
        _ = g.render(count: 4_800)
        try g.start()
        #expect(g.state == .playing)
    }

    /// Headphones (or Bluetooth, or anything but the built-in speakers) appear mid-session: the next renewal stops the
    /// tones within the 20 ms fade, the channels go silent, and a restart waits out the 10 s cooldown.
    @Test func routeChangeStopsTheTones() throws {
        let clock = FakeClock()
        final class Route: @unchecked Sendable { var now = OutputRoute.builtInSpeaker }
        let route = Route()
        let g = StereoPilotGenerator(routeCheck: { route.now }, clock: { clock.now })
        try g.start()
        _ = g.render(count: 48_000)
        for changed: OutputRoute in [.headphones, .external(transport: "blue")] {
            route.now = changed
            #expect(!g.renew())
            let fade = g.render(count: 960 + 480)     // 20 ms fade, then silence
            #expect(fade.left[960...].allSatisfy { $0 == 0 } && fade.right[960...].allSatisfy { $0 == 0 })
            #expect(g.state == .idle)
            #expect(throws: PilotToneError.self) { try g.start() }
            route.now = .builtInSpeaker
            clock.now += 11
            try g.start()
            _ = g.render(count: 4_800)
            #expect(g.state == .playing)
        }
        // A hard cut (audio configuration change) is silent from the very next sample.
        g.stopImmediately()
        let after = g.render(count: 256)
        #expect(after.left.allSatisfy { $0 == 0 } && after.right.allSatisfy { $0 == 0 })
        #expect(throws: PilotToneError.self) { try g.start() }
    }

    @Test func refusesAnythingButTheBuiltInSpeaker() {
        for route: OutputRoute in [.headphones, .unknown, .external(transport: "usb ")] {
            let g = Self.make(route: route)
            #expect(throws: PilotToneError.routeNotAllowed(route)) { try g.start() }
            let (l, r) = g.render(count: 128)
            #expect(l.allSatisfy { $0 == 0 } && r.allSatisfy { $0 == 0 })
        }
    }

    @Test func eachChannelCarriesItsOwnPilot() throws {
        let g = Self.make()
        try g.start()
        _ = g.render(count: 2_000)
        let (l, r) = g.render(count: 4_096)
        let fft = RealFFT(size: 4_096)
        let w = DSPMath.periodicHann(4_096)
        func peak(_ x: [Float]) -> Int {
            var p = [Float](repeating: 0, count: fft.bins)
            x.withUnsafeBufferPointer { xp in w.withUnsafeBufferPointer { wp in p.withUnsafeMutableBufferPointer {
                fft.powerSpectrum(xp.baseAddress!, count: 4_096, window: wp.baseAddress!, into: $0.baseAddress!) } } }
            return p.indices.max { p[$0] < p[$1] }!
        }
        #expect(peak(l) == 1_664)
        #expect(peak(r) == 1_728)
    }
}
