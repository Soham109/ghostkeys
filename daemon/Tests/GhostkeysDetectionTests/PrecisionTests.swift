import Darwin
import Testing
@testable import GhostkeysDetection

/// The 27 Sep 2026 precision and double-tap fixes (docs/review/DETECTION_AUDIT.md). Measured on real data with
/// daemon/analysis/bench; these tests pin the mechanisms.
@Suite struct PrecisionTests {
    /// A lap-like tap as in the real recording: a smooth 25 ms raised-cosine rise (the detection level grows about
    /// 1.5x per sample, never 2x), then a 30 Hz ring that decays over ~50 ms.
    static func addSlowTap(_ b: inout StreamBuilder, at t0: Double, amp: Double) {
        let rise = 0.025
        let i0 = Int((t0 * fs).rounded(.up))
        for k in 0..<Int(0.3 * fs) where i0 + k < b.n {
            let tau = Double(k) / fs
            let v = tau < rise ? 0.5 * (1 - cos(Double.pi * tau / rise))
                               : cos(2 * Double.pi * 30 * (tau - rise)) * exp(-(tau - rise) / 0.05)
            b.a[i0 + k] += SIMD3(0.3, 0.1, 1) * (amp * v)
        }
    }

    static func onsets(_ samples: [IMUSample], tailSkip: Int) -> [Double] {
        var d = OnsetDetector()
        d.tailSkip = tailSkip
        var out: [Double] = []
        for (i, s) in samples.enumerated() {
            if case .onset(let info) = d.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t, index: i) { out.append(info.t) }
        }
        return out
    }

    /// The second tap of a double lands in the first tap's ringing-tail guard. The guard compared it with the
    /// whole preceding 25 ms, which contains its own rising edge, so it only triggered when the guard expired,
    /// tens of milliseconds into the pulse (then the features were too far off to be recognised).
    @Test func secondTapOfADoubleTriggersOnTime() {
        var b = StreamBuilder(seconds: 3, seed: 81)
        Self.addSlowTap(&b, at: 1.0, amp: 0.12)
        Self.addSlowTap(&b, at: 1.3, amp: 0.12)
        let samples = b.samples()
        let fixed = Self.onsets(samples, tailSkip: OnsetDetector().tailSkip)
        let old = Self.onsets(samples, tailSkip: 0)
        let second = fixed.first { $0 > 1.2 }
        #expect(second.map { $0 - 1.3 } ?? 1 < 0.012, "fixed: \(fixed)")
        let oldSecond = old.first { $0 > 1.2 }
        #expect(oldSecond.map { $0 - 1.3 } ?? 1 > 0.02, "the old rule should have been late: \(old)")
    }

    @Test func slowRingingTapStillTriggersOnce() {
        var b = StreamBuilder(seconds: 3, seed: 82)
        Self.addSlowTap(&b, at: 1.0, amp: 0.4)
        let found = Self.onsets(b.samples(), tailSkip: OnsetDetector().tailSkip)
        #expect(found.count == 1, "\(found)")
    }

    // MARK: Look-ahead

    @Test func typingRightAfterADoubleCancelsIt() {
        let e = TapEngine(settings: DetectionSettings())
        e.model = EngineGrammarTests.model
        e.zonesNeedingMultiTap = ["right-grille"]
        var b = StreamBuilder(seconds: 3, seed: 62)
        b.addTap(.rightGrille, at: 1.0, amp: 0.2)
        b.addTap(.rightGrille, at: 1.2, amp: 0.2)
        let samples = b.samples()
        let typed = run(e, samples, input: InputScript(keys: [1.35]))
        #expect(typed.taps.count == 2)
        #expect(typed.gestures.isEmpty, "\(typed.gestures.map(\.g.gesture))")

        e.reset()
        let pointer = run(e, samples, input: InputScript(mouse: [1.3]))
        #expect(pointer.gestures.isEmpty, "\(pointer.gestures.map(\.g.gesture))")

        e.reset()
        let later = run(e, samples, input: InputScript(keys: [1.8]))   // well after the window: the double stands
        #expect(later.gestures.map(\.g.gesture) == ["double"])
    }

    // MARK: Familiarity guard

    func result(_ distance: Double, _ confidence: Double) -> ZoneModel.Result {
        ZoneModel.Result(zone: "a", confidence: confidence, x: 0.5, y: 0.5, probabilities: [confidence, 1 - confidence],
                         distance: distance, outOfDistribution: false)
    }

    @Test func guardGoesStrictWhenTapsStopLookingLikeTheCalibration() {
        var m = ZoneModel(labels: ["a", "b"])
        m.typicalDistance = 2
        var g = FamiliarityGuard()
        // Familiar: anything goes through (minConfidence is the engine's business).
        for k in 0..<8 { let ok = g.admit(result(2, 0.85), model: m, t: Double(k)); #expect(ok) }
        #expect(!g.isUnfamiliar)
        // Far from the calibration for a while: strict mode.
        for k in 0..<5 { _ = g.admit(result(8, 0.85), model: m, t: 10 + Double(k)) }
        #expect(g.isUnfamiliar)
        let far = g.admit(result(8, 0.99), model: m, t: 20)
        #expect(!far)                                              // too far
        let unsure = g.admit(result(4, 0.85), model: m, t: 21)
        #expect(!unsure)                                           // not confident enough
        let clear = g.admit(result(4, 0.95), model: m, t: 22)
        #expect(clear)                                             // clear-cut: still fires
        // Back in the calibrated posture: recovers.
        for k in 0..<6 { _ = g.admit(result(2, 0.95), model: m, t: 30 + Double(k)) }
        #expect(!g.isUnfamiliar)
        // Old observations are forgotten.
        for k in 0..<8 { _ = g.admit(result(8, 0.85), model: m, t: 40 + Double(k)) }
        #expect(g.isUnfamiliar)
        let fresh = g.admit(result(2, 0.85), model: m, t: 40 + g.memory + 20)
        #expect(fresh)
        #expect(!g.isUnfamiliar)
    }

    @Test func guardIgnoresModelsWithoutATypicalDistance() {
        var g = FamiliarityGuard()
        let m = ZoneModel(labels: ["a", "b"])
        for k in 0..<10 { let ok = g.admit(result(100, 0.8), model: m, t: Double(k)); #expect(ok) }
        #expect(!g.isUnfamiliar)
    }

    // MARK: Reject distance and old models

    static func trained() -> ZoneModel {
        let cal = captureCalibration(zones: [.leftPalm, .rightPalm, .rightGrille], perZone: 12, keystrokes: 15)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        return t.train().0
    }

    @Test func newModelsCarryTheirTypicalDistance() {
        let m = Self.trained()
        let typical = try! #require(m.typicalDistance)
        #expect(typical > 0 && m.rejectDistance > typical && m.rejectDistance < 1e300)
    }

    @Test func oldModelsAreUpgradedWhenLoaded() throws {
        var old = Self.trained()
        old.typicalDistance = nil
        old.rejectDistance = 1e6                       // as loose as the user's live model effectively was
        let saved = try jsonRoundTrip(old)             // nil optionals are omitted, as in files from older builds
        #expect(saved.typicalDistance == nil)

        let e = TapEngine(settings: DetectionSettings())
        e.model = saved
        let live = try #require(e.model)
        #expect(live.typicalDistance != nil)
        #expect(live.rejectDistance < 1e6)
        #expect(live.upgraded().rejectDistance == live.rejectDistance)   // idempotent
        #expect(e.isUnfamiliar == false)

        // Never loosened.
        var tight = saved
        tight.rejectDistance = 0.5
        #expect(tight.upgraded().rejectDistance == 0.5)
    }
}
