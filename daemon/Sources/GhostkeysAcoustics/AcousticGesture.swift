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

    // SonarField (stereo pilots, one per speaker group).
    /// Quick hand motion down toward a speaker. `side` says which.
    case push
    /// Quick hand motion up away from a speaker.
    case pull
    /// Hand passed from right to left above the keyboard.
    case sweepLeft = "sweep_left"
    /// Hand passed from left to right above the keyboard.
    case sweepRight = "sweep_right"
    /// Finger slid on the laptop surface (contact confirmed by friction sound) toward the left.
    case fingerSlideLeft = "finger_slide_left"
    case fingerSlideRight = "finger_slide_right"
    /// Toward the hinge (where the microphones are).
    case fingerSlideUp = "finger_slide_up"
    /// Toward the front edge.
    case fingerSlideDown = "finger_slide_down"
}

/// Which speaker group a SonarField reading or gesture belongs to.
public enum SpeakerSide: String, Codable, Sendable { case left, right }

/// Continuous SonarField values, shaped like the camera's `air` messages.
public enum AcousticAirKind: String, Codable, Sendable {
    /// Hand raised or lowered above one speaker: a slider (volume, brightness...).
    case hoverLevel = "hover_level"
    /// Finger sliding on the surface while touching (friction confirmed).
    case fingerSlide = "finger_slide"
}

public enum AirPhase: String, Codable, Sendable { case began, changed, ended }

/// One sample of a continuous gesture. Send as `{"type":"air","gesture":kind,"phase":phase,...}`.
public struct AcousticAirEvent: Codable, Equatable, Sendable {
    public var kind: AcousticAirKind
    public var phase: AirPhase
    public var time: Double
    public var side: SpeakerSide?
    /// hover_level: displacement / hoverRangeMm, clamped to -1...1, positive = hand raised.
    /// finger_slide: dyMm / slideRangeMm, clamped to -1...1, positive = toward the hinge.
    public var value: Double
    /// hover_level: estimated hand displacement since `began`, mm, positive = away from the speaker (raised).
    /// finger_slide: the larger of |dxMm| and |dyMm|, with its sign.
    public var displacementMm: Double
    /// finger_slide only: lateral (positive = right) and along-grille (positive = toward the hinge) movement, mm.
    public var dxMm: Double?
    public var dyMm: Double?
    public var confidence: Double
    /// Set on `ended` when the gesture was abandoned (suppressed by typing, interference, or turned out to be a sweep).
    public var cancelled: Bool

    public init(kind: AcousticAirKind, phase: AirPhase, time: Double, side: SpeakerSide?, value: Double, displacementMm: Double,
                dxMm: Double? = nil, dyMm: Double? = nil, confidence: Double, cancelled: Bool = false) {
        self.kind = kind; self.phase = phase; self.time = time; self.side = side; self.value = value
        self.displacementMm = displacementMm; self.dxMm = dxMm; self.dyMm = dyMm
        self.confidence = confidence; self.cancelled = cancelled
    }
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
    /// SonarField gestures: which speaker side.
    public var side: SpeakerSide?
    /// SonarField gestures: estimated movement, mm (hand displacement for push/pull, path difference for sweeps,
    /// finger travel for slides).
    public var distanceMm: Double?

    public var name: String { kind.rawValue }

    public init(kind: AcousticGestureKind, time: Double, confidence: Double, duration: Double? = nil,
                speedProxy: Double? = nil, speedMetersPerSecond: Double? = nil,
                direction: RubDirection? = nil, directionConfidence: Double? = nil,
                side: SpeakerSide? = nil, distanceMm: Double? = nil) {
        self.kind = kind
        self.time = time
        self.confidence = confidence
        self.duration = duration
        self.speedProxy = speedProxy
        self.speedMetersPerSecond = speedMetersPerSecond
        self.direction = direction
        self.directionConfidence = directionConfidence
        self.side = side
        self.distanceMm = distanceMm
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
    /// SonarField continuous value (hover_level, finger_slide).
    case air(AcousticAirEvent)
}
