import Darwin
import Testing
@testable import GhostkeysDetection

@Suite struct OnsetTests {
    @Test func recallAndPrecisionOnSyntheticTaps() {
        var b = StreamBuilder(seconds: 62, seed: 11)
        var rng = Rng(5)
        var truth: [Double] = []
        var t = 1.0
        while t < 61 {
            truth.append(b.addTap(ZoneSpec.six[Int(rng.uniform() * 6) % 6], at: t))
            t += rng.uniform(0.6, 1.2)
        }
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        let detected = events.candidates.map(\.t)
        let m = match(detected: detected, truth: truth)
        let recall = Double(m.hits) / Double(truth.count)
        #expect(recall >= 0.98, "recall \(recall) (\(m.hits)/\(truth.count))")
        #expect(m.falsePositives == 0)
        #expect(events.rejections.isEmpty, "\(events.rejections)")
    }

    @Test func weakTapsAreStillFound() {
        var b = StreamBuilder(seconds: 12, seed: 3)
        var truth: [Double] = []
        for k in 0..<10 { truth.append(b.addTap(.leftPalm, at: 1 + Double(k), amp: 0.03)) }
        let m = match(detected: run(TapEngine(settings: DetectionSettings()), b.samples()).candidates.map(\.t), truth: truth)
        #expect(m.hits >= 9)
        #expect(m.falsePositives == 0)
    }

    /// The real "rest" recording contains a few genuine desk wobbles (~40 Hz, 12 to 32 mg, over
    /// 100 ms long) near 3.9 s, 4.4 to 4.9 s, 9.3 to 9.7 s and 10.5 s.
    static let wobbles: [ClosedRange<Double>] = [3.8...4.95, 9.2...9.85, 10.4...10.6]
    static func inWobble(_ t: Double) -> Bool { wobbles.contains { $0.contains(t) } }

    @Test func realRestRecordingIsQuiet() {
        let samples = restRecording()
        #expect(samples.count == RestRecording.sampleCount)
        let events = run(TapEngine(settings: DetectionSettings()), samples)
        let onsets = events.candidates.map(\.t) + events.rejections.map(\.t)
        // Nothing outside the wobbles, and the wobbles that do pass are weak (under 40 mg).
        #expect(onsets.filter { !Self.inWobble($0) }.isEmpty, "\(onsets)")
        #expect(events.candidates.count <= 3)
        #expect(events.candidates.allSatisfy { $0[.strength] < log10(40) })
    }

    @Test func tapsInjectedIntoRealRestDataAreFound() {
        let rest = restRecording()
        var b = StreamBuilder(seconds: Double(rest.count) / fs, seed: 9, noiseMg: 0)
        var truth: [Double] = []
        var t = 0.6
        var k = 0
        while t < 11.8 {
            if !Self.inWobble(t) && !Self.inWobble(t + 0.1) { truth.append(b.addTap(ZoneSpec.six[k % 6], at: t)); k += 1 }
            t += 0.55
        }
        let synth = b.samples()
        let mixed = zip(rest, synth).map { r, s in
            IMUSample(t: r.t, a: r.a + (s.a - StreamBuilder.restGravity), g: r.g + (s.g - SIMD3(0.121, -0.092, -0.006)))
        }
        let events = run(TapEngine(settings: DetectionSettings()), mixed)
        let detected = events.candidates.map(\.t).filter { !Self.inWobble($0) }
        let m = match(detected: detected, truth: truth)
        #expect(truth.count >= 12)
        #expect(m.hits == truth.count, "\(m.hits)/\(truth.count)")
        #expect(m.falsePositives == 0)
    }

    @Test func typingGateRejectsKeystrokes() {
        var b = StreamBuilder(seconds: 6, seed: 21)
        var input = InputScript()
        var t = 1.0
        // Typing at ~5 keys/s for 2 s. Key events are delivered 20 ms AFTER the vibration.
        while t < 3 { b.addKeystroke(at: t, amp: 0.05); input.keys.append(t); t += 0.21 }
        input.delay = 0.02
        // A real tap 0.6 s after the last key must pass (typing gate is 450 ms).
        let tapT = b.addTap(.leftPalm, at: t - 0.21 + 0.6, amp: 0.2)
        let events = run(TapEngine(settings: DetectionSettings()), b.samples(), input: input)
        let typing = events.rejections.filter { $0.reason == .typing }
        #expect(typing.count >= 9, "\(events.rejections)")
        #expect(events.candidates.count == 1)
        #expect(abs(events.candidates.first!.t - tapT) < 0.02)
    }

    @Test func typingGateWindowFollowsSettings() {
        var b = StreamBuilder(seconds: 3, seed: 22)
        b.addTap(.leftPalm, at: 1.3, amp: 0.2)
        let input = InputScript(keys: [1.0])
        var s = DetectionSettings()
        s.typingGateMs = 450
        #expect(run(TapEngine(settings: s), b.samples(), input: input).rejections.map(\.reason) == [.typing])
        s.typingGateMs = 200
        #expect(run(TapEngine(settings: s), b.samples(), input: input).candidates.count == 1)
    }

    @Test func trackpadGate() {
        var b = StreamBuilder(seconds: 3, seed: 23)
        b.addTap(.rightPalm, at: 1.0, amp: 0.2)
        b.addTap(.rightPalm, at: 2.0, amp: 0.2)
        let input = InputScript(mouse: [0.9, 1.7])   // 100 ms before the first tap, 300 ms before the second
        let events = run(TapEngine(settings: DetectionSettings()), b.samples(), input: input)
        #expect(events.rejections.map(\.reason) == [.trackpad])
        #expect(events.candidates.count == 1)
    }

    @Test func burstLockout() {
        var b = StreamBuilder(seconds: 4, seed: 24)
        // 6 spikes 90 ms apart: spikes 4..6 are inside the burst.
        for k in 0..<6 { b.addTap(.leftGrille, at: 1 + Double(k) * 0.09, amp: 0.15, jitter: 0.3) }
        // 0.3 s after the last spike: still muted (lockout restarts at each burst spike).
        b.addTap(.leftGrille, at: 1.45 + 0.3, amp: 0.15)
        // Well after the lockout.
        let late = b.addTap(.leftGrille, at: 3.0, amp: 0.15)
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        let burst = events.rejections.filter { $0.reason == .burst }
        #expect(burst.count == 4, "\(events.rejections)")
        #expect(events.candidates.count == 4)   // 3 before the lockout + the late one
        #expect(events.candidates.contains { abs($0.t - late) < 0.02 })
    }

    @Test func longVibrationIsNotATap() {
        var b = StreamBuilder(seconds: 3, seed: 25)
        b.addVibration(at: 1.0, seconds: 0.3, amp: 0.08)
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        #expect(events.candidates.isEmpty)
        #expect(events.rejections.first?.reason == .motion)
    }

    @Test func movingLaptopGatesTaps() {
        var b = StreamBuilder(seconds: 4, seed: 26)
        b.addRoll(at: 1.0, degrees: 6, ramp: 0.6, hold: 1.0)   // slow roll, not a tilt gesture
        b.addTap(.leftPalm, at: 1.3, amp: 0.2)                  // while rotating
        b.addTap(.leftPalm, at: 2.2, amp: 0.2)                  // held still at the new angle
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        #expect(events.rejections.map(\.reason) == [.motion], "\(events.rejections)")
        #expect(events.candidates.count == 1)
    }

    @Test func pausedRejectsEverything() {
        var b = StreamBuilder(seconds: 3, seed: 27)
        b.addTap(.leftPalm, at: 1.0, amp: 0.2)
        let input = InputScript(paused: 0...10)
        let events = run(TapEngine(settings: DetectionSettings()), b.samples(), input: input)
        #expect(events.rejections.map(\.reason) == [.paused])
        #expect(events.candidates.isEmpty)
    }

    @Test func sensitivityMovesTheThreshold() {
        var strict = DetectionSettings(); strict.sensitivity = 0
        var loose = DetectionSettings(); loose.sensitivity = 1
        var b = StreamBuilder(seconds: 3, seed: 28)
        b.addTap(.leftPalm, at: 1.0, amp: 0.012)
        b.addTap(.leftPalm, at: 2.0, amp: 0.012)
        #expect(run(TapEngine(settings: strict), b.samples()).candidates.isEmpty)
        #expect(run(TapEngine(settings: loose), b.samples()).candidates.count == 2)
    }

    @Test func calibrationBypassCapturesKeystrokes() {
        var b = StreamBuilder(seconds: 4, seed: 29)
        var input = InputScript()
        for k in 0..<12 { let t = 1 + Double(k) * 0.2; b.addKeystroke(at: t, amp: 0.06); input.keys.append(t) }
        let engine = TapEngine(settings: DetectionSettings())
        engine.bypassInputGates = true
        let events = run(engine, b.samples(), input: input)
        #expect(events.candidates.count == 12)
    }

    @Test func candidateFeatureVectorIsWellFormed() {
        var b = StreamBuilder(seconds: 2, seed: 30)
        b.addTap(.rightPalm, at: 1.0, amp: 0.2)
        let f = run(TapEngine(settings: DetectionSettings()), b.samples()).candidates
        #expect(f.count == 1)
        guard let v = f.first else { return }
        #expect(v.values.count == TapFeatures.count)
        #expect(v.values.allSatisfy { $0.isFinite })
        #expect(v[.impulseZ] > 0)
        #expect(v[.xHat] > 0)                       // right of centre
        #expect(abs(v[.ringFrequency] - 100) < 25)  // right palm rings at ~100 Hz
        #expect(v[.pulseWidth] > 5 && v[.pulseWidth] < 120)
        #expect(abs(v[.strength] - log10(200)) < 0.3)
    }
}
