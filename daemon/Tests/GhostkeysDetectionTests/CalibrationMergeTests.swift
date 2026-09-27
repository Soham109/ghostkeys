import Testing
@testable import GhostkeysDetection

@Suite struct CalibrationMergeTests {
    typealias Sample = (label: String, id: Int)

    static func merge(saved: [Sample], run: [Sample], known: Set<String>) -> [Sample] {
        CalibrationMerge.merge(saved: saved, run: run, knownZones: known, label: \.label)
    }

    @Test func redoingSomeZonesKeepsTheOthers() {
        let saved: [Sample] = [("a", 1), ("a", 2), ("b", 3), ("c", 4), ("none", 5)]
        let run: [Sample] = [("b", 10), ("b", 11)]
        let merged = Self.merge(saved: saved, run: run, known: ["a", "b", "c"])
        #expect(merged.map(\.id) == [1, 2, 4, 5, 10, 11])
    }

    @Test func negativesAreReplacedOnlyWhenTheRunCapturedThem() {
        let saved: [Sample] = [("a", 1), ("none", 2), ("none", 3)]
        #expect(Self.merge(saved: saved, run: [("a", 10)], known: ["a"]).map(\.id) == [2, 3, 10])
        #expect(Self.merge(saved: saved, run: [("a", 10), ("none", 11)], known: ["a"]).map(\.id) == [10, 11])
    }

    @Test func savedSamplesOfRemovedZonesAreDropped() {
        let saved: [Sample] = [("gone", 1), ("a", 2)]
        #expect(Self.merge(saved: saved, run: [("b", 10)], known: ["a", "b"]).map(\.id) == [2, 10])
    }

    @Test func partialRecalibrationStillTrainsEveryZone() {
        let all: [ZoneSpec] = [.leftPalm, .rightPalm, .leftGrille, .rightGrille, .topStrip, .leftEdge, .rightEdge, .lid]
        let first = captureCalibration(zones: all, perZone: 20, keystrokes: 30, seed: 7)
        let redo = captureCalibration(zones: [.leftGrille, .lid, .topStrip], perZone: 30, seed: 99)
        let saved = zip(first.features, first.labels).map { (label: $0.1, f: $0.0) }
        let run = zip(redo.features, redo.labels).map { (label: $0.1, f: $0.0) }

        let merged = CalibrationMerge.merge(saved: saved, run: run, knownZones: Set(all.map(\.name)), label: \.label)
        let trainer = Trainer()
        for s in merged { trainer.add(s.f, label: s.label) }
        let (model, report) = trainer.train()

        #expect(Set(model.labels) == Set(all.map(\.name) + ["none"]))
        #expect(merged.filter { $0.label == "lid" }.count == 30)
        #expect(merged.filter { $0.label == "left-palm" }.count == 20)
        #expect(report.overall > 0.85, "overall \(report.overall) \(report.accuracy)")
    }
}
