import Testing
@testable import GhostkeysDetection

/// Round 3 (docs/review/DETECTION_ROUND3.md): calibration gravity, ZoneModelSet (one model per posture, picked by
/// gravity with hysteresis, plus tap evidence), and the engine's gravity accessor.
@Suite struct PostureTests {
    let flat = rolledGravity(0)

    // MARK: Gravity on features and models, and old files

    @Test func featuresWithoutGravityStillDecodeAndNilIsNotWritten() throws {
        let old = try decodeJSON(TapFeatures.self, #"{"values":[1,2,3],"t":4.5}"#)
        #expect(old.gravity == nil && old.values == [1, 2, 3] && old.t == 4.5)
        #expect(try !jsonKeys(TapFeatures(values: [1], t: 0)).contains("gravity"))
        let g = SIMD3<Double>(0.1, -0.2, -0.97)
        #expect(try jsonRoundTrip(TapFeatures(values: [1], t: 0, gravity: g)).gravity == g)
    }

    @Test func trainerStoresTheMeanCalibrationGravity() throws {
        let tilt = rolledGravity(10)
        // Gravity vectors of different lengths and a little scatter: the mean direction is what counts.
        var xs = postureBlobs(perZone: 15, seed: 1)
        for i in xs.indices {
            let wobble = rolledGravity(10 + (i % 2 == 0 ? 1.0 : -1.0))
            xs[i].0.gravity = wobble * (i % 3 == 0 ? 0.98 : 1.02)
        }
        let m = trainBlobs(xs)
        let g = try #require(m.calibrationGravity)
        #expect(ZoneModelSet.angleDegrees(g, tilt) < 0.2)
        #expect(abs((g * g).sum() - 1) < 1e-9)
        let spread = try #require(m.calibrationGravitySpread)
        #expect(spread > 0.5 && spread < 1.5)
        #expect(try #require(m.gravityAngle(to: flat)) > 9.5)

        // Samples without gravity: no calibration gravity. A minority with gravity: none either.
        #expect(trainBlobs(postureBlobs(perZone: 15, seed: 1)).calibrationGravity == nil)
        var few = postureBlobs(perZone: 15, seed: 1)
        for i in 0..<10 { few[i].0.gravity = tilt }
        #expect(trainBlobs(few).calibrationGravity == nil)

        // The Trainer hands the gravity back with its samples (the daemon saves them).
        let t = Trainer()
        t.add(xs[0].0, label: xs[0].1)
        #expect(t.samples.first?.features.gravity == xs[0].0.gravity)
    }

    @Test func oldSavedModelsWithoutGravityStillLoadAndClassifyTheSame() throws {
        var xs = postureBlobs(perZone: 15, seed: 2)
        for i in xs.indices { xs[i].0.gravity = flat }
        let m = trainBlobs(xs)
        #expect(m.calibrationGravity != nil)
        #expect(try jsonRoundTrip(m).calibrationGravity == m.calibrationGravity)
        let old = try withoutKeys(m, ["calibrationGravity", "calibrationGravitySpread"])
        #expect(old.calibrationGravity == nil && old.calibrationGravitySpread == nil)
        for (f, _) in postureBlobs(perZone: 5, seed: 9) {
            let a = m.classifyDetailed(f), b = old.classifyDetailed(f)
            #expect(a.zone == b.zone && a.confidence == b.confidence && a.distance == b.distance)
        }
    }

    // MARK: The engine's gravity

    @Test func engineStampsGravityOnCandidatesAndExposesIt() throws {
        let tilt = rolledGravity(15)
        var b = StreamBuilder(seconds: 4, seed: 5, gravity: tilt * 0.99)
        var truth: [Double] = []
        for k in 0..<4 { truth.append(b.addTap(.rightPalm, at: 1 + Double(k) * 0.6)) }
        let e = TapEngine(settings: DetectionSettings())
        #expect(e.gravityDirection == nil)
        let events = run(e, b.samples())
        let cands = events.candidates.filter { f in truth.contains { abs($0 - f.t) < 0.02 } }
        #expect(cands.count == truth.count)
        for c in cands { #expect(ZoneModelSet.angleDegrees(try #require(c.gravity), tilt) < 1) }
        #expect(ZoneModelSet.angleDegrees(try #require(e.gravityDirection), tilt) < 1)
    }

    // MARK: ZoneModelSet: gravity and hysteresis

    /// Two models that differ only in their calibration gravity.
    func deskAndLap(lapDegrees: Double = 12, deskGravity: Bool = true) -> ZoneModelSet {
        let base = trainBlobs(postureBlobs(perZone: 15, seed: 3))
        var desk = base, lap = base
        desk.calibrationGravity = deskGravity ? flat : nil
        lap.calibrationGravity = rolledGravity(lapDegrees)
        return ZoneModelSet(models: ["desk": desk, "lap": lap])
    }

    @Test func aSingleModelIsAlwaysActive() throws {
        var s = ZoneModelSet(single: trainBlobs(postureBlobs(perZone: 15, seed: 3)))
        #expect(s.isSingle && s.activePosture == "desk" && s.activeModel != nil)
        for k in 0..<50 { do { let c = s.update(gravity: rolledGravity(Double(k)), t: Double(k)); #expect(!c) } }
        #expect(s.activePosture == "desk" && s.isPlaced)
        #expect(s.gravityAngle == nil)   // the model has no calibration gravity
        var withGravity = s.activeModel!
        withGravity.calibrationGravity = flat
        var s2 = ZoneModelSet(single: withGravity, posture: "lap")
        s2.update(gravity: rolledGravity(7), t: 0)
        #expect(s2.activePosture == "lap" && abs(s2.gravityAngle! - 7) < 0.01)
    }

    @Test func firstPlacementIsImmediateAndLaterSwitchesNeedTheHold() {
        var s = deskAndLap()
        #expect(s.activePosture == "desk" && !s.isPlaced)            // fallback before any gravity
        do { let c = s.update(gravity: rolledGravity(12), t: 0); #expect(c) }   // placed at once, no hold
        #expect(s.activePosture == "lap" && abs(s.gravityAngle! - 0) < 0.01)

        // Back to the desk: 12 degrees closer, but only after 1 s without a break.
        var switchedAt: Double?
        var t = 1.0
        while t < 3 { if s.update(gravity: flat, t: t), switchedAt == nil { switchedAt = t }; t += 0.01 }
        #expect(s.activePosture == "desk")
        #expect(abs(switchedAt! - 2.0) < 0.02, "\(switchedAt!)")
        #expect(s.angles(to: flat)["lap"].map { abs($0 - 12) < 0.01 } == true)
    }

    @Test func smallDifferencesShortExcursionsAndMotionDoNotSwitch() {
        var s = deskAndLap()
        s.update(gravity: flat, t: 0)
        #expect(s.activePosture == "desk")
        // 7 degrees: lap is only 5 away versus 7 for the desk (2 < the 5 degree margin).
        for k in 0..<500 { s.update(gravity: rolledGravity(7), t: 1 + Double(k) * 0.01) }
        #expect(s.activePosture == "desk")
        // A 0.6 s trip to the lap posture and back.
        for k in 0..<60 { s.update(gravity: rolledGravity(12), t: 10 + Double(k) * 0.01) }
        for k in 0..<200 { s.update(gravity: flat, t: 10.6 + Double(k) * 0.01) }
        #expect(s.activePosture == "desk")
        // At the lap posture for 3 s, but the machine is moving the whole time.
        for k in 0..<300 { s.update(gravity: rolledGravity(12), t: 20 + Double(k) * 0.01, moving: true) }
        #expect(s.activePosture == "desk")
        // It stops moving: 1 s later the lap model takes over.
        for k in 0..<99 { s.update(gravity: rolledGravity(12), t: 23 + Double(k) * 0.01) }
        #expect(s.activePosture == "desk")
        s.update(gravity: rolledGravity(12), t: 24.0)
        #expect(s.activePosture == "lap")
    }

    @Test func modelsWithoutGravityAreTheFallbackAtAFixedAngle() {
        // A legacy desk model (no gravity) and a lap model: the legacy one counts as 15 degrees away.
        var s = deskAndLap(lapDegrees: 12, deskGravity: false)
        #expect(!s.hasGravityForEveryModel)
        s.update(gravity: rolledGravity(40), t: 0)       // 28 degrees from the lap: the legacy model is nearer
        #expect(s.activePosture == "desk")
        s.update(gravity: rolledGravity(12), t: 1)
        s.update(gravity: rolledGravity(12), t: 2)
        #expect(s.activePosture == "lap")
        // The known limit: on the flat desk the lap model (12 degrees) is still nearer than 15, so it stays.
        for k in 0..<300 { s.update(gravity: flat, t: 3 + Double(k) * 0.01) }
        #expect(s.activePosture == "lap")
        #expect(deskAndLap().hasGravityForEveryModel)
    }

    @Test func selectAndResetAndCodable() throws {
        var s = deskAndLap()
        s.switchMarginDegrees = 7
        s.update(gravity: flat, t: 0)
        do { let c = s.select("stand"); #expect(!c) }
        do { let c = s.select("lap"); #expect(c && s.activePosture == "lap") }
        s.resetSelection()
        #expect(!s.isPlaced)
        do { let c = s.update(gravity: flat, t: 1); #expect(c && s.activePosture == "desk") }

        let back = try jsonRoundTrip(s)
        #expect(back.postures == ["desk", "lap"] && back.switchMarginDegrees == 7 && back.fallbackPosture == "desk")
        #expect(back.models["lap"]?.calibrationGravity == s.models["lap"]?.calibrationGravity)
        #expect(!back.isPlaced && back.activePosture == "desk")        // selection state starts fresh
        let older = try decodeJSON(ZoneModelSet.self, #"{"models":{}}"#)
        #expect(older.models.isEmpty && older.activeModel == nil && older.switchHoldSeconds == 1)
    }

    // MARK: ZoneModelSet: tap evidence

    /// Desk and lap models whose taps look different (features 20...25 shifted), same calibration gravity unless given.
    func evidenceSet(lapGravity: SIMD3<Double>? = nil) -> ZoneModelSet {
        var desk = trainBlobs(postureBlobs(perZone: 20, seed: 4))
        var lap = trainBlobs(postureBlobs(perZone: 20, seed: 5, shift: 25))
        desk.calibrationGravity = flat
        lap.calibrationGravity = lapGravity ?? flat
        var s = ZoneModelSet(models: ["desk": desk, "lap": lap])
        s.update(gravity: flat, t: 0)
        return s
    }

    @Test func tapsThatFitAnotherPostureSwitchAfterTwoInARow() {
        var s = evidenceSet()
        #expect(s.activePosture == "desk")
        let lapTaps = postureBlobs(perZone: 4, seed: 6, shift: 25).map(\.0)
        let deskTaps = postureBlobs(perZone: 4, seed: 7).map(\.0)
        // Desk taps never move it.
        for (k, f) in deskTaps.enumerated() { do { let c = s.observe(f, t: 1 + Double(k)); #expect(!c) } }
        // One lap tap is not enough; a desk tap in between breaks the run.
        do { let c = s.observe(lapTaps[0], t: 20); #expect(!c) }
        do { let c = s.observe(deskTaps[0], t: 21); #expect(!c) }
        do { let c = s.observe(lapTaps[1], t: 22); #expect(!c) }
        #expect(s.activePosture == "desk")
        do { let c = s.observe(lapTaps[2], t: 23); #expect(c) }
        #expect(s.activePosture == "lap")
        // And back: two desk taps.
        do { let c = s.observe(deskTaps[1], t: 30); #expect(!c) }
        do { let c = s.observe(deskTaps[2], t: 31); #expect(c) }
        #expect(s.activePosture == "desk")
        // Too far apart in time: the first has expired.
        do { let c = s.observe(lapTaps[3], t: 40); #expect(!c) }
        do { let c = s.observe(lapTaps[4], t: 80); #expect(!c) }
        #expect(s.activePosture == "desk")
        // Off: gravity alone decides.
        var off = evidenceSet()
        off.tapEvidence = false
        for (k, f) in lapTaps.enumerated() { do { let c = off.observe(f, t: Double(k)); #expect(!c) } }
    }

    @Test func junkThatNoModelTakesForATapIsNotEvidence() {
        var s = evidenceSet()
        var rng = Rng(8)
        for k in 0..<40 {
            let v = (0..<TapFeatures.count).map { _ in 60 * rng.gaussian() }
            do { let c = s.observe(TapFeatures(values: v, t: 0), t: Double(k)); #expect(!c) }
        }
        #expect(s.activePosture == "desk")
    }

    @Test func afterATapSwitchGravityWaitsUntilTheMachineTurns() {
        // The lap model's calibration gravity is 12 degrees away, but the user is on a flat lap: taps say lap.
        var s = evidenceSet(lapGravity: rolledGravity(12))
        let lapTaps = postureBlobs(perZone: 2, seed: 6, shift: 25).map(\.0)
        s.observe(lapTaps[0], t: 1)
        do { let c = s.observe(lapTaps[1], t: 2); #expect(c) }
        #expect(s.activePosture == "lap")
        // Gravity says desk (12 degrees closer) for 5 s: the taps' decision holds.
        for k in 0..<500 { s.update(gravity: flat, t: 3 + Double(k) * 0.01) }
        #expect(s.activePosture == "lap")
        // The machine is turned by 20 degrees the other way: now gravity decides again (desk is nearer).
        for k in 0..<200 { s.update(gravity: rolledGravity(-20), t: 10 + Double(k) * 0.01) }
        #expect(s.activePosture == "desk")
    }

    // MARK: Training one model per posture

    @Test func trainsOneModelPerPostureAndBorrowsMissingZones() throws {
        var samples: [ZoneModelSet.PostureSample] = []
        for (f, l) in postureBlobs(perZone: 15, seed: 10, gravity: flat) { samples.append(.init(features: f, label: l, posture: "desk")) }
        for (f, l) in postureBlobs(perZone: 15, seed: 11, shift: 25, zones: ["a", "b"], gravity: rolledGravity(9)) {
            samples.append(.init(features: f, label: l, posture: "lap"))
        }
        let r = ZoneModelSet.train(samples)
        #expect(r.set.postures == ["desk", "lap"])
        #expect(r.borrowedZones["lap"] == ["c"] && r.borrowedZones["desk"] == [])
        let lap = try #require(r.set.models["lap"])
        #expect(lap.labels.contains("c"))
        // Gravity from the posture's own samples only (the borrowed desk samples do not pull it).
        #expect(try #require(lap.gravityAngle(to: rolledGravity(9))) < 0.1)
        #expect(try #require(r.set.models["desk"]?.gravityAngle(to: flat)) < 0.1)
        #expect(r.reports["lap"] != nil && r.set.hasGravityForEveryModel)

        // Unknown posture counts as the legacy one; too few taps in a posture: one model for everything.
        let legacy = samples.map { ZoneModelSet.PostureSample(features: $0.features, label: $0.label, posture: $0.posture == "desk" ? nil : "lap") }
        #expect(ZoneModelSet.train(legacy).set.postures == ["desk", "lap"])
        let single = ZoneModelSet.train(samples, minZoneTaps: 100)
        #expect(single.set.isSingle && single.set.postures == ["desk"])
        #expect(single.set.activeModel?.labels.contains("c") == true)
    }

    // MARK: The engine with a model set

    @Test func engineFollowsGravityBetweenPostureModels() throws {
        let base = PrecisionTests.trained()
        var desk = base, lap = base
        desk.calibrationGravity = flat
        lap.calibrationGravity = rolledGravity(20)
        let e = TapEngine(settings: DetectionSettings())
        e.modelSet = ZoneModelSet(models: ["desk": desk, "lap": lap])
        #expect(e.activePosture == "desk" && e.model != nil)
        #expect(e.model?.typicalDistance != nil)

        // 3 s flat, then the machine is tilted by 20 degrees over 0.5 s and stays there.
        var b = StreamBuilder(seconds: 9, seed: 12)
        b.addRoll(at: 3, degrees: 20, ramp: 0.5, hold: 100, back: false)
        var switchedAt: Double?
        for s in b.samples() {
            _ = e.ingest(s, context: InputContext())
            if switchedAt == nil, e.activePosture == "lap" { switchedAt = s.t }
            if s.t < 3 { #expect(e.activePosture == "desk") }
        }
        let t = try #require(switchedAt)
        #expect(t >= 4.5 && t < 6, "\(t)")      // after the ramp, the motion gate and the 1 s hold
        #expect(try #require(e.postureGravityAngle) < 1.5)
        #expect(e.model?.calibrationGravity == lap.calibrationGravity)

        // Zone centres go to every posture model; mutating the live model writes it back into the set.
        e.setZoneCenters(["right-palm": [0.7, 0.9]])
        #expect(e.modelSet?.models.values.allSatisfy { $0.zoneCenters["right-palm"] == [0.7, 0.9] } == true)
        e.model?.positionBlend = 0.25
        #expect(e.modelSet?.models["lap"]?.positionBlend == 0.25 && e.modelSet?.models["desk"]?.positionBlend != 0.25)
        #expect(e.activePosture == "lap")
        // Assigning nil removes the set.
        e.model = nil
        #expect(e.modelSet == nil && e.activePosture == nil)
    }

    @Test func engineWithoutASetBehavesAsBefore() {
        let e = TapEngine(settings: DetectionSettings())
        e.model = PrecisionTests.trained()
        #expect(e.modelSet == nil && e.activePosture == nil && e.postureGravityAngle == nil)
    }
}
