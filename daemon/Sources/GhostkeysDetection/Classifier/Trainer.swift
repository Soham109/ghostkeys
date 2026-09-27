// Calibration trainer.
//
// Accuracy is measured with a stratified 20% hold-out, rotated five times (5-fold cross validation):
// every sample is held out exactly once, each time from a model trained on the other 80%, and each
// class is split proportionally. Rotating the hold-out matters with 10 samples per zone, where a
// single 20% split would test only 2 taps per zone. The final model is then trained on everything.

import Foundation

public struct CalibrationReport: Codable, Sendable {
    public var labels: [String]
    public var accuracy: [String: Double]
    public var overall: Double
    /// confusion[i][j]: held-out samples of labels[i] predicted as labels[j].
    public var confusion: [[Int]]
    public init(labels: [String], accuracy: [String: Double], overall: Double, confusion: [[Int]]) {
        self.labels = labels; self.accuracy = accuracy; self.overall = overall; self.confusion = confusion
    }
}

/// Collects labeled feature vectors during calibration and trains a ZoneModel.
public final class Trainer {
    private var features: [[Double]] = []
    private var labels: [String] = []

    /// Number of hold-out rotations (1 / hold-out fraction).
    public var folds = 5
    /// Seed for the stratified split, so reports are reproducible.
    public var seed: UInt64 = 0x6768_6f73_746b_6579

    public init() {}

    public func add(_ f: TapFeatures, label: String) {
        guard f.values.count == TapFeatures.count, f.values.allSatisfy(\.isFinite) else { return }
        features.append(f.values)
        labels.append(label)
    }

    /// Removes the samples of one label (for example to redo a zone), or everything when nil.
    public func removeAll(label: String? = nil) {
        guard let label else { features.removeAll(); labels.removeAll(); return }
        let keep = labels.indices.filter { labels[$0] != label }
        features = keep.map { features[$0] }
        labels = keep.map { labels[$0] }
    }

    public var counts: [String: Int] {
        var c: [String: Int] = [:]
        for l in labels { c[l, default: 0] += 1 }
        return c
    }

    /// All collected samples, for saving next to the model.
    public var samples: [(features: TapFeatures, label: String)] {
        zip(features, labels).map { (TapFeatures(values: $0, t: 0), $1) }
    }

    /// Calibration taps weaker than this fraction of their zone's median peak are dropped before
    /// training: with the low capture floor, tiny unrelated spikes (a desk bump, a key) can be
    /// captured while the user taps a zone, and would teach the model that noise is that zone.
    public var junkPeakFraction = 0.25

    /// Training options. Off by default: strength augmentation (training copies of every tap made
    /// 0.7x/1.4x or 1.4x/2x as hard) helped synthetic zones generalize from light calibration taps to
    /// harder ones (58% -> 95% accepted), but on the first real calibration it tripled typing
    /// negatives read as taps (0.05 -> 0.145 per negative at minConfidence 0.8). Better: calibrate with
    /// taps of the strengths the user will really use.
    var options = ZoneModel.TrainingOptions()

    /// Indices of samples kept for training (see `junkPeakFraction`).
    func keptIndices() -> [Int] {
        let s = FeatureIndex.strength.rawValue
        var keep: [Int] = []
        for name in Set(labels) {
            let idx = labels.indices.filter { labels[$0] == name }
            guard name != ZoneModel.noneLabel, idx.count >= 8 else { keep += idx; continue }
            let median = Stats.median(idx.map { features[$0][s] })
            keep += idx.filter { features[$0][s] >= median + log10(junkPeakFraction) }
        }
        return keep.sorted()
    }

    public func train() -> (ZoneModel, CalibrationReport) {
        let kept = keptIndices()
        let features = kept.map { self.features[$0] }
        let labels = kept.map { self.labels[$0] }
        let full = ZoneModel.fit(features: features, labels: labels, options: options)
        // "none" is always a column: a zone tap rejected by the reject option counts as an error.
        var names = full.labels
        if !names.contains(ZoneModel.noneLabel) { names.append(ZoneModel.noneLabel) }
        guard !features.isEmpty else {
            return (full, CalibrationReport(labels: [], accuracy: [:], overall: 0, confusion: []))
        }
        let index = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })

        // Stratified fold assignment. Classes with a single sample are never held out.
        var fold = [Int](repeating: -1, count: features.count)
        var rng = SplitMix64(seed: seed)
        for name in names {
            var idx = labels.indices.filter { labels[$0] == name }
            guard idx.count >= 2 else { continue }
            idx.shuffle(using: &rng)
            for (r, i) in idx.enumerated() { fold[i] = r % max(folds, 2) }
        }

        var confusion = [[Int]](repeating: [Int](repeating: 0, count: names.count), count: names.count)
        for f in 0..<max(folds, 2) {
            let trainIdx = features.indices.filter { fold[$0] != f }
            let testIdx = features.indices.filter { fold[$0] == f }
            guard !testIdx.isEmpty, !trainIdx.isEmpty else { continue }
            // The report scores the predicted zone only, which Platt scaling never changes: skip it.
            var foldOptions = options
            foldOptions.calibrate = false
            let m = ZoneModel.fit(features: trainIdx.map { features[$0] }, labels: trainIdx.map { labels[$0] }, options: foldOptions)
            for i in testIdx {
                let predicted = m.classify(TapFeatures(values: features[i], t: 0)).zone
                if let a = index[labels[i]], let b = index[predicted] { confusion[a][b] += 1 }
            }
        }

        var accuracy: [String: Double] = [:]
        var correct = 0, total = 0
        for (i, name) in names.enumerated() {
            let row = confusion[i].reduce(0, +)
            correct += confusion[i][i]; total += row
            if row > 0 { accuracy[name] = Double(confusion[i][i]) / Double(row) }
        }
        let report = CalibrationReport(labels: names, accuracy: accuracy,
                                       overall: total > 0 ? Double(correct) / Double(total) : 0, confusion: confusion)
        return (full, report)
    }
}
