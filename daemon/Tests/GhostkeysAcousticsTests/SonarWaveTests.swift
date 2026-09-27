import Darwin
import Testing
@testable import GhostkeysAcoustics

@Suite struct SonarWaveTests {
    static func run(_ x: [Float]) -> [SonarWaveEvent] {
        let d = SonarWaveDetector()
        return Synth.stream(x, chunk: 256) { d.process($0, time: $1) }
    }

    @Test func pilotAloneIsQuiet() {
        var rng = SeededRNG(1)
        #expect(Self.run(Synth.sonar(duration: 3, motions: [], &rng)).isEmpty)
    }

    @Test func handTowardWidensTheRightSide() {
        var rng = SeededRNG(2)
        let events = Self.run(Synth.sonar(duration: 2, motions: [(0.8, 0.4, .toward)], &rng))
        #expect(events.map(\.kind) == [.toward], "\(events)")
        if let e = events.first {
            #expect(e.startTime > 0.75 && e.time < 1.35)
            #expect(e.peakShiftHz > 35 && e.peakShiftHz < 120, "\(e.peakShiftHz)")
            #expect(e.confidence > 0.5)
        }
    }

    @Test func handAwayWidensTheLeftSide() {
        var rng = SeededRNG(3)
        let events = Self.run(Synth.sonar(duration: 2, motions: [(0.8, 0.4, .away)], &rng))
        #expect(events.map(\.kind) == [.away], "\(events)")
    }

    @Test func passOverIsASweep() {
        var rng = SeededRNG(4)
        let events = Self.run(Synth.sonar(duration: 2, motions: [(0.7, 0.6, .sweep)], &rng))
        #expect(events.map(\.kind) == [.sweep], "\(events)")
    }

    @Test func separateWavesAreDebouncedIndividually() {
        var rng = SeededRNG(5)
        let events = Self.run(Synth.sonar(duration: 4, motions: [(0.6, 0.4, .toward), (2.2, 0.4, .away)], &rng))
        #expect(events.map(\.kind) == [.toward, .away], "\(events)")
    }

    @Test func noPilotMeansNoDetection() {
        var rng = SeededRNG(6)
        let d = SonarWaveDetector()
        let events = Synth.stream(Synth.noise(96_000, &rng, amplitude: 0.01), chunk: 256) { d.process($0, time: $1) }
        #expect(events.isEmpty)
        #expect(d.lastFrame?.pilotPresent == false)
    }

    @Test func weakReflectionsBelowThresholdAreIgnored() {
        var rng = SeededRNG(7)
        #expect(Self.run(Synth.sonar(duration: 2, motions: [(0.8, 0.4, .toward)], reflectionDb: -60, &rng)).isEmpty)
    }

    @Test func defaultPilotIsBinAligned() {
        let c = SonarConfig()
        #expect(abs(c.pilotHz / c.binHz - (c.pilotHz / c.binHz).rounded()) < 1e-9)
        #expect(abs(c.pilotHz - 20_000) < c.binHz)
    }
}

@Suite struct PilotToneGeneratorTests {
    final class FakeClock: @unchecked Sendable { var now = 1_000.0 }

    static func make(route: OutputRoute = .builtInSpeaker, amplitude: Float = PilotToneGenerator.maxAmplitude,
                     clock: FakeClock = FakeClock()) -> PilotToneGenerator {
        PilotToneGenerator(amplitude: amplitude, routeCheck: { route }, clock: { clock.now })
    }

    @Test func amplitudeIsCappedAtMinus30Dbfs() throws {
        let g = Self.make(amplitude: 1.0)
        #expect(g.amplitude == PilotToneGenerator.maxAmplitude)
        #expect(abs(20 * log10(Double(PilotToneGenerator.maxAmplitude)) + 30) < 0.01)
        try g.start()
        let x = g.render(count: 48_000)
        let peak = x.map { abs($0) }.max() ?? 0
        #expect(peak <= PilotToneGenerator.maxAmplitude + 1e-6)
        #expect(peak > PilotToneGenerator.maxAmplitude * 0.99)
        #expect(Self.make(amplitude: .infinity).amplitude <= PilotToneGenerator.maxAmplitude)
        #expect(Self.make(amplitude: -1).amplitude == 0)
    }

    @Test func fadesInAndOutOver20Ms() throws {
        let g = Self.make()
        try g.start()
        let x = g.render(count: 2_400)
        #expect(x[0] == 0)
        let firstMs = x[0..<48].map { abs($0) }.max()!
        #expect(firstMs < PilotToneGenerator.maxAmplitude * 0.1)
        let settled = x[1_000..<2_400].map { abs($0) }.max()!
        #expect(settled > PilotToneGenerator.maxAmplitude * 0.95)
        g.stop()
        let tail = g.render(count: 2_400)
        #expect(tail[960..<2_400].allSatisfy { $0 == 0 }) // 20 ms = 960 samples
        #expect(tail[0..<960].map { abs($0) }.max()! <= PilotToneGenerator.maxAmplitude)
        #expect(g.state == .idle)
    }

    @Test func autoStopsAfter60Seconds() throws {
        let g = Self.make()
        try g.start()
        var rendered = 0
        while rendered < 59 * 48_000 { _ = g.render(count: 4_800); rendered += 4_800 }
        #expect(g.state == .playing)
        _ = g.render(count: 2 * 48_000)
        #expect(g.state == .idle)
        #expect(g.autoStopped)
        #expect(g.render(count: 480).allSatisfy { $0 == 0 })
    }

    @Test func renewExtendsTheSession() throws {
        let g = Self.make()
        try g.start()
        _ = g.render(count: 50 * 48_000)
        #expect(g.renew())
        _ = g.render(count: 50 * 48_000)
        #expect(g.state == .playing)
        _ = g.render(count: 11 * 48_000)
        #expect(g.state == .idle)
    }

    @Test func cooldownOnlyAfterARefusal() throws {
        let clock = FakeClock()
        final class Route: @unchecked Sendable { var now = OutputRoute.builtInSpeaker }
        let route = Route()
        let g = PilotToneGenerator(routeCheck: { route.now }, clock: { clock.now })
        // A plain stop (the user turned it off) never cools down: it can start again right away.
        try g.start()
        _ = g.render(count: 4_800)
        g.stop()
        _ = g.render(count: 4_800)
        try g.start()
        #expect(g.state == .playing)
        g.stop()
        _ = g.render(count: 4_800)
        // A refusal does: 10 s before the next start, even once the route is fine again.
        route.now = .headphones
        #expect(throws: PilotToneError.routeNotAllowed(.headphones)) { try g.start() }
        route.now = .builtInSpeaker
        clock.now += 5
        #expect(throws: PilotToneError.self) { try g.start() }
        clock.now += 6
        try g.start()
        #expect(g.state == .playing)
    }

    @Test func refusesHeadphonesExternalAndUnknownRoutes() {
        for route: OutputRoute in [.headphones, .unknown, .external(transport: "blue")] {
            let g = Self.make(route: route)
            #expect(throws: PilotToneError.routeNotAllowed(route)) { try g.start() }
            #expect(g.state == .idle)
            #expect(g.render(count: 256).allSatisfy { $0 == 0 })
        }
    }

    @Test func renewStopsWhenRouteChangesToHeadphones() throws {
        var route = OutputRoute.builtInSpeaker
        let g = PilotToneGenerator(routeCheck: { route }, clock: { 0 })
        try g.start()
        route = .headphones
        #expect(!g.renew())
        #expect(g.state == .fadingOut)
    }

    @Test func toneIsAtThePilotFrequencyAndPhaseContinuous() throws {
        let a = Self.make(), b = Self.make()
        try a.start(); try b.start()
        let whole = a.render(count: 4_096 + 512)
        let parts = b.render(count: 4_096) + b.render(count: 512)
        for i in 0..<whole.count { #expect(abs(whole[i] - parts[i]) < 1e-6) }
        // Spectrum peak lands on the pilot bin.
        let fft = RealFFT(size: 4_096)
        var power = [Float](repeating: 0, count: fft.bins)
        let tail = Array(whole[512...])
        let w = DSPMath.periodicHann(4_096)
        tail.withUnsafeBufferPointer { t in w.withUnsafeBufferPointer { wp in power.withUnsafeMutableBufferPointer { p in
            fft.powerSpectrum(t.baseAddress!, count: 4_096, window: wp.baseAddress!, into: p.baseAddress!)
        } } }
        let peak = power.indices.max { power[$0] < power[$1] }!
        #expect(peak == Int((SonarConfig.defaultPilotHz / SonarConfig().binHz).rounded()))
    }
}
