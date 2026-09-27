// Per-user zone classifier.
//
// Pipeline for one feature vector x:
//   1. Standardize: z = (x - globalMean) / scale, where scale is the pooled WITHIN-zone standard
//      deviation. Features that vary a lot inside one zone (raw amplitudes: users tap harder or
//      softer) are shrunk, features that are stable per zone (direction, lever arm, ring frequency)
//      keep their weight.
//   2. Whiten: w = L^-1 z, with L L^T = shrunk pooled within-zone covariance (LDA covariance). In w
//      space Euclidean distance is the Mahalanobis distance, so correlated features (all the
//      amplitude features grow together with force) are not counted many times.
//   3. k-nearest-neighbours (k = 5, weights 1/distance) over every training sample, including the
//      "none" class (keystrokes and trackpad clicks captured during calibration). This is what lets
//      "none" win for keystroke-like spikes.
//   4. Gaussian (LDA) posterior over the zone classes from the Mahalanobis distance to each zone
//      mean, for a smooth confidence.
//   5. Reject option: if the Mahalanobis distance to the nearest zone mean is larger than a threshold
//      learned from how spread out the calibration taps were, the answer is "none".
//
// The "none" class does not take part in the covariance or the Gaussian part: its samples are a
// grab bag (every key on the keyboard, clicks) and would inflate the zone covariance.

import Foundation

public struct ZoneModel: Codable, Sendable {
    public static let noneLabel = "none"

    /// All class labels: zones sorted by name, then "none" if it had training samples.
    public var labels: [String]

    // Standardization.
    var mean: [Double] = []
    var scale: [Double] = []
    /// Cholesky factor (row-major) of the shrunk pooled covariance in standardized space.
    var cholesky: [Double] = []
    /// Whitened training samples and their label indices (into `labels`).
    var samples: [[Double]] = []
    var sampleLabels: [Int] = []
    /// Whitened class means; empty array for "none".
    var classMeans: [[Double]] = []
    /// Mahalanobis distance above which a tap is rejected as "none". `Double.greatestFiniteMagnitude`
    /// disables rejection (JSON cannot store infinity).
    public var rejectDistance: Double = .greatestFiniteMagnitude
    /// k in k-nearest-neighbours.
    public var k: Int = 5

    /// Per-label mean of the raw (xHat, yHat) lever-arm estimates.
    var positionMeans: [String: [Double]] = [:]
    /// Normalized zone centres (x from left edge to right edge, y from hinge to front), 0...1.
    /// Filled with defaults for the standard zone ids; the daemon should call `setZoneCenters`
    /// with the centres of the configured zone rectangles.
    public var zoneCenters: [String: [Double]] = [:]
    /// Slope from lever-arm estimate units to normalized position, fitted across zones.
    var positionGain: [Double] = [0, 0]
    /// How much of the per-tap position offset is blended into the zone centre (0 = centre only).
    public var positionBlend: Double = 0.5

    /// Per zone: 10th, 50th and 90th percentile of the calibration taps' peak acceleration (g).
    public var peakQuantiles: [String: [Double]]? = nil
    /// Onset floor learned from this user's taps (g): half the 10th-percentile peak of their
    /// gentlest zone, clamped to 4...17.5 mg. The engine uses it instead of the 17.5 mg default.
    /// Optional so models saved before it existed still decode.
    public var onsetFloor: Double? = nil
    public static let onsetFloorRange: ClosedRange<Double> = 0.004...0.0175
    /// Feature indices the model ignores (set to 0 before whitening). Optional for old models.
    var ignoredFeatures: [Int]? = nil
    /// TapFeatures.version of the features the model was trained on; nil for models saved before versioning.
    public var featureVersion: Int? = nil
    public var hasCurrentFeatures: Bool { featureVersion == TapFeatures.version }

    public init(labels: [String]) { self.labels = labels }

    var featureCount: Int { mean.count }
    var isTrained: Bool { !samples.isEmpty && featureCount > 0 }

    /// Default centres for the standard MacBook Pro zones (PROTOCOL.md).
    public static let defaultZoneCenters: [String: [Double]] = [
        "left-palm": [0.2, 0.8], "right-palm": [0.8, 0.8],
        "left-grille": [0.07, 0.3], "right-grille": [0.93, 0.3],
        "top-strip": [0.5, 0.05], "left-edge": [0.0, 0.5], "right-edge": [1.0, 0.5], "lid": [0.5, 0.0],
    ]

    /// Sets the normalized centre of each zone (for example the centre of its rect) and refits the
    /// map from the per-tap lever-arm estimate to normalized position.
    public mutating func setZoneCenters(_ centers: [String: [Double]]) {
        for (k, v) in centers where v.count >= 2 { zoneCenters[k] = [v[0], v[1]] }
        fitPositionGain()
    }

    // MARK: Classification

    /// Returns the best zone ("none" if rejected), its confidence 0...1 and an estimated x,y (0...1).
    public func classify(_ f: TapFeatures) -> (zone: String, confidence: Double, x: Double, y: Double) {
        let r = classifyDetailed(f)
        return (r.zone, r.confidence, r.x, r.y)
    }

    /// Full classification result, including the class probabilities, for diagnostics.
    public struct Result: Sendable {
        public var zone: String
        public var confidence: Double
        public var x: Double
        public var y: Double
        /// Combined probability per label (same order as `labels`).
        public var probabilities: [Double]
        /// Mahalanobis distance to the nearest zone mean.
        public var distance: Double
        /// True if the reject option (distance too large) produced the "none".
        public var outOfDistribution: Bool
    }

    public func classifyDetailed(_ f: TapFeatures) -> Result {
        guard isTrained, f.values.count == featureCount else {
            return Result(zone: Self.noneLabel, confidence: 0, x: 0.5, y: 0.5, probabilities: labels.map { _ in 0 },
                          distance: .infinity, outOfDistribution: true)
        }
        let w = whiten(masked(f.values))
        let nLabels = labels.count
        let noneIndex = labels.firstIndex(of: Self.noneLabel)

        // Gaussian part: Mahalanobis distance to every zone mean.
        var dist = [Double](repeating: .infinity, count: nLabels)
        var best = -1
        for c in 0..<nLabels where !classMeans[c].isEmpty {
            dist[c] = LinearAlgebra.distance(w, classMeans[c])
            if best < 0 || dist[c] < dist[best] { best = c }
        }
        var pGauss = [Double](repeating: 0, count: nLabels)
        if best >= 0 {
            let d0 = dist[best]
            var sum = 0.0
            for c in 0..<nLabels where dist[c].isFinite {
                // exp(-(d^2 - d0^2)/2), shifted for numerical safety.
                pGauss[c] = exp(-0.5 * (dist[c] * dist[c] - d0 * d0))
                sum += pGauss[c]
            }
            if sum > 0 { for c in 0..<nLabels { pGauss[c] /= sum } }
        }

        // k-NN part (distance weighted).
        let kk = min(k, samples.count)
        var nearest: [(d: Double, label: Int)] = []
        nearest.reserveCapacity(kk + 1)
        for (i, s) in samples.enumerated() {
            let d = LinearAlgebra.distance(w, s)
            if nearest.count < kk || d < nearest[nearest.count - 1].d {
                var pos = nearest.count
                while pos > 0 && nearest[pos - 1].d > d { pos -= 1 }
                nearest.insert((d, sampleLabels[i]), at: pos)
                if nearest.count > kk { nearest.removeLast() }
            }
        }
        var pKnn = [Double](repeating: 0, count: nLabels)
        var wsum = 0.0
        for n in nearest { let wt = 1 / (n.d + 1e-3); pKnn[n.label] += wt; wsum += wt }
        if wsum > 0 { for c in 0..<nLabels { pKnn[c] /= wsum } }

        // Combine: the Gaussian part only speaks about zones, so it shares whatever mass k-NN did not
        // give to "none".
        let pNone = noneIndex.map { pKnn[$0] } ?? 0
        var p = [Double](repeating: 0, count: nLabels)
        for c in 0..<nLabels {
            if c == noneIndex { p[c] = pNone } else { p[c] = 0.5 * pKnn[c] + 0.5 * (1 - pNone) * pGauss[c] }
        }
        var top = 0
        for c in 0..<nLabels where p[c] > p[top] { top = c }

        let dBest = best >= 0 ? dist[best] : .infinity
        if top == noneIndex || best < 0 {
            return Result(zone: Self.noneLabel, confidence: p[top], x: 0.5, y: 0.5, probabilities: p,
                          distance: dBest, outOfDistribution: false)
        }
        // Reject option: far from every zone the user calibrated.
        let dTop = dist[top]
        if dTop > rejectDistance {
            return Result(zone: Self.noneLabel, confidence: Stats.clamp(1 - rejectDistance / dTop + 0.5, 0, 1),
                          x: 0.5, y: 0.5, probabilities: p, distance: dTop, outOfDistribution: true)
        }
        // Soften confidence in the outer 20% of the accepted region so borderline taps fall below
        // minConfidence rather than firing actions.
        var conf = p[top]
        if rejectDistance < 1e300 {
            let edge = 0.8 * rejectDistance
            if dTop > edge { conf *= 1 - 0.5 * (dTop - edge) / (rejectDistance - edge) }
        }
        let zone = labels[top]
        let (x, y) = position(zone: zone, features: f.values)
        return Result(zone: zone, confidence: Stats.clamp(conf, 0, 1), x: x, y: y, probabilities: p,
                      distance: dTop, outOfDistribution: false)
    }

    func masked(_ x: [Double]) -> [Double] {
        guard let ig = ignoredFeatures, !ig.isEmpty else { return x }
        var v = x
        for i in ig where i < v.count { v[i] = 0 }
        return v
    }

    func whiten(_ x: [Double]) -> [Double] {
        var z = [Double](repeating: 0, count: featureCount)
        for i in 0..<featureCount { z[i] = (x[i] - mean[i]) / scale[i] }
        return LinearAlgebra.forwardSolve(cholesky, n: featureCount, z)
    }

    func position(zone: String, features v: [Double]) -> (Double, Double) {
        let c = zoneCenters[zone] ?? [0.5, 0.5]
        var x = c[0], y = c[1]
        if let pm = positionMeans[zone], v.count > FeatureIndex.yHat.rawValue {
            x += positionBlend * positionGain[0] * (v[FeatureIndex.xHat.rawValue] - pm[0])
            y += positionBlend * positionGain[1] * (v[FeatureIndex.yHat.rawValue] - pm[1])
        }
        return (Stats.clamp(x, 0, 1), Stats.clamp(y, 0, 1))
    }

    /// Least-squares slope from zone mean lever-arm estimate to zone centre, per axis. Needs two or
    /// more zones with distinct estimates; otherwise the per-tap offset is disabled.
    mutating func fitPositionGain() {
        for axis in 0..<2 {
            var pts: [(Double, Double)] = []
            for (zone, pm) in positionMeans where zone != Self.noneLabel {
                if let c = zoneCenters[zone] { pts.append((pm[axis], c[axis])) }
            }
            guard pts.count >= 2 else { positionGain[axis] = 0; continue }
            let mx = pts.map(\.0).reduce(0, +) / Double(pts.count)
            let my = pts.map(\.1).reduce(0, +) / Double(pts.count)
            var sxy = 0.0, sxx = 0.0
            for (a, b) in pts { sxy += (a - mx) * (b - my); sxx += (a - mx) * (a - mx) }
            // Only trust a positive relation (more lever arm -> further along the axis).
            positionGain[axis] = sxx > 1e-12 ? max(0, sxy / sxx) : 0
        }
    }

    // MARK: Training

    /// Fits a model. `labels[i]` is the class of `features[i]`; "none" marks negatives.
    struct TrainingOptions {
        /// Feature indices to ignore.
        var ignored: Set<Int> = []
        /// Extra training copies of every sample with its force-dependent features rescaled by these
        /// factors (see FeatureIndex.forceScaled), so the model accepts softer and harder taps than
        /// the ones calibrated.
        var augment: [Double] = []
    }

    static func fit(features original: [[Double]], labels rawLabels: [String], k: Int = 5,
                    options: TrainingOptions = TrainingOptions()) -> ZoneModel {
        var x: [[Double]] = [], y: [String] = [], group: [Int] = []
        for (i, v) in original.enumerated() {
            for f in [1.0] + options.augment {
                var c = FeatureIndex.scaleForce(v, by: f)
                for j in options.ignored where j < c.count { c[j] = 0 }
                x.append(c); y.append(rawLabels[i]); group.append(i)
            }
        }
        var model = fitCore(features: x, labels: y, groups: group, k: k)
        model.ignoredFeatures = options.ignored.isEmpty ? nil : options.ignored.sorted()

        // Tap strength distribution and the learned onset floor (from the real samples only).
        var quantiles: [String: [Double]] = [:]
        for name in Set(rawLabels) where name != noneLabel {
            let peaks = original.indices.filter { rawLabels[$0] == name }
                .map { pow(10, original[$0][FeatureIndex.strength.rawValue]) / 1000 }
            guard peaks.count >= 3 else { continue }
            quantiles[name] = [Stats.quantile(peaks, 0.1), Stats.quantile(peaks, 0.5), Stats.quantile(peaks, 0.9)]
        }
        if !quantiles.isEmpty {
            model.peakQuantiles = quantiles
            let gentlest = quantiles.values.map { $0[0] }.min()!
            model.onsetFloor = Stats.clamp(0.5 * gentlest, onsetFloorRange.lowerBound, onsetFloorRange.upperBound)
        }
        model.featureVersion = TapFeatures.version
        return model
    }

    /// `groups[i]` identifies the original sample a (possibly augmented) row came from; rows of one
    /// group always share a cross-validation fold.
    static func fitCore(features: [[Double]], labels raw: [String], groups: [Int], k: Int) -> ZoneModel {
        let zoneNames = Array(Set(raw.filter { $0 != noneLabel })).sorted()
        var labels = zoneNames
        if raw.contains(noneLabel) { labels.append(noneLabel) }
        var model = ZoneModel(labels: labels)
        model.k = k
        model.zoneCenters = defaultZoneCenters.filter { labels.contains($0.key) }
        guard let p = features.first?.count, p > 0, features.count == raw.count else { return model }
        let index = Dictionary(uniqueKeysWithValues: labels.enumerated().map { ($1, $0) })
        let y = raw.map { index[$0]! }
        let noneIdx = index[noneLabel]
        let n = features.count

        let geo = Geometry(features: features, y: y, classCount: labels.count, noneIndex: noneIdx)
        model.mean = geo.mean
        model.scale = geo.scale
        model.cholesky = geo.cholesky
        model.samples = features.map { geo.whiten($0) }
        model.sampleLabels = y
        model.classMeans = geo.classMeans

        // Reject threshold from calibration spread, measured out of sample: each zone tap's distance
        // to its zone mean under a geometry fitted WITHOUT it (5 folds). In-sample distances are far
        // too optimistic when there are about as many taps as features (10 taps x 4 zones vs 33).
        var spread: [Double] = []
        let zoneIdx = (0..<n).filter { y[$0] != noneIdx }
        let folds = 5
        if zoneIdx.count >= 2 * folds {
            var fold = [Int](repeating: 0, count: n)
            var rank = [Int](repeating: 0, count: labels.count)
            var groupFold: [Int: Int] = [:]
            for i in zoneIdx {
                if let f = groupFold[groups[i]] { fold[i] = f; continue }
                fold[i] = rank[y[i]] % folds; rank[y[i]] += 1
                groupFold[groups[i]] = fold[i]
            }
            for f in 0..<folds {
                let trainIdx = (0..<n).filter { y[$0] == noneIdx || fold[$0] != f }
                let g = Geometry(features: trainIdx.map { features[$0] }, y: trainIdx.map { y[$0] },
                                 classCount: labels.count, noneIndex: noneIdx)
                for i in zoneIdx where fold[i] == f && !g.classMeans[y[i]].isEmpty {
                    spread.append(LinearAlgebra.distance(g.whiten(features[i]), g.classMeans[y[i]]))
                }
            }
        }
        if spread.count >= 5 {
            // Generous margins: a missed tap is annoying, but the none class, the k-NN vote and
            // minConfidence also stand between an odd spike and an action.
            model.rejectDistance = max(1.3 * Stats.quantile(spread, 0.95), 1.1 * (spread.max() ?? 0))
        }
        let rawMeans = geo.rawMeans, counts = geo.counts

        // Position means from the raw lever-arm features.
        for c in 0..<labels.count where counts[c] > 0 && p > FeatureIndex.yHat.rawValue {
            model.positionMeans[labels[c]] = [rawMeans[c][FeatureIndex.xHat.rawValue], rawMeans[c][FeatureIndex.yHat.rawValue]]
        }
        model.fitPositionGain()

        return model
    }

    /// Standardization + shrunk pooled within-zone covariance, fitted on a set of samples.
    struct Geometry {
        var mean: [Double]
        var scale: [Double]
        var cholesky: [Double]
        var rawMeans: [[Double]]
        var counts: [Int]
        /// Whitened zone means; empty for "none" and for classes without samples.
        var classMeans: [[Double]]
        let p: Int

        init(features: [[Double]], y: [Int], classCount: Int, noneIndex: Int?) {
            let p = features.first?.count ?? 0   // local copy: closures below must not capture self
            self.p = p
            let n = features.count

            // Global mean and std.
            var mean = [Double](repeating: 0, count: p)
            for x in features { for j in 0..<p { mean[j] += x[j] } }
            for j in 0..<p { mean[j] /= Double(max(n, 1)) }
            var gstd = [Double](repeating: 0, count: p)
            for x in features { for j in 0..<p { gstd[j] += (x[j] - mean[j]) * (x[j] - mean[j]) } }
            for j in 0..<p { gstd[j] = (gstd[j] / Double(max(n - 1, 1))).squareRoot() }

            // Raw class means.
            var rawMeans = [[Double]](repeating: [Double](repeating: 0, count: p), count: classCount)
            var counts = [Int](repeating: 0, count: classCount)
            for (i, x) in features.enumerated() {
                counts[y[i]] += 1
                for j in 0..<p { rawMeans[y[i]][j] += x[j] }
            }
            for c in 0..<classCount where counts[c] > 0 { for j in 0..<p { rawMeans[c][j] /= Double(counts[c]) } }

            // Pooled within-zone variance (zones only; "none" is a grab bag of spikes).
            var pooled = [Double](repeating: 0, count: p)
            var nZone = 0, cZone = 0
            for c in 0..<classCount where c != noneIndex && counts[c] > 0 { cZone += 1; nZone += counts[c] }
            for (i, x) in features.enumerated() where y[i] != noneIndex {
                for j in 0..<p { let d = x[j] - rawMeans[y[i]][j]; pooled[j] += d * d }
            }
            let dof = nZone - cZone
            var scale = [Double](repeating: 1, count: p)
            for j in 0..<p {
                if gstd[j] < 1e-12 { scale[j] = 1; continue }   // constant feature: carries no information
                let within = dof > 0 ? (pooled[j] / Double(dof)).squareRoot() : gstd[j]
                // Floor at 10% of the global spread: a feature that happens to be almost constant inside
                // every zone in a small calibration set must not make distances explode later.
                scale[j] = max(within, 0.1 * gstd[j], 1e-9)
            }

            // Pooled within-zone covariance in standardized space, shrunk toward identity.
            var cov = [Double](repeating: 0, count: p * p)
            let zMeans = rawMeans.map { m in (0..<p).map { (m[$0] - mean[$0]) / scale[$0] } }
            for (i, x) in features.enumerated() where y[i] != noneIndex {
                let mu = zMeans[y[i]]
                var dz = [Double](repeating: 0, count: p)
                for a in 0..<p { dz[a] = (x[a] - mean[a]) / scale[a] - mu[a] }
                for a in 0..<p {
                    let da = dz[a]
                    for b in a..<p { cov[a * p + b] += da * dz[b] }
                }
            }
            // Shrinkage: more when there are few samples per dimension (Ledoit-Wolf flavoured rule of thumb).
            let lambda = Stats.clamp(Double(p) / Double(p + max(dof, 0)), 0.1, 0.95)
            for a in 0..<p {
                for b in a..<p {
                    var v = dof > 0 ? cov[a * p + b] / Double(dof) : (a == b ? 1 : 0)
                    v = (1 - lambda) * v + (a == b ? lambda : 0)
                    cov[a * p + b] = v; cov[b * p + a] = v
                }
            }
            let chol = LinearAlgebra.cholesky(cov, n: p)
            let whitenedMeans = (0..<classCount).map { c in
                (c == noneIndex || counts[c] == 0) ? [] : LinearAlgebra.forwardSolve(chol, n: p, zMeans[c])
            }

            self.mean = mean
            self.scale = scale
            self.cholesky = chol
            self.rawMeans = rawMeans
            self.counts = counts
            self.classMeans = whitenedMeans
        }

        func whiten(_ x: [Double]) -> [Double] {
            var z = [Double](repeating: 0, count: p)
            for i in 0..<p { z[i] = (x[i] - mean[i]) / scale[i] }
            return LinearAlgebra.forwardSolve(cholesky, n: p, z)
        }
    }
}
