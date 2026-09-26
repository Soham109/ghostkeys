import Darwin
import Testing
@testable import GhostkeysAcoustics

@Suite struct TapTypeClassifierTests {
    static func dataset(perClass: Int, seed: UInt64) -> [LabeledTap] {
        var rng = SeededRNG(seed)
        let extractor = TapFeatureExtractor()
        var out: [LabeledTap] = []
        for _ in 0..<perClass {
            for type in TapType.allCases {
                // Onset jitter of +-1 ms around the 2 ms preroll, like an imperfect alignment.
                let offset = 96 + Int(rng.range(-48, 48))
                out.append(LabeledTap(features: extractor.features(Synth.tapWindow(type, &rng, onsetOffset: offset)), label: type))
            }
        }
        return out
    }

    @Test func featuresAreFiniteAndSized() {
        var rng = SeededRNG(1)
        let f = TapFeatureExtractor().features(Synth.tapWindow(.knuckle, &rng))
        #expect(f.vector.count == TapFeatures.dimension)
        #expect(f.vector.allSatisfy { $0.isFinite })
        let silent = TapFeatureExtractor().features([Float](repeating: 0, count: 1920))
        #expect(silent.vector.allSatisfy { $0.isFinite })
    }

    @Test func featuresSeparateTheTypesTheWayPhysicsSays() {
        var rng = SeededRNG(2)
        let x = TapFeatureExtractor()
        let finger = x.features(Synth.tapWindow(.fingertip, &rng))
        let knuckle = x.features(Synth.tapWindow(.knuckle, &rng))
        let nail = x.features(Synth.tapWindow(.nail, &rng))
        #expect(finger.centroidHz < knuckle.centroidHz && knuckle.centroidHz < nail.centroidHz)
        #expect(nail.decayMs < knuckle.decayMs && knuckle.decayMs < finger.decayMs)
        #expect(nail.highLowRatioDb > finger.highLowRatioDb)
    }

    @Test func heldOutAccuracyAbove90Percent() throws {
        let model = try TapTypeClassifier.train(Self.dataset(perClass: 30, seed: 10))
        let test = Self.dataset(perClass: 100, seed: 99)
        var correct = 0
        var confusion: [TapType: [String: Int]] = [:]
        for ex in test {
            let r = model.classify(ex.features)
            if r.type == ex.label { correct += 1 }
            confusion[ex.label, default: [:]][r.type?.rawValue ?? "rejected", default: 0] += 1
        }
        let accuracy = Double(correct) / Double(test.count)
        print("GhostkeysAcoustics tap accuracy: \(accuracy) on \(test.count) held-out taps, confusion \(confusion)")
        #expect(accuracy > 0.9, "accuracy \(accuracy), confusion \(confusion)")
        #expect(model.leaveOneOutAccuracy() > 0.9)
    }

    @Test func rejectsSoundsUnlikeAnyTap() throws {
        let model = try TapTypeClassifier.train(Self.dataset(perClass: 20, seed: 3))
        let x = TapFeatureExtractor()
        let silence = model.classify(x.features([Float](repeating: 0, count: 1920)))
        #expect(silence.type == nil)
        #expect(silence.rejectReason == .unfamiliar)
        let tone = (0..<1920).map { Float(0.3 * sin(2 * Double.pi * 440 * Double($0) / 48_000)) }
        #expect(model.classify(x.features(tone)).type == nil)
    }

    @Test func modelRoundTripsThroughJSON() throws {
        let model = try TapTypeClassifier.train(Self.dataset(perClass: 10, seed: 4))
        let back = try jsonRoundTrip(model)
        #expect(back == model)
        for ex in Self.dataset(perClass: 5, seed: 5) {
            #expect(back.classify(ex.features).type == model.classify(ex.features).type)
        }
    }

    @Test func trainingNeedsExamples() {
        #expect(throws: TapTypeClassifierError.self) { try TapTypeClassifier.train([]) }
    }

    @Test func alignerFindsTheOnsetDespiteImuOffset() {
        var rng = SeededRNG(6)
        // 100 ms of audio; the tap's sound starts at 50 ms but the IMU says 42 ms.
        var audio = Synth.noise(4_800, &rng, amplitude: 0.0005)
        let tap = Synth.tapWindow(.knuckle, &rng, onsetOffset: 0, length: 2_000)
        Synth.add(&audio, tap, at: 2_400)
        let w = TapWindowAligner.window(from: audio, samplesTime: 0, expectedOnset: 0.042)
        #expect(w?.count == 1920)
        let onset = audio.withUnsafeBufferPointer { TapWindowAligner.onsetIndex(in: $0, searchRange: 1_300..<2_900, sampleRate: 48_000) }
        #expect(onset != nil && abs(onset! - 2_400) <= 24)
    }

    @Test func processorClassifiesImuOnsetsAndEmitsKnockKnuckle() throws {
        let model = try TapTypeClassifier.train(Self.dataset(perClass: 30, seed: 11))
        var options = SoundModeProcessor.Options()
        options.rubs = false
        options.sonar = false
        let p = SoundModeProcessor(options: options, tapClassifier: model)
        var rng = SeededRNG(12)
        var audio = Synth.noise(48_000, &rng, amplitude: 0.0005)
        let onsets: [(Double, TapType)] = [(0.2, .knuckle), (0.5, .fingertip), (0.8, .nail)]
        for (t, type) in onsets { Synth.add(&audio, Synth.tapWindow(type, &rng, onsetOffset: 0, length: 1_900), at: Int(t * 48_000)) }
        var events: [AcousticEvent] = []
        var noted = 0
        Synth.stream(audio, chunk: 256) { (chunk: UnsafeBufferPointer<Float>, time: Double) -> [Int] in
            // The IMU reports each tap 5 ms after its sound starts, and the report arrives a little later still.
            while noted < onsets.count && time > onsets[noted].0 + 0.01 { p.noteTapOnset(imuTime: onsets[noted].0 + 0.005); noted += 1 }
            events += p.process(chunk, time: time)
            return []
        }
        let classified = events.compactMap { e -> TapType?? in if case .tapClassified(_, let c) = e { return c.type }; return nil }
        #expect(classified == [.knuckle, .fingertip, .nail])
        let gestures = events.compactMap { e -> AcousticGesture? in if case .gesture(let g) = e { return g }; return nil }
        #expect(gestures.map(\.kind) == [.knockKnuckle])
        #expect(abs(gestures.first!.time - 0.205) < 1e-9)
    }
}
