import Foundation
import GhostkeysDetection

/// State of one calibration run. Owned and mutated only on the daemon's core queue.
final class CalibrationSession {
    enum Phase: Equatable {
        case idle                       // started, waiting for calibration_zone / calibration_negatives
        case capturing(zone: String)
        case negatives(until: Double)   // mach-clock seconds
    }

    let zones: [String]
    let target: Int
    let trainer = Trainer()
    private(set) var phase: Phase = .idle
    private(set) var counts: [String: Int] = [:]
    private(set) var samples: [ConfigStore.LabeledSample] = []

    init(zones: [String], target: Int) {
        self.zones = zones
        self.target = max(1, min(500, target))
    }

    func beginZone(_ zone: String) {
        phase = .capturing(zone: zone)
    }

    func beginNegatives(seconds: Double, now: Double) {
        phase = .negatives(until: now + max(1, min(600, seconds)))
    }

    func endPhase() { phase = .idle }

    /// Label one candidate according to the current phase.
    /// Returns the zone and its new count when a zone sample was captured (nil otherwise).
    @discardableResult
    func capture(_ f: TapFeatures, now: Double) -> (zone: String, count: Int)? {
        switch phase {
        case .idle:
            return nil
        case .capturing(let zone):
            let c = counts[zone, default: 0]
            guard c < target else { return nil }
            add(f, label: zone)
            return (zone, c + 1)
        case .negatives(let until):
            guard now < until else { return nil }
            add(f, label: "none")
            return nil
        }
    }

    private func add(_ f: TapFeatures, label: String) {
        trainer.add(f, label: label)
        counts[label, default: 0] += 1
        samples.append(.init(label: label, features: f))
    }
}
