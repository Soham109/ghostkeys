import Foundation
import GhostkeysDetection

/// Online adaptation from confirmed taps (settings.learnFromUse). Used only on the daemon's core queue.
///
/// A tap counts as confirmed when it fired a bound action that succeeded, its confidence was at least
/// minConfidence, and nothing undid it within 5 s: no feedback_missed / feedback_false and no Cmd+Z. Very confident
/// taps (>= 0.97) teach little, so only 1 in 3 of them is kept. Confirmed taps are stored in model/confirmed.json,
/// capped per zone (at most 20, and at most half that zone's calibration samples; the oldest is replaced).
/// "none" is never added here.
final class UseLearner {
    struct Confirmed: Codable {
        var label: String
        var features: TapFeatures
        var source = "confirmed"
        var ts: Double              // seconds since 1970
    }

    private struct Pending { var id: Int; var t: Double; var zone: String; var confidence: Double; var features: TapFeatures
                             var actionOK: Bool? = nil }

    static let confirmWindow = 5.0
    static let perZoneMax = 20
    static let maxShareOfCalibration = 0.5
    static let highConfidence = 0.97
    static let retrainAfter = 10
    static let idleSeconds = 60.0

    let url: URL
    private(set) var confirmed: [Confirmed] = []
    private var pending: [Pending] = []
    private var nextID = 1
    private var highCounter: [String: Int] = [:]
    /// Confirmations added since the model was last (re)trained with them.
    private(set) var newSinceTrain = 0

    init(modelDirectory: URL) {
        url = modelDirectory.appendingPathComponent("confirmed.json")
        if let data = try? Data(contentsOf: url), let list = try? JSONDecoder().decode([Confirmed].self, from: data) {
            confirmed = list.filter { $0.label != ZoneModel.noneLabel }
        }
    }

    var hasPending: Bool { !pending.isEmpty }

    /// A gesture fired a bound action; these are its taps. Returns the id to report the action result with.
    func register(taps: [(t: Double, zone: String, confidence: Double, features: TapFeatures)], minConfidence: Double) -> Int? {
        let eligible = taps.filter { $0.zone != ZoneModel.noneLabel && $0.confidence >= minConfidence }
        guard !eligible.isEmpty else { return nil }
        let id = nextID
        nextID += 1
        for tap in eligible {
            if tap.confidence >= Self.highConfidence {
                highCounter[tap.zone, default: 0] += 1
                guard highCounter[tap.zone]! % 3 == 1 else { continue }   // keep 1 in 3
            }
            pending.append(Pending(id: id, t: tap.t, zone: tap.zone, confidence: tap.confidence, features: tap.features))
        }
        return id
    }

    func actionFinished(id: Int, ok: Bool) {
        for i in pending.indices where pending[i].id == id { pending[i].actionOK = ok }
    }

    /// Cmd+Z undoes the most recent action: drop only the taps behind the latest gesture still pending.
    func cancelLatest(reason: String) {
        guard let latest = pending.map(\.id).max() else { return }
        let n = pending.filter { $0.id == latest }.count
        pending.removeAll { $0.id == latest }
        Log.debug("learn-from-use: dropped \(n) pending tap(s) of the latest gesture: \(reason)")
    }

    /// Drop the gesture whose taps include the tap at `t` (for example the tap feedback_false is about).
    func cancelGesture(containing t: Double, reason: String) {
        let ids = Set(pending.filter { abs($0.t - t) < 0.005 }.map(\.id))
        guard !ids.isEmpty else { return }
        pending.removeAll { ids.contains($0.id) }
        Log.debug("learn-from-use: dropped the pending taps of \(ids.count) gesture(s): \(reason)")
    }

    /// Everything pending (learnFromUse was switched off).
    func cancelPending(reason: String) {
        guard !pending.isEmpty else { return }
        Log.debug("learn-from-use: dropped \(pending.count) pending tap(s): \(reason)")
        pending.removeAll()
    }

    /// Moves taps older than 5 s whose action succeeded into the confirmed set. `calibrationCounts` caps each zone.
    /// Returns how many were added.
    @discardableResult
    func promoteDue(now: Double, calibrationCounts: [String: Int], disabled: Set<String>) -> Int {
        var added = 0
        var keep: [Pending] = []
        for p in pending {
            guard now - p.t >= Self.confirmWindow else { keep.append(p); continue }
            guard p.actionOK == true, !disabled.contains(p.zone) else { continue }
            let cap = min(Self.perZoneMax, Int(Double(calibrationCounts[p.zone] ?? 0) * Self.maxShareOfCalibration))
            guard cap > 0 else { continue }
            var inZone = confirmed.indices.filter { confirmed[$0].label == p.zone }
            while inZone.count >= cap, let oldest = inZone.min(by: { confirmed[$0].ts < confirmed[$1].ts }) {
                confirmed.remove(at: oldest)
                inZone = confirmed.indices.filter { confirmed[$0].label == p.zone }
            }
            confirmed.append(Confirmed(label: p.zone, features: TapFeatures(values: p.features.values, t: 0),
                                       ts: Date().timeIntervalSince1970))
            added += 1
        }
        pending = keep
        if added > 0 {
            newSinceTrain += added
            save()
            Log.debug("learn-from-use: \(added) confirmed tap(s), \(newSinceTrain) new since last training")
        }
        return added
    }

    func markTrained() { newSinceTrain = 0 }

    /// Ship guard failed (or a new calibration replaced the data): drop every confirmed tap (kept as .bak).
    func discardAll(reason: String) {
        guard !confirmed.isEmpty || newSinceTrain > 0 else { return }
        Log.info("learn-from-use: discarded \(confirmed.count) confirmed tap(s): \(reason)")
        confirmed.removeAll()
        newSinceTrain = 0
        save()
    }

    /// A zone was recalibrated: what use taught about it no longer applies. Other zones keep theirs.
    func discard(labels: Set<String>, reason: String) {
        let before = confirmed.count
        confirmed.removeAll { labels.contains($0.label) }
        guard confirmed.count != before else { return }
        Log.info("learn-from-use: discarded \(before - confirmed.count) confirmed tap(s) of \(labels.sorted()): \(reason)")
        save()
    }

    /// Removes individual confirmed taps (the ship guard's neighbour check rejected them).
    func remove(ts: Set<Double>, reason: String) {
        let before = confirmed.count
        confirmed.removeAll { ts.contains($0.ts) }
        guard confirmed.count != before else { return }
        Log.info("learn-from-use: removed \(before - confirmed.count) confirmed tap(s): \(reason)")
        save()
    }

    // MARK: Ship guard helpers (deterministic)

    /// Rejects confirmed taps that disagree with the calibration: among the 5 nearest calibration samples (features
    /// standardized with the calibration's mean and spread) fewer than 3 carry the same label, or the nearest same-label
    /// calibration sample is more than twice that label's typical nearest-neighbour distance (its 95th percentile) away.
    /// Returns the `ts` of the rejected ones.
    static func disagreeing(_ confirmed: [Confirmed], calibration: [ConfigStore.LabeledSample]) -> Set<Double> {
        guard let dim = calibration.first?.features.values.count, dim > 0, calibration.count >= 5 else { return [] }
        let rows = calibration.map(\.features.values).filter { $0.count == dim }
        var mean = [Double](repeating: 0, count: dim), sd = [Double](repeating: 0, count: dim)
        for r in rows { for j in 0..<dim { mean[j] += r[j] } }
        for j in 0..<dim { mean[j] /= Double(rows.count) }
        for r in rows { for j in 0..<dim { sd[j] += (r[j] - mean[j]) * (r[j] - mean[j]) } }
        for j in 0..<dim { sd[j] = max((sd[j] / Double(rows.count)).squareRoot(), 1e-9) }
        func z(_ v: [Double]) -> [Double] { (0..<dim).map { (v[$0] - mean[$0]) / sd[$0] } }
        func dist(_ a: [Double], _ b: [Double]) -> Double {
            var sum = 0.0
            for i in 0..<min(a.count, b.count) { let d = a[i] - b[i]; sum += d * d }
            return sum.squareRoot()
        }
        let calib = calibration.filter { $0.features.values.count == dim }.map { (label: $0.label, v: z($0.features.values)) }
        // Per label: 95th percentile of each sample's distance to its nearest same-label neighbour.
        var typical: [String: Double] = [:]
        for label in Set(calib.map(\.label)) {
            let members = calib.filter { $0.label == label }
            guard members.count >= 3 else { continue }
            var nn: [Double] = []
            for (i, m) in members.enumerated() {
                nn.append(members.enumerated().filter { $0.offset != i }.map { dist(m.v, $0.element.v) }.min()!)
            }
            nn.sort()
            typical[label] = nn[min(nn.count - 1, Int((Double(nn.count - 1) * 0.95).rounded(.up)))]
        }
        var rejected = Set<Double>()
        for c in confirmed {
            guard c.features.values.count == dim else { rejected.insert(c.ts); continue }
            let v = z(c.features.values)
            var ranked: [(label: String, d: Double)] = calib.map { (label: $0.label, d: dist(v, $0.v)) }
            ranked.sort { (x, y) in x.d != y.d ? x.d < y.d : x.label < y.label }
            let same = ranked.prefix(5).filter { $0.label == c.label }.count
            let nearestSame = ranked.first { $0.label == c.label }?.d ?? .infinity
            if same < 3 { rejected.insert(c.ts); continue }
            if let t = typical[c.label], t > 0, nearestSame > 2 * t { rejected.insert(c.ts) }
        }
        return rejected
    }

    /// Merge support: confirmed taps of either zone now belong to the merged zone.
    func relabel(_ from: Set<String>, to: String) {
        var changed = false
        for i in confirmed.indices where from.contains(confirmed[i].label) { confirmed[i].label = to; changed = true }
        if changed { save() }
    }

    var asSamples: [ConfigStore.LabeledSample] { confirmed.map { .init(label: $0.label, features: $0.features) } }

    private func save() {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: url.path) {
                let bak = url.appendingPathExtension("bak")
                try? fm.removeItem(at: bak)
                try? fm.copyItem(at: url, to: bak)
            }
            try JSONEncoder().encode(confirmed).write(to: url, options: .atomic)
        } catch {
            Log.error("could not save confirmed taps: \(error)")
        }
    }
}
