// STUB: the detection agent replaces the bodies. Public signatures are the contract with the daemon.
import Foundation

public struct CalibrationReport: Codable, Sendable {
    public var labels: [String]
    public var accuracy: [String: Double]
    public var overall: Double
    public var confusion: [[Int]]
    public init(labels: [String], accuracy: [String: Double], overall: Double, confusion: [[Int]]) {
        self.labels = labels; self.accuracy = accuracy; self.overall = overall; self.confusion = confusion
    }
}

/// Trained per-user zone classifier. Codable so the daemon can save it as JSON.
public struct ZoneModel: Codable, Sendable {
    public var labels: [String]
    public init(labels: [String]) { self.labels = labels }
    /// Returns the best zone ("none" if rejected), its confidence 0...1 and an estimated x,y (0...1).
    public func classify(_ f: TapFeatures) -> (zone: String, confidence: Double, x: Double, y: Double) {
        return ("none", 0, 0.5, 0.5)
    }
}

/// Collects labeled feature vectors during calibration and trains a ZoneModel.
public final class Trainer {
    public init() {}
    public func add(_ f: TapFeatures, label: String) {}
    public var counts: [String: Int] { [:] }
    public func train() -> (ZoneModel, CalibrationReport) {
        (ZoneModel(labels: []), CalibrationReport(labels: [], accuracy: [:], overall: 0, confusion: []))
    }
}

/// Streaming tap detector + classifier + gesture grammar. Feed every IMU sample in order.
public final class TapEngine {
    public var settings: DetectionSettings
    public var model: ZoneModel?
    public init(settings: DetectionSettings) { self.settings = settings }
    public func ingest(_ s: IMUSample, context: InputContext) -> [DetectorEvent] { [] }
}

/// Lid nudge: angle in degrees, t in seconds.
public final class LidGestureDetector {
    public init() {}
    public func ingest(angle: Double, t: Double) -> GestureEvent? { nil }
}

/// Cover the ambient light sensor. value normalized 0...1, t in seconds.
public final class LightGestureDetector {
    public init() {}
    public func ingest(value: Double, t: Double) -> GestureEvent? { nil }
}
