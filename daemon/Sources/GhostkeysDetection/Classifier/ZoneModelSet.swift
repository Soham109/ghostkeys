// One zone model per posture (desk, lap, stand), and the rule that picks which one is live.
//
// Why: a model describes the machine as it was during calibration. A desk calibration applied to lap taps picks the
// right zone about 1 time in 10 (docs/review/DETECTION_ROUND2.md, cross-session recall), so a user who calibrates in
// both postures should get the matching model. The posture signal is the direction of the low-passed gravity vector:
// every model remembers the mean gravity direction of its calibration (`ZoneModel.calibrationGravity`), and the set
// picks the model whose direction is nearest the machine's current one.
//
// Hysteresis: the live model changes only after another posture has been at least `switchMarginDegrees` closer than
// the active one for `switchHoldSeconds` without a break, and never while the machine is moving. A lap wanders by
// several degrees and a tap rocks the machine for a moment, so a plain "nearest wins" rule would flap between models.
//
// Models without a calibration gravity (saved by older builds, or trained from samples without gravity) count as
// `unknownPostureAngle` degrees away: they are the fallback when the machine is far from every calibrated posture.
// With a single model there is nothing to choose: it is always active. A set whose models do not all carry a
// calibration gravity (`hasGravityForEveryModel` false) cannot really tell postures apart by gravity: with a legacy
// desk model and a new lap model, the lap model wins on the desk too (measured, round 3). Build a set only when every
// posture's calibration carries gravity.
//
// Tap evidence (`tapEvidence`, on by default): gravity is a weak posture signal on this machine. While tapping on the
// user's lap it sat only 2 to 11 degrees from the desk (median 2.3 degrees in one lap phase), so gravity alone put the
// lap model live for 67% of the lap taps. The taps themselves are a strong signal: lap taps sit a median 19.5 typical
// calibration distances from a desk model and 1.05 from a lap model, while desk taps from another desk day sit 2.9
// from the desk model and 3.3 from the lap model. So the set also switches when `evidenceCount` taps in a row (within
// `evidenceWindow` seconds) sit more than `evidenceFarRatio` typical distances from the live model and within
// `evidenceNearRatio` of another posture's model, which is at least `evidenceConfidence` sure of the zone. On the real
// data: 88.5% of held-out lap taps meet that with a desk model live, 0 of 667 desk taps from another desk day meet it
// the wrong way. After such a switch gravity cannot switch back until the machine turns by `switchMarginDegrees`.
//
// Limits (docs/review/DETECTION_ROUND3.md): one lap recording, three desk calibrations, no recording with both postures
// and known posture labels. The constants are round numbers picked from the medians above, not fitted.

import Foundation

public struct ZoneModelSet: Codable, Sendable {
    /// One model per posture name ("desk", "lap", "stand", or any other name).
    public private(set) var models: [String: ZoneModel]
    /// Another posture must be at least this many degrees closer than the active one...
    public var switchMarginDegrees = 5.0
    /// ...continuously for this long (seconds) before it becomes active.
    public var switchHoldSeconds = 1.0
    /// How far away (degrees) a model without a calibration gravity counts as being.
    public var unknownPostureAngle = 15.0
    /// Posture used before any gravity is known (and the tie-break when nothing else decides).
    public var fallbackPosture: String

    /// The posture whose model is live.
    public private(set) var activePosture: String
    /// Angle in degrees between the last gravity passed to `update` and the active model's calibration gravity
    /// (nil before the first update, or when the active model has no calibration gravity).
    public private(set) var gravityAngle: Double?
    /// True once `update` has placed the set by gravity (the first placement needs no hold).
    public private(set) var isPlaced = false
    /// Posture waiting to take over, and since when it has been closer by the margin.
    public private(set) var pendingPosture: String?
    private var pendingSince = 0.0

    /// Switch on tap evidence as well as gravity (see the file header).
    public var tapEvidence = true
    /// A tap is evidence against the live model when it sits further than this many typical distances from it...
    public var evidenceFarRatio = 6.0
    /// ...and for another posture when it sits within this many of that posture's model...
    public var evidenceNearRatio = 2.0
    /// ...which is at least this sure of the zone.
    public var evidenceConfidence = 0.8
    /// Taps in a row needed, all pointing at the same posture...
    public var evidenceCount = 2
    /// ...within this many seconds.
    public var evidenceWindow = 30.0
    /// Recent tap evidence: the posture each tap pointed at ("" for a tap that fits the live model or nothing clearly).
    private var evidence: [(t: Double, posture: String)] = []
    /// Gravity when the last tap-evidence switch happened; gravity switching waits until the machine turns away from it.
    private var evidenceAnchor: SIMD3<Double>?
    private var lastGravity: SIMD3<Double>?

    /// A set of models keyed by posture. `fallback` (default: "desk" if present, else the first name in sorted order)
    /// is active until the first `update`. An empty dictionary is allowed but has no active model.
    public init(models: [String: ZoneModel], fallback: String? = nil) {
        self.models = models
        let names = models.keys.sorted()
        let pick = fallback.flatMap { models[$0] != nil ? $0 : nil } ?? (models["desk"] != nil ? "desk" : names.first) ?? ""
        fallbackPosture = pick
        activePosture = pick
    }

    /// A set holding one model (the daemon's current single model): it is always active.
    public init(single model: ZoneModel, posture: String = "desk") {
        self.init(models: [posture: model], fallback: posture)
    }

    /// The live model (nil only for an empty set).
    public var activeModel: ZoneModel? { models[activePosture] }
    /// Posture names, sorted.
    public var postures: [String] { models.keys.sorted() }
    /// True when there is at most one model (nothing to choose).
    public var isSingle: Bool { models.count <= 1 }

    /// Angle in degrees from `gravity` to every model's calibration gravity (models without one are left out).
    public func angles(to gravity: SIMD3<Double>) -> [String: Double] {
        models.compactMapValues { $0.gravityAngle(to: gravity) }
    }

    /// Distance used to rank postures: the real angle, or `unknownPostureAngle` for a model without gravity.
    func effectiveAngle(_ posture: String, _ gravity: SIMD3<Double>) -> Double {
        models[posture]?.gravityAngle(to: gravity) ?? unknownPostureAngle
    }

    /// Feeds the machine's current low-passed gravity (any length; device coordinates, same convention as
    /// `TapFeatures.gravity`) at time `t` (seconds). While `moving` is true (the machine is being carried or
    /// repositioned) no switch can start or complete. Returns true when the active posture changed.
    @discardableResult
    public mutating func update(gravity: SIMD3<Double>, t: Double, moving: Bool = false) -> Bool {
        guard gravity.x.isFinite, gravity.y.isFinite, gravity.z.isFinite, (gravity * gravity).sum() > 1e-6 else { return false }
        lastGravity = gravity
        gravityAngle = models[activePosture]?.gravityAngle(to: gravity)
        guard models.count > 1 else { isPlaced = true; pendingPosture = nil; return false }

        // Nearest posture by effective angle; ties go to the active one, then the fallback, then name order.
        var best = activePosture, bestAngle = effectiveAngle(activePosture, gravity)
        for p in postures where p != activePosture {
            let a = effectiveAngle(p, gravity)
            if a < bestAngle - 1e-9 || (abs(a - bestAngle) <= 1e-9 && best != activePosture && p == fallbackPosture) {
                best = p; bestAngle = a
            }
        }
        if !isPlaced {
            // First placement: take the nearest at once (at start-up the machine is wherever it is).
            if moving { return false }
            isPlaced = true
            pendingPosture = nil
            guard best != activePosture else { return false }
            activate(best, gravity)
            return true
        }
        // After a tap-evidence switch, gravity waits until the machine has turned away from where the taps decided.
        if let anchor = evidenceAnchor {
            if Self.angleDegrees(anchor, gravity) < switchMarginDegrees { pendingPosture = nil; return false }
            evidenceAnchor = nil
        }
        let activeAngle = effectiveAngle(activePosture, gravity)
        guard !moving, best != activePosture, activeAngle - bestAngle >= switchMarginDegrees else {
            pendingPosture = nil
            return false
        }
        if pendingPosture != best { pendingPosture = best; pendingSince = t }
        guard t - pendingSince >= switchHoldSeconds else { return false }
        activate(best, gravity)
        return true
    }

    /// Looks at one tap candidate (features of a spike that passed the input gates) at time `t`: tap evidence (see the
    /// file header). The engine calls it for every candidate, before classifying it. Returns true when the active
    /// posture changed.
    @discardableResult
    public mutating func observe(_ f: TapFeatures, t: Double) -> Bool {
        guard tapEvidence, models.count > 1, let live = models[activePosture], let liveTypical = live.typicalDistance,
              liveTypical > 0 else { return false }
        func zoneVote(_ r: ZoneModel.Result) -> Double {
            r.zone != ZoneModel.noneLabel ? r.confidence : (r.outOfDistribution ? (r.zoneConfidence ?? 0) : 0)
        }
        let r = live.classifyDetailed(f)
        guard r.distance.isFinite else { return false }
        var isTap = zoneVote(r) >= evidenceConfidence
        var vote = ""
        var bestRatio = Double.infinity
        let liveRatio = r.distance / liveTypical
        for p in postures where p != activePosture {
            guard let m = models[p], let typical = m.typicalDistance, typical > 0 else { continue }
            let o = m.classifyDetailed(f)
            guard o.distance.isFinite else { continue }
            if zoneVote(o) >= evidenceConfidence { isTap = true } else { continue }
            let ratio = o.distance / typical
            if liveRatio > evidenceFarRatio, ratio < evidenceNearRatio, o.zone != ZoneModel.noneLabel, ratio < bestRatio {
                vote = p; bestRatio = ratio
            }
        }
        guard isTap else { return false }   // junk that no model takes for a tap says nothing about the posture
        evidence.append((t, vote))
        evidence.removeAll { t - $0.t > evidenceWindow }
        if evidence.count > evidenceCount { evidence.removeFirst(evidence.count - evidenceCount) }
        guard evidence.count == evidenceCount, !vote.isEmpty, evidence.allSatisfy({ $0.posture == vote }) else { return false }
        activePosture = vote
        pendingPosture = nil
        isPlaced = true
        evidence.removeAll()
        evidenceAnchor = lastGravity
        gravityAngle = lastGravity.flatMap { models[vote]?.gravityAngle(to: $0) }
        return true
    }

    /// True when every model has a calibration gravity (see the file header: only then can gravity tell postures apart).
    public var hasGravityForEveryModel: Bool { models.values.allSatisfy { $0.calibrationGravity != nil } }

    /// Makes `posture` active at once (for example when the user says where the machine is). Returns false if the set
    /// has no such model. Gravity keeps being followed: a later `update` can switch away again under the usual rule.
    @discardableResult
    public mutating func select(_ posture: String) -> Bool {
        guard models[posture] != nil else { return false }
        activePosture = posture
        pendingPosture = nil
        isPlaced = true
        evidence.removeAll()
        evidenceAnchor = lastGravity
        gravityAngle = lastGravity.flatMap { models[posture]?.gravityAngle(to: $0) }
        return true
    }

    /// Forgets the placement: the next `update` places the set without a hold, as at start-up.
    public mutating func resetSelection() {
        isPlaced = false
        pendingPosture = nil
        gravityAngle = nil
        evidence.removeAll()
        evidenceAnchor = nil
        lastGravity = nil
    }

    private mutating func activate(_ posture: String, _ gravity: SIMD3<Double>) {
        activePosture = posture
        pendingPosture = nil
        evidence.removeAll()
        gravityAngle = models[posture]?.gravityAngle(to: gravity)
    }

    /// Replaces (or adds) the model of `posture`. The selection state is kept.
    public mutating func setModel(_ model: ZoneModel, for posture: String) {
        models[posture] = model
        if activePosture.isEmpty { activePosture = posture; fallbackPosture = posture }
    }

    /// Sets the normalized zone centres of every model (`ZoneModel.setZoneCenters`).
    public mutating func setZoneCenters(_ centers: [String: [Double]]) {
        mapModels { var m = $0; m.setZoneCenters(centers); return m }
    }

    /// Applies `transform` to every model (the engine upgrades models saved by older builds once, on install).
    mutating func mapModels(_ transform: (ZoneModel) -> ZoneModel) {
        models = models.mapValues(transform)
    }

    // MARK: Codable (models and tuning only; the selection state starts fresh)

    private enum CodingKeys: String, CodingKey {
        case models, switchMarginDegrees, switchHoldSeconds, unknownPostureAngle, fallbackPosture
        case tapEvidence, evidenceFarRatio, evidenceNearRatio, evidenceConfidence, evidenceCount, evidenceWindow
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(models: try c.decode([String: ZoneModel].self, forKey: .models),
                  fallback: try c.decodeIfPresent(String.self, forKey: .fallbackPosture))
        switchMarginDegrees = try c.decodeIfPresent(Double.self, forKey: .switchMarginDegrees) ?? switchMarginDegrees
        switchHoldSeconds = try c.decodeIfPresent(Double.self, forKey: .switchHoldSeconds) ?? switchHoldSeconds
        unknownPostureAngle = try c.decodeIfPresent(Double.self, forKey: .unknownPostureAngle) ?? unknownPostureAngle
        tapEvidence = try c.decodeIfPresent(Bool.self, forKey: .tapEvidence) ?? tapEvidence
        evidenceFarRatio = try c.decodeIfPresent(Double.self, forKey: .evidenceFarRatio) ?? evidenceFarRatio
        evidenceNearRatio = try c.decodeIfPresent(Double.self, forKey: .evidenceNearRatio) ?? evidenceNearRatio
        evidenceConfidence = try c.decodeIfPresent(Double.self, forKey: .evidenceConfidence) ?? evidenceConfidence
        evidenceCount = try c.decodeIfPresent(Int.self, forKey: .evidenceCount) ?? evidenceCount
        evidenceWindow = try c.decodeIfPresent(Double.self, forKey: .evidenceWindow) ?? evidenceWindow
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(models, forKey: .models)
        try c.encode(switchMarginDegrees, forKey: .switchMarginDegrees)
        try c.encode(switchHoldSeconds, forKey: .switchHoldSeconds)
        try c.encode(unknownPostureAngle, forKey: .unknownPostureAngle)
        try c.encode(fallbackPosture, forKey: .fallbackPosture)
        try c.encode(tapEvidence, forKey: .tapEvidence)
        try c.encode(evidenceFarRatio, forKey: .evidenceFarRatio)
        try c.encode(evidenceNearRatio, forKey: .evidenceNearRatio)
        try c.encode(evidenceConfidence, forKey: .evidenceConfidence)
        try c.encode(evidenceCount, forKey: .evidenceCount)
        try c.encode(evidenceWindow, forKey: .evidenceWindow)
    }
}

// MARK: Gravity helpers

extension ZoneModelSet {
    /// Angle in degrees between two vectors (0 if either has no length).
    public static func angleDegrees(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double {
        let na = (a * a).sum().squareRoot(), nb = (b * b).sum().squareRoot()
        guard na > 0, nb > 0, na.isFinite, nb.isFinite else { return 0 }
        return acos(Stats.clamp((a * b).sum() / (na * nb), -1, 1)) * 180 / .pi
    }

    /// Mean direction of a set of gravity vectors (each normalised first) and the 90th percentile angle (degrees) of
    /// the vectors from it. nil when there is no usable vector or the directions cancel out.
    public static func meanGravity(_ gs: [SIMD3<Double>]) -> (direction: SIMD3<Double>, spread: Double)? {
        var sum = SIMD3<Double>(0, 0, 0)
        var units: [SIMD3<Double>] = []
        for g in gs {
            let n = (g * g).sum().squareRoot()
            guard n > 1e-9, n.isFinite else { continue }
            units.append(g / n); sum += g / n
        }
        let n = (sum * sum).sum().squareRoot()
        guard !units.isEmpty, n > 1e-6 * Double(units.count) else { return nil }
        let mean = sum / n
        return (mean, Stats.quantile(units.map { angleDegrees($0, mean) }, 0.9))
    }
}

// MARK: Training one model per posture

extension ZoneModelSet {
    /// One calibration sample with the posture it was captured in (nil: unknown, for samples saved by older builds).
    public struct PostureSample: Sendable {
        public var features: TapFeatures
        public var label: String
        public var posture: String?
        public init(features: TapFeatures, label: String, posture: String?) {
            self.features = features; self.label = label; self.posture = posture
        }
    }

    /// Result of `train(_:)`.
    public struct Training: Sendable {
        public var set: ZoneModelSet
        /// The calibration report of each posture's model (same meaning as `Trainer.train()`'s).
        public var reports: [String: CalibrationReport]
        /// Per posture, zones that had no samples in that posture and were borrowed from the other postures.
        public var borrowedZones: [String: [String]]
    }

    /// Trains one model per posture from calibration samples tagged with their posture.
    ///
    /// - Samples without a posture count as `legacyPosture` (the daemon's default posture is "desk").
    /// - A posture gets its own model when it has at least `minZoneTaps` zone samples; with fewer, its samples still
    ///   train the other postures' models as borrowed zones.
    /// - Each posture's model learns its own samples, plus the zone samples of zones it lacks from the other
    ///   postures (so every model knows every zone; `borrowZones`), plus every posture's "none" negatives (typing is
    ///   typing, and negatives are scarce; `poolNegatives`).
    /// - Its calibration gravity comes from its own samples only.
    /// - If no posture qualifies, the result is a single model trained on everything.
    public static func train(_ samples: [PostureSample], legacyPosture: String = "desk", minZoneTaps: Int = 20,
                             fallback: String? = nil, borrowZones: Bool = true, poolNegatives: Bool = true) -> Training {
        let none = ZoneModel.noneLabel
        func posture(_ s: PostureSample) -> String { s.posture ?? legacyPosture }
        var zoneCount: [String: Int] = [:]
        for s in samples where s.label != none { zoneCount[posture(s), default: 0] += 1 }
        let own = zoneCount.filter { $0.value >= minZoneTaps }.keys.sorted()

        func fit(_ xs: [PostureSample]) -> (ZoneModel, CalibrationReport) {
            let t = Trainer()
            for s in xs { t.add(s.features, label: s.label) }
            return t.train()
        }
        guard !own.isEmpty else {
            let (m, r) = fit(samples)
            let name = zoneCount.max { $0.value < $1.value || ($0.value == $1.value && $0.key > $1.key) }?.key ?? legacyPosture
            return Training(set: ZoneModelSet(single: m, posture: name), reports: [name: r], borrowedZones: [name: []])
        }
        var models: [String: ZoneModel] = [:], reports: [String: CalibrationReport] = [:], borrowed: [String: [String]] = [:]
        for p in own {
            let mine = samples.filter { posture($0) == p }
            let myZones = Set(mine.map(\.label)).subtracting([none])
            let otherZones = borrowZones ? samples.filter { posture($0) != p && $0.label != none && !myZones.contains($0.label) } : []
            let otherNegatives = poolNegatives ? samples.filter { posture($0) != p && $0.label == none } : []
            let fitted = fit(mine + otherZones + otherNegatives)
            var m = fitted.0
            // Gravity from this posture's own samples only (the Trainer's mean would include borrowed ones).
            let gs = mine.compactMap(\.features.gravity)
            if gs.count >= 5, 2 * gs.count >= mine.count, let g = meanGravity(gs) {
                m.calibrationGravity = g.direction; m.calibrationGravitySpread = g.spread
            } else {
                m.calibrationGravity = nil; m.calibrationGravitySpread = nil
            }
            models[p] = m; reports[p] = fitted.1
            borrowed[p] = Set(otherZones.map(\.label)).sorted()
        }
        return Training(set: ZoneModelSet(models: models, fallback: fallback), reports: reports, borrowedZones: borrowed)
    }
}
