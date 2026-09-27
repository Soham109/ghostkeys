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

    /// A tap whose pulse rings past 80 ms (22% of the real lap taps) is decided only when the pulse ends. A key
    /// pressed after the typing gate's 80 ms tolerance but before that decision was seen neither by the typing gate
    /// (it looks up to onset + 80 ms) nor by the look-ahead (it only looked at events first seen while a group was
    /// already pending), so the double fired although a key went down 95 ms after its second tap
    /// (docs/review/VERIFY_07_DETECTION.md, finding 4).
    @Test func keyDuringALateDecisionStillCancelsTheDouble() {
        // Slow lap-like taps (see addSlowTap) with a 70 ms ring decay, in two directions: zone "a" and zone "b".
        func slowTap(_ b: inout StreamBuilder, at t0: Double, amp: Double, dir: SIMD3<Double>) {
            let i0 = Int((t0 * fs).rounded(.up))
            for k in 0..<Int(0.3 * fs) where i0 + k < b.n {
                let tau = Double(k) / fs
                let v = tau < 0.025 ? 0.5 * (1 - cos(Double.pi * tau / 0.025))
                                    : cos(2 * Double.pi * 30 * (tau - 0.025)) * exp(-(tau - 0.025) / 0.07)
                b.a[i0 + k] += dir * (amp * v)
            }
        }
        let dirs: [String: SIMD3<Double>] = ["a": [0.3, 0.1, 1], "b": [-0.6, 0.4, 0.7]]
        let trainer = Trainer()
        for (z, d) in dirs {
            var b = StreamBuilder(seconds: 12, seed: z == "a" ? 5 : 6)
            let truth = (0..<15).map { 1 + Double($0) * 0.7 }
            for (k, t0) in truth.enumerated() { slowTap(&b, at: t0, amp: 0.1 * (1 + 0.1 * Double(k % 4)), dir: d) }
            for f in run(TapEngine(settings: DetectionSettings()), b.samples()).candidates
            where truth.contains(where: { abs($0 - f.t) < 0.03 }) { trainer.add(f, label: z) }
        }
        let e = TapEngine(settings: DetectionSettings())
        e.model = trainer.train().0
        e.zonesNeedingMultiTap = ["a"]
        var b = StreamBuilder(seconds: 3, seed: 9)
        slowTap(&b, at: 1.0, amp: 0.11, dir: dirs["a"]!)
        slowTap(&b, at: 1.3, amp: 0.11, dir: dirs["a"]!)
        let samples = b.samples()

        let plain = run(e, samples)
        #expect(plain.taps.map(\.zone) == ["a", "a"])
        #expect(plain.gestures.map(\.g.gesture) == ["double"], "\(plain.gestures.map(\.g.gesture))")
        // Premise: the second tap is decided more than 95 ms after its onset.
        let second = try? #require(plain.taps.last)
        let decided = plain.first { if case .tap(let t) = $0.event { return t.t > 1.2 }; return false }?.at ?? 0
        let onset2 = second?.t ?? 0
        #expect(decided - onset2 > 0.1, "decided \(Int((decided - onset2) * 1000)) ms after the onset")

        e.reset()
        let typed = run(e, samples, input: InputScript(keys: [onset2 + 0.095]))
        #expect(typed.gestures.isEmpty, "\(typed.gestures.map(\.g.gesture))")
        e.reset()
        let pointer = run(e, samples, input: InputScript(mouse: [onset2 + 0.095]))
        #expect(pointer.gestures.isEmpty, "\(pointer.gestures.map(\.g.gesture))")
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
        #expect(tight.upgraded().zoneRejectDistances?.allSatisfy { $0 <= 0.5 } ?? true)
    }
}

/// Round 2 (docs/review/DETECTION_ROUND2.md): what feeds the familiarity guard, and per-zone reject distances for
/// upgraded old models.
@Suite struct Round2Tests {
    func result(zone: String = "a", _ distance: Double, _ confidence: Double, outOfDistribution: Bool = false,
                zoneConfidence: Double? = nil) -> ZoneModel.Result {
        ZoneModel.Result(zone: zone, confidence: confidence, x: 0.5, y: 0.5, probabilities: [confidence, 1 - confidence],
                         distance: distance, outOfDistribution: outOfDistribution, zoneConfidence: zoneConfidence)
    }

    var model: ZoneModel {
        var m = ZoneModel(labels: ["a", "b", "none"])
        m.typicalDistance = 2
        return m
    }

    /// Junk the classifier rejects or doubts is not evidence that the user's taps changed: with the live model, one
    /// typing spike past the gates before each tap used to make 61% of taps arrive in strict mode.
    @Test func junkBetweenFamiliarTapsDoesNotMakeTheGuardStrict() {
        var g = FamiliarityGuard()
        var t = 0.0
        for _ in 0..<10 {
            // Two far spikes before every familiar tap: one k-NN called "none", one it only half believed.
            t += 1; _ = g.admit(result(zone: ZoneModel.noneLabel, 9, 0.9), model: model, t: t)
            t += 1; _ = g.admit(result(9, 0.55), model: model, t: t)
            t += 1
            let ok = g.admit(result(2, 0.85), model: model, t: t)
            #expect(ok)
            #expect(!g.isUnfamiliar)
        }
        // The old rule (every candidate is evidence) goes strict on the same stream.
        var old = FamiliarityGuard()
        old.evidence = .everyCandidate
        t = 0
        for _ in 0..<10 {
            t += 1; _ = old.admit(result(zone: ZoneModel.noneLabel, 9, 0.9), model: model, t: t)
            t += 1; _ = old.admit(result(9, 0.55), model: model, t: t)
            t += 1; _ = old.admit(result(2, 0.85), model: model, t: t)
        }
        #expect(old.isUnfamiliar)
    }

    /// The cross-session symptom still switches strict mode on: taps the zone vote is sure about, sitting too far
    /// from their zone, whether the reject distance turned them away or not.
    @Test func confidentFarTapsStillMakeTheGuardStrict() {
        var g = FamiliarityGuard()
        for k in 0..<3 {
            _ = g.admit(result(zone: ZoneModel.noneLabel, 9, 0.7, outOfDistribution: true, zoneConfidence: 0.95),
                        model: model, t: Double(k))
        }
        #expect(g.isUnfamiliar)
        // Far but confident taps no longer fire; clear-cut ones do.
        let tooFar = g.admit(result(7, 0.95), model: model, t: 4)
        #expect(!tooFar)
        let clear = g.admit(result(5, 0.95), model: model, t: 5)
        #expect(clear)

        // Turned away by the reject distance with a doubtful zone vote: junk, not evidence.
        var h = FamiliarityGuard()
        for k in 0..<5 {
            _ = h.admit(result(zone: ZoneModel.noneLabel, 9, 0.7, outOfDistribution: true, zoneConfidence: 0.4),
                        model: model, t: Double(k))
        }
        #expect(!h.isUnfamiliar)
    }

    @Test func memoryStillExpiresWithoutNewEvidence() {
        var g = FamiliarityGuard()
        for k in 0..<5 { _ = g.admit(result(9, 0.95), model: model, t: Double(k)) }
        #expect(g.isUnfamiliar)
        // Only junk arrives after the memory has passed: the old evidence is forgotten.
        _ = g.admit(result(zone: ZoneModel.noneLabel, 9, 0.9), model: model, t: 10 + g.memory)
        #expect(!g.isUnfamiliar)
    }

    @Test func classifierReportsTheZoneVoteOfRejectedTaps() {
        let m = PrecisionTests.trained()
        var tight = m
        tight.rejectDistance = 1e-3                     // everything is out of range
        let cal = captureCalibration(zones: [.rightPalm], perZone: 4, seed: 99)
        #expect(!cal.features.isEmpty)
        for f in cal.features {
            let normal = m.classifyDetailed(f)
            #expect(normal.zoneConfidence == nil)
            guard normal.zone != ZoneModel.noneLabel else { continue }
            let r = tight.classifyDetailed(f)
            #expect(r.zone == ZoneModel.noneLabel && r.outOfDistribution)
            #expect(abs((r.zoneConfidence ?? -1) - normal.confidence) < 1e-9)
        }
    }

    /// Engine level: keystroke-like spikes that get past the input gates (no key event reported, like a palm landing)
    /// between real taps do not switch strict mode on, and every tap still fires.
    @Test func spikesPastTheGatesDoNotMakeTheEngineStrict() {
        let e = TapEngine(settings: DetectionSettings())
        e.model = EngineGrammarTests.model
        var b = StreamBuilder(seconds: 16, seed: 71)
        var truth: [Double] = []
        for k in 0..<10 {
            let t0 = 1 + Double(k) * 1.4
            b.addKeystroke(at: t0)
            b.addKeystroke(at: t0 + 0.45)
            truth.append(b.addTap(.rightPalm, at: t0 + 0.9))
        }
        let events = run(e, b.samples())
        let live = e.model!
        let spikes = events.candidates.filter { f in !truth.contains { abs($0 - f.t) < 0.02 } }
        // Premise: the spikes sit far from the calibration.
        let ratios = spikes.map { live.classifyDetailed($0).distance / live.typicalDistance! }.sorted()
        #expect(spikes.count >= 10)
        #expect(ratios.isEmpty ? false : ratios[ratios.count / 2] > e.familiarity.unfamiliarRatio, "\(ratios)")
        #expect(!e.isUnfamiliar)
        #expect(match(detected: events.taps.filter { $0.zone == "right-palm" }.map(\.t), truth: truth).hits == truth.count)
    }

    // MARK: Per-zone reject distance for upgraded old models

    /// Synthetic feature vectors: five zones with spread 1 ("a", "b", "d", "e", "f") and one wide zone "c" (spread 2).
    static func blobs(perZone: Int, seed: UInt64) -> [(TapFeatures, String)] {
        var rng = Rng(seed)
        let n = TapFeatures.count
        var out: [(TapFeatures, String)] = []
        for (zi, (name, sd)) in [("a", 1.0), ("b", 1.0), ("c", 2.0), ("d", 1.0), ("e", 1.0), ("f", 1.0)].enumerated() {
            for _ in 0..<perZone {
                let v = (0..<n).map { j in (j % 6 == zi ? 8.0 : 0.0) + sd * rng.gaussian() }
                out.append((TapFeatures(values: v, t: 0), name))
            }
        }
        return out
    }

    /// An old-style model (no ensemble, no typical distance, loose reject distance), as saved by earlier builds.
    static func oldModel() -> ZoneModel {
        let t = Trainer()
        for (f, l) in blobs(perZone: 25, seed: 3) { t.add(f, label: l) }
        var m = t.train().0
        m.logistic = nil; m.platt = nil; m.typicalDistance = nil
        m.rejectDistance = 1e6
        return m
    }

    @Test func upgradeGivesAWideZoneRoomAndNeverTightensOrLoosensPastTheRules() throws {
        let up = Self.oldModel().upgraded()
        let limits = try #require(up.zoneRejectDistances)
        let ia = up.labels.firstIndex(of: "a")!, ic = up.labels.firstIndex(of: "c")!
        #expect(limits.allSatisfy { $0 >= up.rejectDistance && $0 <= 1e6 })
        #expect(limits[ic] > 1.05 * up.rejectDistance, "\(limits) pooled \(up.rejectDistance)")
        #expect(up.rejectDistance(forLabel: ia) == up.rejectDistance)
        #expect(up.upgraded().zoneRejectDistances == limits)          // idempotent
        #expect(try jsonRoundTrip(up).zoneRejectDistances == limits)  // saved and loaded

        // Fresh taps of the wide zone: fewer turned away than with the pooled limit alone; the narrow zones unchanged.
        var pooledOnly = up
        pooledOnly.zoneRejectDistances = nil
        let fresh = Self.blobs(perZone: 100, seed: 11)
        func rejected(_ m: ZoneModel, _ zone: String) -> Int {
            fresh.filter { $0.1 == zone }.filter { m.classifyDetailed($0.0).outOfDistribution }.count
        }
        #expect(rejected(up, "c") < rejected(pooledOnly, "c"), "\(rejected(up, "c")) vs \(rejected(pooledOnly, "c"))")
        #expect(rejected(up, "a") == rejected(pooledOnly, "a"))
    }

    @Test func modelsWithoutPerZoneLimitsClassifyAsBefore() throws {
        let m = PrecisionTests.trained()
        #expect(m.zoneRejectDistances == nil)
        #expect(m.upgraded().zoneRejectDistances == nil)              // new models are not upgraded
        #expect(m.rejectDistance(forLabel: 0) == m.rejectDistance)
    }
}
