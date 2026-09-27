import Darwin
import Testing
@testable import GhostkeysDetection

@Suite struct ClassifierTests {
    static func trained(zones: [ZoneSpec], perZone: Int, keystrokes: Int = 0, seed: UInt64 = 7) -> (ZoneModel, CalibrationReport) {
        let cal = captureCalibration(zones: zones, perZone: perZone, keystrokes: keystrokes, seed: seed)
        let trainer = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { trainer.add(f, label: l) }
        return trainer.train()
    }

    /// Fresh taps (different seed) for testing a trained model.
    static func testSet(zones: [ZoneSpec], perZone: Int, seed: UInt64) -> [(TapFeatures, String)] {
        let cal = captureCalibration(zones: zones, perZone: perZone, seed: seed)
        return Array(zip(cal.features, cal.labels))
    }

    @Test func sixZonesTwentyEach() {
        let (model, report) = Self.trained(zones: ZoneSpec.six, perZone: 20)
        #expect(report.labels.count == 7)   // 6 zones + none column
        #expect(report.overall > 0.9, "overall \(report.overall) \(report.accuracy)")
        for z in ZoneSpec.six { #expect((report.accuracy[z.name] ?? 0) > 0.8, "\(z.name) \(report.accuracy)") }
        // Confusion matrix rows add up to the number of samples per zone.
        for (i, name) in report.labels.enumerated() where name != "none" { #expect(report.confusion[i].reduce(0, +) == 20) }

        let test = Self.testSet(zones: ZoneSpec.six, perZone: 25, seed: 1234)
        let correct = test.filter { model.classify($0.0).zone == $0.1 }.count
        #expect(Double(correct) / Double(test.count) > 0.9, "held-out \(correct)/\(test.count)")
    }

    @Test func fourZonesTenEach() {
        let zones: [ZoneSpec] = [.leftPalm, .rightPalm, .leftGrille, .topStrip]
        let (model, report) = Self.trained(zones: zones, perZone: 10)
        #expect(report.overall > 0.9, "overall \(report.overall) \(report.accuracy)")
        let test = Self.testSet(zones: zones, perZone: 25, seed: 555)
        let correct = test.filter { model.classify($0.0).zone == $0.1 }.count
        #expect(Double(correct) / Double(test.count) > 0.9, "held-out \(correct)/\(test.count)")
    }

    @Test func confidenceIsHighForCleanTaps() {
        let (model, _) = Self.trained(zones: ZoneSpec.six, perZone: 20)
        let test = Self.testSet(zones: ZoneSpec.six, perZone: 15, seed: 77)
        let confident = test.filter { let r = model.classify($0.0); return r.zone == $0.1 && r.confidence >= 0.8 }.count
        #expect(Double(confident) / Double(test.count) > 0.85, "\(confident)/\(test.count)")
        for (f, _) in test {
            let r = model.classify(f)
            #expect(r.confidence >= 0 && r.confidence <= 1)
            #expect(r.x >= 0 && r.x <= 1 && r.y >= 0 && r.y <= 1)
        }
    }

    @Test func noneClassWinsForKeystrokes() {
        let (model, report) = Self.trained(zones: ZoneSpec.six, perZone: 20, keystrokes: 60)
        #expect(report.labels.last == "none")
        #expect(report.overall > 0.9, "overall \(report.overall) \(report.accuracy)")

        // New keystrokes (captured the same way, different seed) must come out as none.
        var b = StreamBuilder(seconds: 1 + 80 * 0.25, seed: 4242)
        for k in 0..<80 { b.addKeystroke(at: 1 + Double(k) * 0.25) }
        let engine = TapEngine(settings: DetectionSettings())
        engine.bypassInputGates = true
        let keys = run(engine, b.samples()).candidates
        #expect(keys.count >= 75)
        let asNone = keys.filter { model.classify($0).zone == "none" }.count
        #expect(Double(asNone) / Double(keys.count) >= 0.9, "\(asNone)/\(keys.count) keystrokes rejected")

        // And the zones still work.
        let test = Self.testSet(zones: ZoneSpec.six, perZone: 20, seed: 99)
        let correct = test.filter { model.classify($0.0).zone == $0.1 }.count
        #expect(Double(correct) / Double(test.count) > 0.9, "held-out \(correct)/\(test.count)")
    }

    @Test func rejectOptionWithoutNegatives() {
        // Trained on palm rests only; edge hits and the lid are nowhere near that.
        let (model, _) = Self.trained(zones: [.leftPalm, .rightPalm], perZone: 20)
        #expect(model.rejectDistance < 1e300)
        let others = Self.testSet(zones: [.leftEdge, .rightEdge, .lid], perZone: 10, seed: 31)
        let rejected = others.filter { model.classify($0.0).zone == "none" }.count
        #expect(Double(rejected) / Double(others.count) >= 0.9, "\(rejected)/\(others.count)")
        let same = Self.testSet(zones: [.leftPalm, .rightPalm], perZone: 20, seed: 32)
        let kept = same.filter { model.classify($0.0).zone == $0.1 }.count
        #expect(Double(kept) / Double(same.count) >= 0.9, "\(kept)/\(same.count)")
    }

    @Test func realDeskWobblesAreNotTaps() {
        let (model, _) = Self.trained(zones: ZoneSpec.six, perZone: 20, keystrokes: 40)
        let engine = TapEngine(settings: DetectionSettings())
        engine.model = model
        let events = run(engine, restRecording())
        #expect(events.taps.isEmpty, "\(events.taps)")
    }

    @Test func positionsFollowZones() {
        let (model, _) = Self.trained(zones: ZoneSpec.six, perZone: 20)
        let test = Self.testSet(zones: [.leftPalm, .rightPalm, .topStrip], perZone: 10, seed: 8)
        for (f, label) in test {
            let r = model.classify(f)
            guard r.zone == label, let c = ZoneModel.defaultZoneCenters[label] else { continue }
            #expect(abs(r.x - c[0]) < 0.2 && abs(r.y - c[1]) < 0.2, "\(label) at \(r.x),\(r.y)")
        }
        // Custom centres from the config move the answer.
        var m2 = model
        m2.setZoneCenters(["left-palm": [0.3, 0.7]])
        let lp = test.first { $0.1 == "left-palm" }!.0
        let r = m2.classify(lp)
        #expect(abs(r.x - 0.3) < 0.2 && abs(r.y - 0.7) < 0.2)
    }

    @Test func modelRoundTripsThroughJSON() throws {
        let (model, report) = Self.trained(zones: [.leftPalm, .rightGrille, .topStrip], perZone: 12, keystrokes: 20)
        let back = try jsonRoundTrip(model)
        #expect(back.labels == model.labels)
        let test = Self.testSet(zones: [.leftPalm, .rightGrille, .topStrip], perZone: 5, seed: 3)
        for (f, _) in test {
            let a = model.classify(f), b = back.classify(f)
            #expect(a.zone == b.zone && abs(a.confidence - b.confidence) < 1e-9)
        }
        _ = try jsonRoundTrip(report)
        // An untrained model (and one with no reject threshold) still encodes.
        _ = try jsonRoundTrip(ZoneModel(labels: []))
    }

    @Test func untrainedModelSaysNone() {
        let f = TapFeatures(values: Array(repeating: 0, count: TapFeatures.count), t: 0)
        #expect(ZoneModel(labels: ["a"]).classify(f).zone == "none")
        let (m, r) = Trainer().train()
        #expect(m.classify(f).zone == "none")
        #expect(r.overall == 0)
    }

    @Test func trainerCountsAndRemoval() {
        let t = Trainer()
        let f = TapFeatures(values: Array(repeating: 1, count: TapFeatures.count), t: 0)
        t.add(f, label: "a"); t.add(f, label: "a"); t.add(f, label: "b")
        t.add(TapFeatures(values: [1, 2], t: 0), label: "a")   // wrong length: ignored
        #expect(t.counts == ["a": 2, "b": 1])
        t.removeAll(label: "a")
        #expect(t.counts == ["b": 1])
        t.removeAll()
        #expect(t.counts.isEmpty)
    }
}


@Suite struct ZoneRecommendationTests {
    // The first real calibration report (labels, confusion and accuracy as saved by the daemon).
    static let realReport = CalibrationReport(
        labels: ["left-edge", "left-grille", "left-palm", "lid", "right-grille", "right-palm", "top-strip", "none"],
        accuracy: ["left-edge": 0.2857, "left-grille": 0.9, "left-palm": 0.95, "lid": 0.65, "none": 0.645,
                   "right-grille": 0.9286, "right-palm": 0.95, "top-strip": 0.9],
        overall: 0.80,
        confusion: [[2, 1, 0, 3, 1, 0, 0, 0], [0, 18, 0, 2, 0, 0, 0, 0], [0, 0, 19, 0, 0, 1, 0, 0],
                    [1, 3, 0, 13, 1, 0, 0, 2], [0, 0, 0, 1, 13, 0, 0, 0], [0, 0, 1, 0, 0, 19, 0, 0],
                    [0, 0, 0, 1, 0, 0, 18, 1], [3, 3, 0, 2, 1, 1, 1, 20]])

    @Test func dropsWeakZonesOfTheRealCalibration() {
        let r = recommendedZones(Self.realReport)
        #expect(Set(r.drop.keys) == ["left-edge", "lid"])
        #expect(r.keep == ["left-grille", "left-palm", "right-grille", "right-palm", "top-strip"])
        #expect(r.drop["left-edge"]?.contains("7 taps") == true)
        #expect(!r.keep.contains("none"))
    }

    @Test func suggestsMergingTwoZonesThatAreConfusedWithEachOther() {
        let report = CalibrationReport(labels: ["a", "b", "c", "none"], accuracy: ["a": 0.6, "b": 0.65, "c": 0.95],
                                       overall: 0.73,
                                       confusion: [[12, 8, 0, 0], [7, 13, 0, 0], [0, 1, 19, 0], [0, 0, 0, 10]])
        let r = recommendedZones(report)
        #expect(r.merge == [["a", "b"]])
        #expect(r.keep == ["c"])
    }

    @Test func iterativeRecommendationOnSyntheticZones() {
        let cal = captureCalibration(zones: [.leftPalm, .rightPalm, .topStrip], perZone: 12, keystrokes: 10)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        // Five taps of a fourth zone: too few, must be dropped; the rest kept.
        let few = captureCalibration(zones: [.lid], perZone: 5, seed: 3)
        for (f, l) in zip(few.features, few.labels) { t.add(f, label: l) }
        let r = t.recommendedZones()
        #expect(Set(r.keep) == ["left-palm", "right-palm", "top-strip"])
        #expect(Array(r.drop.keys) == ["lid"])
    }

    @Test func settingsDecodeWithoutNewKeys() throws {
        // A config written before followUpConfidence existed.
        let s = try jsonDecodeSettings(#"{"sensitivity":0.4,"minConfidence":0.85,"hud":true}"#)
        #expect(s.sensitivity == 0.4 && s.minConfidence == 0.85 && s.followUpConfidence == 0.5 && s.typingGateMs == 450)
    }
}

@Suite struct EnsembleTests {
    @Test func logisticRegressionLearnsASimpleProblem() {
        var rng = Rng(1)
        var x: [[Double]] = [], y: [Int] = []
        for i in 0..<120 {
            let c = i % 3
            x.append([Double(c) * 2 + rng.gaussian() * 0.5, rng.gaussian(), Double(c == 1 ? 1 : 0) + rng.gaussian() * 0.3])
            y.append(c)
        }
        let m = LogisticModel.fit(x, y, classes: 3)
        let acc = zip(x, y).filter { xi, yi in let p = m.probabilities(xi); return p.firstIndex(of: p.max()!) == yi }.count
        #expect(Double(acc) / 120 > 0.9)
        #expect(abs(m.probabilities(x[0]).reduce(0, +) - 1) < 1e-9)
    }

    @Test func plattScalingIsMonotoneAndFitsRates() {
        // Raw 0.9 is right 95% of the time, raw 0.6 only 50%.
        var raw: [Double] = [], ok: [Bool] = []
        for i in 0..<100 { raw.append(0.9); ok.append(i % 20 != 0) }
        for i in 0..<100 { raw.append(0.6); ok.append(i % 2 == 0) }
        let p = PlattScaling.fit(raw: raw, correct: ok)!
        #expect(p.apply(0.9) > p.apply(0.6))
        #expect(abs(p.apply(0.9) - 0.95) < 0.05 && abs(p.apply(0.6) - 0.5) < 0.08)
        #expect(PlattScaling.fit(raw: [0.9, 0.8], correct: [true, true]) == nil)
    }

    @Test func trainedModelsCarryTheEnsembleAndStayAccurate() {
        let cal = captureCalibration(zones: ZoneSpec.six, perZone: 15, keystrokes: 30)
        let t = Trainer()
        for (f, l) in zip(cal.features, cal.labels) { t.add(f, label: l) }
        let (m, report) = t.train()
        #expect(m.logistic != nil)
        // Platt scaling needs some held-out mistakes to calibrate against; these synthetic zones may
        // produce none, in which case the raw ensemble confidence is used (platt == nil).
        #expect(report.overall > 0.9)
        let test = ClassifierTests.testSet(zones: ZoneSpec.six, perZone: 10, seed: 404)
        let ok = test.filter { let r = m.classify($0.0); return r.zone == $0.1 && r.confidence >= 0.8 }.count
        #expect(Double(ok) / Double(test.count) > 0.85, "\(ok)/\(test.count)")
    }

    @Test func modelsWithoutTheEnsembleDecodeAndClassifyAsBefore() throws {
        let cal = captureCalibration(zones: [.leftPalm, .rightGrille, .topStrip], perZone: 12, keystrokes: 15)
        var o = ZoneModel.TrainingOptions(); o.ensemble = false
        let old = ZoneModel.fit(features: cal.features.map(\.values), labels: cal.labels, options: o)
        #expect(old.logistic == nil)
        let back = try jsonRoundTrip(old)   // no "logistic"/"platt" keys in the JSON, like pre-ensemble files
        #expect(back.logistic == nil && back.platt == nil)
        for f in cal.features.prefix(10) {
            let a = old.classify(f), b = back.classify(f)
            #expect(a.zone == b.zone && abs(a.confidence - b.confidence) < 1e-12)
        }
    }
}
