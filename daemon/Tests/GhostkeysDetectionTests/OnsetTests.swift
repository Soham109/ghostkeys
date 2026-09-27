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
        // With the quiet-desk floor (~6 mg) the small real desk events become candidates. They must
        // all be weak (under 40 mg) and few; realDeskWobblesAreNotTaps checks that none of them
        // survives the classifier.
        #expect(events.candidates.count <= 8, "\(events.candidates.map(\.t))")
        #expect(events.candidates.allSatisfy { $0[.strength] < log10(40) })
        #expect(events.rejections.allSatisfy { $0.reason == .motion })
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
        let detected = events.candidates.filter { !Self.inWobble($0.t) }
        let m = match(detected: detected.map(\.t), truth: truth)
        #expect(truth.count >= 12)
        #expect(m.hits == truth.count, "\(m.hits)/\(truth.count)")
        // Anything else detected is one of the recording's own small desk events (under 20 mg).
        let extra = detected.filter { d in !truth.contains { abs($0 - d.t) <= 0.02 } }
        #expect(extra.allSatisfy { $0[.strength] < log10(20) }, "\(extra.map(\.t))")
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
        var b = StreamBuilder(seconds: 5, seed: 26)
        b.addRoll(at: 1.0, degrees: 20, ramp: 0.6, hold: 2.5)  // picking one side up, not a tilt gesture
        b.addTap(.leftPalm, at: 1.4, amp: 0.2)                  // while rotating
        b.addTap(.leftPalm, at: 2.8, amp: 0.2)                  // held still at the new angle
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        // The tap during the lift never becomes a candidate (it is gated as motion, or swallowed by
        // the lift's own over-long pulse, which is itself rejected as motion); the tap after it is.
        #expect(!events.rejections.isEmpty)
        #expect(events.rejections.allSatisfy { $0.reason == .motion })
        #expect(events.candidates.map(\.t).filter { abs($0 - 2.8) < 0.02 }.count == 1)
        #expect(events.candidates.count == 1)
    }

    /// First real recording (on a lap): a palm tap rocks the machine by several degrees for a few
    /// tens of ms. That is the tap, not motion, and must not be gated.
    @Test func tapThatRocksTheMachineIsNotMotion() {
        var b = StreamBuilder(seconds: 5, seed: 31)
        var truth: [Double] = []
        for k in 0..<8 {
            let t = 1.0 + Double(k) * 0.4          // the user tapped every ~0.4 s
            b.addRock(at: t, degrees: k % 2 == 0 ? 5 : -5, duration: 0.1)
            truth.append(b.addTap(.leftPalm, at: t, amp: 0.1))
        }
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        #expect(events.rejections.isEmpty, "\(events.rejections)")
        #expect(match(detected: events.candidates.map(\.t), truth: truth).hits == 8)
    }

    /// Left-palm taps in the real recording stay above half their peak for 50 to 90 ms.
    @Test func longRingingTapIsStillATap() {
        var b = StreamBuilder(seconds: 3, seed: 32)
        var z = ZoneSpec.leftPalm
        z.decay = 0.06; z.freq = 45
        let t0 = b.addTap(z, at: 1.0, amp: 0.1, jitter: 0)
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        #expect(events.rejections.isEmpty, "\(events.rejections)")
        #expect(events.candidates.count == 1)
        if let f = events.candidates.first {
            #expect(abs(f.t - t0) < 0.02)
            #expect(f[.pulseWidth] < 120, "\(f[.pulseWidth])")
        }
    }

    @Test func ringingTailDoesNotRetrigger() {
        var b = StreamBuilder(seconds: 4, seed: 33)
        var z = ZoneSpec.rightPalm
        z.decay = 0.04
        var truth: [Double] = []
        for k in 0..<5 { truth.append(b.addTap(z, at: 1 + Double(k) * 0.5, amp: 0.8, jitter: 0.5)) }
        let events = run(TapEngine(settings: DetectionSettings()), b.samples())
        let onsets = events.candidates.map(\.t) + events.rejections.map(\.t)
        #expect(onsets.count == 5, "\(onsets)")
        #expect(match(detected: onsets, truth: truth).hits == 5)
    }

    /// Real taps ring up (the first half cycle is smaller than the rebound). The second tap of a double
    /// arrives while the first is still in its tail guard and must still count; a single tap must not.
    @Test func doubleTapThatRingsUpIsTwoOnsets() {
        func onsets(_ taps: [Double]) -> Int {
            let fs = 797.0, f0 = 45.0, tau = 0.012
            let engine = TapEngine(settings: DetectionSettings())
            var rng = SplitMix64(seed: 5)
            var n = 0
            for i in 0..<Int(2.5 * fs) {
                let t = Double(i) / fs
                var z = -1.0
                for t0 in taps where t >= t0 {
                    let u = t - t0
                    z += 0.06 * sin(2 * .pi * f0 * u) * (u / tau) * exp(1 - u / tau)
                }
                let r = { (Double(rng.next() % 2001) / 1000 - 1) * 0.0005 }
                let s = IMUSample(t: t, a: SIMD3(r(), r(), z + r()), g: SIMD3(r(), r(), r()))
                for e in engine.ingest(s, context: InputContext()) { if case .candidate = e { n += 1 } }
            }
            return n
        }
        #expect(onsets([1.0]) == 1)
        #expect(onsets([1.0, 1.18]) == 2)
        #expect(onsets([1.0, 1.25]) == 2)
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
        // Default (fixed floor): 12 mg taps need sensitivity 1.
        var strict = DetectionSettings(); strict.sensitivity = 0
        var loose = DetectionSettings(); loose.sensitivity = 1
        var b = StreamBuilder(seconds: 3, seed: 28)
        b.addTap(.leftPalm, at: 1.0, amp: 0.012)
        b.addTap(.leftPalm, at: 2.0, amp: 0.012)
        #expect(run(TapEngine(settings: strict), b.samples()).candidates.isEmpty)
        #expect(run(TapEngine(settings: loose), b.samples()).candidates.count == 2)
        // Light-touch mode: 6 mg taps, same override.
        strict.lightTouch = true; loose.lightTouch = true
        var c = StreamBuilder(seconds: 3, seed: 28)
        c.addTap(.leftPalm, at: 1.0, amp: 0.006)
        c.addTap(.leftPalm, at: 2.0, amp: 0.006)
        #expect(run(TapEngine(settings: strict), c.samples()).candidates.isEmpty)
        #expect(run(TapEngine(settings: loose), c.samples()).candidates.count == 2)
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
        #expect(v[.pulseWidth] > 0 && v[.pulseWidth] < 120)
        #expect(abs(v[.strength] - log10(200)) < 0.3)
    }
}

@Suite struct AdaptiveFloorTests {
    /// 10 mg fingertip taps on the quiet part of the real rest recording, no calibration yet.
    @Test func gentleTapsTriggerOnAQuietDesk() {
        let rest = Array(restRecording().prefix(Int(3.3 * fs)))     // the quiet first 3.3 s
        var b = StreamBuilder(seconds: 3.3, seed: 41, noiseMg: 0)
        var truth: [Double] = []
        for k in 0..<4 { truth.append(b.addTap(.leftGrille, at: 0.6 + Double(k) * 0.65, amp: 0.007)) }
        let syn = b.samples()
        let mixed = zip(rest, syn).map { r, s in IMUSample(t: r.t, a: r.a + (s.a - StreamBuilder.restGravity), g: r.g) }
        var lt = DetectionSettings(); lt.lightTouch = true
        let e = TapEngine(settings: lt)
        let ev = run(e, mixed)
        #expect(match(detected: ev.candidates.map(\.t), truth: truth).hits == 4)
        // Default settings (fixed 17.5 mg floor) do not hear them.
        #expect(run(TapEngine(settings: DetectionSettings()), mixed).candidates.isEmpty)
        #expect(e.onsetThreshold < 0.008)
    }

    @Test func floorRisesWithInputActivityAndNoise() {
        // Same quiet signal, but a key was pressed 0.5 s ago: quiet mode is off, the floor goes back up.
        let rest = Array(restRecording().prefix(Int(3 * fs)))
        var lt = DetectionSettings(); lt.lightTouch = true
        let quiet = TapEngine(settings: lt)
        let busy = TapEngine(settings: lt)
        for s in rest {
            _ = quiet.ingest(s, context: InputContext())
            _ = busy.ingest(s, context: InputContext(secondsSinceKey: 0.5))
        }
        #expect(quiet.isQuiet && !busy.isQuiet)
        #expect(busy.onsetThreshold > 2 * quiet.onsetThreshold)
        // Noisy (lap-like) signal: k x noise takes over.
        let noisy = TapEngine(settings: lt)
        for s in StreamBuilder(seconds: 3, seed: 2, noiseMg: 12).samples() { _ = noisy.ingest(s, context: InputContext()) }
        #expect(!noisy.isQuiet)
        #expect(noisy.onsetThreshold > 0.02)
    }

    @Test func floorIsLearnedFromCalibrationTaps() {
        let cal = captureCalibration(zones: [.leftPalm, .leftGrille], perZone: 12, keystrokes: 10)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        let m = t.train().0
        let q = m.peakQuantiles ?? [:]
        #expect(Set(q.keys) == ["left-palm", "left-grille"])
        let gentlest = q.values.map { $0[0] }.min()!
        #expect(m.onsetFloor == Stats.clamp(0.5 * gentlest, 0.004, 0.0175))
        // The engine uses it in light-touch mode (not quiet: a key was just pressed).
        var lt = DetectionSettings(); lt.lightTouch = true
        let e = TapEngine(settings: lt)
        e.model = m
        for s in StreamBuilder(seconds: 1, seed: 3).samples() { _ = e.ingest(s, context: InputContext(secondsSinceKey: 0.2)) }
        #expect(abs(e.onsetThreshold - max(m.onsetFloor!, 5 * e.noiseFloor)) < 1e-9)
    }

    @Test func sensitivityStillOverridesTheLearnedFloor() {
        var m = ZoneModel(labels: ["a"])
        m.onsetFloor = 0.008
        var d = OnsetDetector()
        d.lightTouch = true
        d.learnedFloor = m.onsetFloor
        d.inputIdle = false
        d.sensitivity = 0.5; let mid = d.absoluteFloor
        d.sensitivity = 0; let strict = d.absoluteFloor
        d.sensitivity = 1; let loose = d.absoluteFloor
        #expect(abs(mid - 0.008) < 1e-12 && abs(strict - 0.016) < 1e-12 && abs(loose - 0.004) < 1e-12)
    }

    @Test func modelsSavedBeforeTheLearnedFloorStillLoad() throws {
        let cal = captureCalibration(zones: [.leftPalm, .rightPalm], perZone: 10)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        var old = t.train().0
        old.onsetFloor = nil; old.peakQuantiles = nil; old.ignoredFeatures = nil
        let back = try jsonRoundTrip(old)       // nil optionals are omitted from the JSON, as in old files
        #expect(back.onsetFloor == nil)
        #expect(back.classify(cal.features[0]).zone == old.classify(cal.features[0]).zone)
    }
}
