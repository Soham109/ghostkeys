// Shared API between the detection library and the daemon.
// The detection agent owns the implementation; keep these public signatures stable.

import Foundation

/// One motion sensor reading. `t` in seconds (monotonic). Acceleration in g, rotation in degrees per second.
public struct IMUSample: Sendable {
    public var t: Double
    public var a: SIMD3<Double>
    public var g: SIMD3<Double>
    public init(t: Double, a: SIMD3<Double>, g: SIMD3<Double>) { self.t = t; self.a = a; self.g = g }
}

/// What else is happening on the machine at the moment of a sample.
public struct InputContext: Sendable {
    public var secondsSinceKey: Double
    public var secondsSinceMouse: Double
    public var modifiers: Set<String>      // shift, control, option, command, fn
    public var lidAngle: Double?
    public var paused: Bool
    /// Seconds since the last key release. A key held longer than the typing gate still makes a release bump.
    public var secondsSinceKeyUp: Double
    /// Seconds since a modifier key (shift, control, option, command, fn) went down or up. Informational: a modifier
    /// pressed just before a tap is normally intentional (shift + tap), so the engine does not gate on it.
    public var secondsSinceModifierChange: Double
    public init(secondsSinceKey: Double = 99, secondsSinceMouse: Double = 99, modifiers: Set<String> = [], lidAngle: Double? = nil, paused: Bool = false,
                secondsSinceKeyUp: Double = 99, secondsSinceModifierChange: Double = 99) {
        self.secondsSinceKey = secondsSinceKey; self.secondsSinceMouse = secondsSinceMouse
        self.modifiers = modifiers; self.lidAngle = lidAngle; self.paused = paused
        self.secondsSinceKeyUp = secondsSinceKeyUp; self.secondsSinceModifierChange = secondsSinceModifierChange
    }
}

public struct DetectionSettings: Codable, Sendable {
    public var sensitivity: Double = 0.5        // 0 (strict) ... 1 (sensitive)
    public var typingGateMs: Double = 450
    public var doubleWindowMs: Double = 350
    public var minConfidence: Double = 0.8
    /// In zones that need multiple taps, a tap at this confidence (same zone) may complete a double or
    /// triple whose other tap passed minConfidence. Set equal to minConfidence to disable.
    public var followUpConfidence: Double = 0.5
    /// Light-touch mode (off by default): an onset floor learned from calibration taps, a 6 mg floor
    /// on a quiet desk, and onset restart. Lets 8 to 40 mg taps trigger, but on this user's desk it
    /// also let in ~2.5x more junk spikes (40/min vs 15/min on the real rest recording), some read as
    /// a grille at 0.5 to 0.8 confidence, and live accuracy regressed with a firm-tap calibration.
    /// Only turn it on together with a calibration done with light taps.
    public var lightTouch: Bool = false
    public init() {}

    // Tolerant decoding: a config written by an older or newer app may lack some keys (or carry
    // extra ones such as hud/haptics); missing keys keep their defaults.
    private enum CodingKeys: String, CodingKey { case sensitivity, typingGateMs, doubleWindowMs, minConfidence, followUpConfidence, lightTouch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sensitivity = try c.decodeIfPresent(Double.self, forKey: .sensitivity) ?? sensitivity
        typingGateMs = try c.decodeIfPresent(Double.self, forKey: .typingGateMs) ?? typingGateMs
        doubleWindowMs = try c.decodeIfPresent(Double.self, forKey: .doubleWindowMs) ?? doubleWindowMs
        minConfidence = try c.decodeIfPresent(Double.self, forKey: .minConfidence) ?? minConfidence
        followUpConfidence = try c.decodeIfPresent(Double.self, forKey: .followUpConfidence) ?? followUpConfidence
        lightTouch = try c.decodeIfPresent(Bool.self, forKey: .lightTouch) ?? lightTouch
    }
}

/// Feature vector of one tap candidate (fixed length, see Features/FeatureExtractor.swift for the index table).
public struct TapFeatures: Codable, Sendable {
    public var values: [Double]
    public var t: Double
    /// Direction of the low-passed gravity vector (unit length, device coordinates, as the accelerometer reads it at
    /// rest) when the candidate happened: the posture of the machine. Set by `TapEngine` on every candidate (round 3,
    /// docs/review/DETECTION_ROUND3.md). Optional: samples saved by older builds have none. Not a classifier feature.
    public var gravity: SIMD3<Double>?
    public init(values: [Double], t: Double, gravity: SIMD3<Double>? = nil) { self.values = values; self.t = t; self.gravity = gravity }
}

public enum RejectReason: String, Codable, Sendable { case typing, trackpad, motion, low_confidence, burst, paused }

public struct TapEvent: Sendable {
    public var t: Double
    public var zone: String
    public var confidence: Double
    public var x: Double      // estimated position, 0...1 (see PROTOCOL.md)
    public var y: Double
    public var strength: Double
    public var modifiers: Set<String>
    public init(t: Double, zone: String, confidence: Double, x: Double, y: Double, strength: Double, modifiers: Set<String>) {
        self.t = t; self.zone = zone; self.confidence = confidence; self.x = x; self.y = y
        self.strength = strength; self.modifiers = modifiers
    }
}

public struct GestureEvent: Sendable {
    public var t: Double
    public var gesture: String         // tap, double, triple, sequence, rhythm, lid_nudge, cover, cover_hold, tilt_left, tilt_right
    public var zone: String?
    public var zones: [String]
    public var modifiers: Set<String>
    public var confidence: Double
    public init(t: Double, gesture: String, zone: String?, zones: [String], modifiers: Set<String>, confidence: Double) {
        self.t = t; self.gesture = gesture; self.zone = zone; self.zones = zones
        self.modifiers = modifiers; self.confidence = confidence
    }
}

public enum DetectorEvent: Sendable {
    case candidate(TapFeatures)        // every spike that passed onset detection (used for calibration capture)
    case rejected(t: Double, reason: RejectReason)
    case tap(TapEvent)
    case gesture(GestureEvent)
}
