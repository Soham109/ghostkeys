import Darwin
import Testing
@testable import GhostkeysAcoustics

@Suite struct RingBufferTests {
    @Test func readsByTimeAcrossTheWrap() {
        let rb = AudioRingBuffer(duration: 0.01, sampleRate: 1_000) // 10 samples
        rb.write((0..<7).map(Float.init), time: 0)
        rb.write((7..<15).map(Float.init), time: 0.007)
        #expect(abs(rb.timeRange!.lowerBound - 0.005) < 1e-9 && abs(rb.timeRange!.upperBound - 0.015) < 1e-9)
        #expect(rb.read(from: 0.005, count: 10) == (5..<15).map(Float.init))
        #expect(rb.read(from: 0.008, count: 3) == [8, 9, 10])
        #expect(rb.read(from: 0.004, count: 2) == nil)
        #expect(rb.read(from: 0.012, count: 4) == nil)
        #expect(rb.latest(3) == [12, 13, 14])
    }

    @Test func discontinuityClearsHistory() {
        let rb = AudioRingBuffer(duration: 0.01, sampleRate: 1_000)
        rb.write([1, 2, 3], time: 0)
        rb.write([4, 5], time: 1.0)
        #expect(abs(rb.timeRange!.lowerBound - 1.0) < 1e-9 && abs(rb.timeRange!.upperBound - 1.002) < 1e-9)
        #expect(rb.read(from: 1.0, count: 2) == [4, 5])
    }

    @Test func oversizedWriteKeepsTheNewest() {
        let rb = AudioRingBuffer(duration: 0.004, sampleRate: 1_000)
        rb.write((0..<10).map(Float.init), time: 0)
        #expect(rb.read(from: 0.006, count: 4) == [6, 7, 8, 9])
    }
}

@Suite struct DSPTests {
    @Test func powerSpectrumPeaksAtToneAndAutocorrelationFindsPeriod() {
        let fft = RealFFT(size: 2_048)
        let x = (0..<1_024).map { Float(sin(2 * Double.pi * 200 * Double($0) / 48_000)) } // period 240 samples
        var p = [Float](repeating: 0, count: fft.bins)
        x.withUnsafeBufferPointer { xp in p.withUnsafeMutableBufferPointer { fft.powerSpectrum(xp.baseAddress!, count: 1_024, window: nil, into: $0.baseAddress!) } }
        let peak = p.indices.max { p[$0] < p[$1] }!
        #expect(abs(Double(peak) * 48_000 / 2_048 - 200) < 48_000 / 2_048)
        var acf = [Float](repeating: 0, count: 400)
        p.withUnsafeBufferPointer { pp in acf.withUnsafeMutableBufferPointer { fft.inverseEvenSpectrum(pp.baseAddress!, into: $0.baseAddress!, count: 400) } }
        let best = (150..<400).max { acf[$0] < acf[$1] }!
        #expect(abs(best - 240) <= 3) // finite-length bias moves the peak a sample or two
    }

    @Test func framerDeliversOverlappingFramesWithTimes() {
        let f = SlidingFramer(frameSize: 4, hop: 2)
        var frames: [[Float]] = [], times: [Double] = []
        let x: [Float] = [0, 1, 2, 3, 4, 5, 6, 7]
        for (i, chunk) in [[Float](x[0..<3]), [Float](x[3..<8])].enumerated() {
            chunk.withUnsafeBufferPointer { c in
                f.push(c, time: i == 0 ? 0 : 3, sampleRate: 1) { p, end in frames.append(Array(UnsafeBufferPointer(start: p, count: 4))); times.append(end) }
            }
        }
        #expect(frames == [[0, 1, 2, 3], [2, 3, 4, 5], [4, 5, 6, 7]])
        #expect(times == [4, 6, 8])
    }

    @Test func gestureNamesMatchTheProtocol() {
        #expect(AcousticGestureKind.allCases.map(\.rawValue) == ["knock_knuckle", "rub", "rub_left", "rub_right", "wave_toward", "wave_away", "wave_sweep", "push", "pull", "sweep_left", "sweep_right", "finger_slide_left", "finger_slide_right", "finger_slide_up", "finger_slide_down"])
    }
}

@Suite struct PerformanceTests {
    /// 60 s of 48 kHz audio (room noise, pilot tone, a rub every 5 s, a wave every 7 s, some typing) through the full
    /// processor in 256-sample chunks must take under 0.5 s.
    @Test func sixtySecondsUnderHalfASecond() throws {
        var rng = SeededRNG(42)
        let seconds = 60.0
        var motions: [(start: Double, length: Double, kind: Synth.Motion)] = []
        var t = 1.0
        while t < seconds - 1 { motions.append((t, 0.4, .toward)); t += 7 }
        var x = Synth.sonar(duration: seconds, motions: motions, &rng)
        let bg = Synth.noise(x.count, &rng, amplitude: 0.0003)
        for i in x.indices { x[i] += bg[i] }
        var r = 3.0
        while r < seconds - 1 { Synth.add(&x, Synth.rub(duration: 0.6, &rng), at: Int(r * 48_000)); r += 5 }
        Synth.add(&x, Synth.typing(duration: 5, &rng), at: 20 * 48_000)

        let processor = SoundModeProcessor()
        let clock = ContinuousClock()
        var events: [AcousticEvent] = []
        let elapsed = clock.measure {
            events = Synth.stream(x, chunk: 256) { processor.process($0, time: $1) }
        }
        let secondsTaken = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        print("GhostkeysAcoustics perf: 60 s of audio processed in \(secondsTaken) s")
        #expect(secondsTaken < 0.5, "took \(secondsTaken) s")
        let kinds = events.compactMap { e -> AcousticGestureKind? in if case .gesture(let g) = e { return g.kind }; return nil }
        #expect(kinds.filter { $0 == .rub }.count >= 10, "\(kinds)")
        #expect(kinds.filter { $0 == .waveToward }.count >= 7, "\(kinds)")
    }

    /// Same budget with SonarField on: stereo pilots, a hover, a push and a sweep every 6 s, plus rubs and typing.
    @Test func sonarFieldSixtySecondsUnderHalfASecond() {
        var rng = SeededRNG(43)
        let seconds = 60.0
        func hand(_ t: Double) -> SIMD3<Double> {
            let k = Int(t / 6), u = t - Double(k) * 6
            switch k % 3 {
            case 0: return Synth.lerp(SIMD3(-0.145, 0.08, 0.10), SIMD3(-0.145, 0.08, 0.22), Synth.ease(u, 1, 2))
            case 1: return Synth.lerp(SIMD3(0.145, 0.08, 0.25), SIMD3(0.145, 0.08, 0.12), Synth.ease(u, 1, 1.3))
            default: return Synth.lerp(SIMD3(-0.3, 0.08, 0.12), SIMD3(0.3, 0.08, 0.12), Synth.ease(u, 1, 1.5))
            }
        }
        var x = Synth.field(duration: seconds, hand: hand, &rng)
        var r = 4.5
        while r < seconds - 1 { Synth.add(&x, Synth.rub(duration: 0.5, &rng), at: Int(r * 48_000)); r += 12 }
        Synth.add(&x, Synth.typing(duration: 3, &rng), at: 40 * 48_000)
        var options = SoundModeProcessor.Options()
        options.sonarField = true
        let processor = SoundModeProcessor(options: options)
        var events: [AcousticEvent] = []
        let elapsed = ContinuousClock().measure {
            events = Synth.stream(x, chunk: 256) { processor.process($0, time: $1) }
        }
        let secondsTaken = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        print("GhostkeysAcoustics perf (SonarField): 60 s of audio processed in \(secondsTaken) s")
        #expect(secondsTaken < 0.5, "took \(secondsTaken) s")
        let kinds = events.compactMap { e -> AcousticGestureKind? in if case .gesture(let g) = e { return g.kind }; return nil }
        #expect(kinds.contains(.push) && kinds.contains(.sweepRight), "\(kinds)")
        #expect(events.contains { if case .air(let a) = $0 { return a.kind == .hoverLevel }; return false })
    }
}
