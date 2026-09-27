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

    /// Something undid the recent taps (feedback, Cmd+Z): nothing from the last 5 s is learned.
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
