import Foundation

public enum GhostkeysAcousticsInfo {
    public static let version = "0.1.0"
    /// The only sample rate the detectors are tuned for. `AcousticSession` resamples the microphone to this.
    public static let sampleRate: Double = 48_000
}

/// Sound-mode gesture names, spelled exactly as they go on the wire in `{"type":"gesture","gesture":...}`.
public enum AcousticGestureKind: String, Codable, CaseIterable, Sendable {
    /// A tap the IMU detected, which sound classified as a knuckle knock.
    case knockKnuckle = "knock_knuckle"
    /// A sustained rub or swipe whose direction is not certain.
    case rub
    /// A rub moving toward the left (only emitted when direction confidence is high).
    case rubLeft = "rub_left"
    /// A rub moving toward the right (only emitted when direction confidence is high).
    case rubRight = "rub_right"
    /// Hand moved toward the laptop (sonar).
    case waveToward = "wave_toward"
    /// Hand moved away from the laptop (sonar).
    case waveAway = "wave_away"
    /// Hand passed over the laptop: toward then away within one motion (sonar).
    case waveSweep = "wave_sweep"
}

/// A recognized sound-mode gesture. `time` is on the caller's clock (seconds), the same clock passed to `process`.
public struct AcousticGesture: Codable, Equatable, Sendable {
    public var kind: AcousticGestureKind
    public var time: Double
    public var confidence: Double
    /// Rubs and waves: how long the motion lasted, seconds.
    public var duration: Double?
    /// Rubs: 0...1 uncalibrated speed proxy from the spectral centroid.
    public var speedProxy: Double?
    /// Rubs on the speaker grille (comb tone found) or waves (Doppler): estimated speed, meters per second.
    public var speedMetersPerSecond: Double?
    /// Rubs: loudness-trend direction and its confidence, reported even when too weak for `rub_left` / `rub_right`.
    public var direction: RubDirection?
    public var directionConfidence: Double?

    public var name: String { kind.rawValue }

    public init(kind: AcousticGestureKind, time: Double, confidence: Double, duration: Double? = nil,
                speedProxy: Double? = nil, speedMetersPerSecond: Double? = nil,
                direction: RubDirection? = nil, directionConfidence: Double? = nil) {
        self.kind = kind
        self.time = time
        self.confidence = confidence
        self.duration = duration
        self.speedProxy = speedProxy
        self.speedMetersPerSecond = speedMetersPerSecond
        self.direction = direction
        self.directionConfidence = directionConfidence
    }
}

/// Everything `SoundModeProcessor` reports. Only `.gesture` should drive actions; the rest is live feedback.
public enum AcousticEvent: Equatable, Sendable {
    case gesture(AcousticGesture)
    /// Result of classifying the audio around an IMU tap onset (all types, including rejected ones).
    case tapClassified(onset: Double, TapClassification)
    /// A rub has been sustained long enough to count (useful for live UI).
    case rubStarted(time: Double)
    /// A rub that had started was thrown away.
    case rubCancelled(time: Double, reason: RubCancelReason)
    /// Full measurement of an accepted rub (the matching `.gesture` is emitted alongside).
    case rubEnded(RubSummary)
    /// Raw sonar result (the matching `.gesture` is emitted alongside).
    case wave(SonarWaveEvent)
}
