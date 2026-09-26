import Testing
@testable import GhostkeysDetection

@Suite struct TiltTests {
    func tilts(_ build: (inout StreamBuilder) -> Void, seconds: Double = 5) -> [String] {
        var b = StreamBuilder(seconds: seconds, seed: 71)
        build(&b)
        return run(TapEngine(settings: DetectionSettings()), b.samples()).gestures.map(\.g.gesture)
    }

    @Test func rollRightAndBack() {
        #expect(tilts { $0.addRoll(at: 1.0, degrees: 12, ramp: 0.25, hold: 0.4) } == ["tilt_right"])
    }

    @Test func rollLeftAndBack() {
        #expect(tilts { $0.addRoll(at: 1.0, degrees: -12, ramp: 0.25, hold: 0.4) } == ["tilt_left"])
    }

    @Test func smallRollIsIgnored() {
        #expect(tilts { $0.addRoll(at: 1.0, degrees: 5, ramp: 0.25, hold: 0.4) }.isEmpty)
    }

    @Test func rollHeldTooLongIsIgnored() {
        #expect(tilts({ $0.addRoll(at: 1.0, degrees: 12, ramp: 0.25, hold: 2.5) }, seconds: 6).isEmpty)
    }

    @Test func permanentChangeIsIgnored() {
        #expect(tilts({ $0.addRoll(at: 1.0, degrees: 15, ramp: 0.3, hold: 0, back: false) }, seconds: 6).isEmpty)
    }

    @Test func tiltCanBeDisabledAndIsSilentWhenPaused() {
        var b = StreamBuilder(seconds: 4, seed: 72)
        b.addRoll(at: 1.0, degrees: 12, ramp: 0.25, hold: 0.4)
        let e = TapEngine(settings: DetectionSettings())
        e.tiltEnabled = false
        #expect(run(e, b.samples()).gestures.isEmpty)
        #expect(run(TapEngine(settings: DetectionSettings()), b.samples(), input: InputScript(paused: 0...10)).gestures.isEmpty)
    }
}

@Suite struct LidTests {
    /// Plays (time, angle) readings.
    func play(_ readings: [(Double, Double)]) -> [String] {
        let d = LidGestureDetector()
        return readings.compactMap { d.ingest(angle: $0.1, t: $0.0)?.gesture }
    }

    @Test func nudgeBackAndReturn() {
        #expect(play([(0, 110), (1.0, 108), (1.1, 105), (1.2, 104), (1.5, 107), (1.7, 109.5), (1.8, 110)]) == ["lid_nudge"])
    }

    @Test func nudgeForwardAlsoCounts() {
        #expect(play([(0, 110), (1.0, 113), (1.1, 117), (1.4, 111)]) == ["lid_nudge"])
    }

    @Test func tooSmallOrTooBigIsIgnored() {
        #expect(play([(0, 110), (1.0, 108.5), (1.2, 110)]).isEmpty)
        #expect(play([(0, 110), (1.0, 100), (1.1, 85), (1.3, 95), (1.5, 110)]).isEmpty)
    }

    @Test func noReturnMeansNewPosition() {
        let d = LidGestureDetector()
        for (t, a) in [(0.0, 110.0), (1.0, 106), (1.1, 104)] { #expect(d.ingest(angle: a, t: t) == nil) }
        #expect(d.ingest(angle: 104, t: 3.0) == nil)          // held: re-baselined at 104
        // A nudge from the new position works.
        var got: [String] = []
        for (t, a) in [(4.0, 100.0), (4.1, 98), (4.4, 103.5)] { if let g = d.ingest(angle: a, t: t) { got.append(g.gesture) } }
        #expect(got == ["lid_nudge"])
    }

    @Test func slowChangeIsIgnored() {
        // 5 degrees over 1 s and back over 0.4 s: departure too slow.
        #expect(play([(0, 110), (1.0, 109), (1.3, 108), (1.6, 107), (1.9, 106), (2.0, 105), (2.2, 108), (2.4, 110)]).isEmpty)
    }

    @Test func returnTooLateIsIgnored() {
        #expect(play([(0, 110), (1.0, 106), (1.1, 104), (2.8, 110)]).isEmpty)
    }
}

@Suite struct LightTests {
    /// Samples a light curve every 50 ms, calling poll in between.
    func play(_ value: (Double) -> Double, until: Double) -> [(Double, String)] {
        let d = LightGestureDetector()
        var out: [(Double, String)] = []
        var t = 0.0
        while t <= until {
            if let g = d.ingest(value: value(t), t: t) { out.append((t, g.gesture)) }
            if let g = d.poll(t: t + 0.025) { out.append((t + 0.025, g.gesture)) }
            t += 0.05
        }
        return out
    }

    @Test func quickCover() {
        let g = play({ t in (3.0...3.6).contains(t) ? 0.05 : 0.6 }, until: 6)
        #expect(g.map(\.1) == ["cover"])
    }

    @Test func coverHoldFiresOnceAndReleaseIsSilent() {
        let g = play({ t in (3.0...5.5).contains(t) ? 0.04 : 0.6 }, until: 8)
        #expect(g.map(\.1) == ["cover_hold"])
        if let t = g.first?.0 { #expect(t >= 3.0 + 1.2 && t < 3.0 + 1.35) }
    }

    @Test func holdFiresOnTimeWithOnlyChangeEvents() {
        // Sensor reports only on change: one reading at cover, one at release.
        let d = LightGestureDetector()
        _ = d.ingest(value: 0.5, t: 0)
        _ = d.ingest(value: 0.5, t: 2.8)
        #expect(d.ingest(value: 0.05, t: 3.0) == nil)
        #expect(d.poll(t: 3.9) == nil)
        #expect(d.poll(t: 4.25)?.gesture == "cover_hold")
        #expect(d.poll(t: 4.5) == nil)
        #expect(d.ingest(value: 0.5, t: 5.0) == nil)
    }

    @Test func darkRoomIsIgnored() {
        #expect(play({ t in (3.0...3.5).contains(t) ? 0.0 : 0.03 }, until: 6).isEmpty)
    }

    @Test func slowDimmingIsIgnored() {
        // Lights fade from 0.6 to 0.05 over 3 s and come back over 3 s.
        let g = play({ t in
            if t < 2 { return 0.6 }
            if t < 5 { return 0.6 - 0.55 * (t - 2) / 3 }
            if t < 8 { return 0.05 + 0.55 * (t - 5) / 3 }
            return 0.6
        }, until: 10)
        #expect(g.isEmpty)
    }

    @Test func partialShadowIsIgnored() {
        #expect(play({ t in (3.0...3.5).contains(t) ? 0.3 : 0.6 }, until: 6).isEmpty)
    }
}

@Suite struct PerformanceTests {
    @Test func sixtySecondsIngestQuickly() {
        var b = StreamBuilder(seconds: 60, seed: 81)
        var t = 1.0
        var k = 0
        while t < 59 { b.addTap(ZoneSpec.six[k % 6], at: t); t += 0.5; k += 1 }
        let samples = b.samples()
        let cal = captureCalibration(zones: ZoneSpec.six, perZone: 12, keystrokes: 20)
        let trainer = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { trainer.add(f, label: l) }
        let engine = TapEngine(settings: DetectionSettings())
        engine.model = trainer.train().0
        engine.zonesNeedingMultiTap = ["left-palm"]

        let clock = ContinuousClock()
        var events = 0
        let elapsed = clock.measure {
            for s in samples { events += engine.ingest(s, context: InputContext()).count }
        }
        let seconds = Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18
        print("60 s of IMU (\(samples.count) samples, 116 taps, classified) ingested in \(seconds * 1000) ms")
        #expect(seconds < 1.0)
        #expect(events > 200)
    }
}
