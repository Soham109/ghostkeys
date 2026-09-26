// Runs Vision's hand pose model on camera frames and returns smoothed, normalized landmarks.
// Never opens a camera itself: it only consumes buffers handed to it.
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import Vision

public final class HandTracker {
    public struct Options: Sendable {
        /// Vision's limit; 2 is enough for two_hand_zoom.
        public var maximumHandCount: Int = 2
        /// Flip x so that "right" means the user's right. True for the front camera (it sees a mirror image
        /// of the user), false for Desk View (already shown from the user's point of view).
        public var mirrorHorizontally: Bool = true
        /// Joints below this Vision confidence are reported with confidence 0 (treated as unseen).
        public var minimumJointConfidence: Double = 0.1
        /// One Euro smoothing. Set `smoothing` to false to get raw landmarks.
        public var smoothing: Bool = true
        public var smoothingMinCutoff: Double = 1.5
        public var smoothingBeta: Double = 8.0
        /// Orientation of the buffers. `.up` for the Mac cameras.
        public var orientation: CGImagePropertyOrientation = .up
        public init() {}
    }

    public let options: Options
    private let request: VNDetectHumanHandPoseRequest
    private let sequenceHandler = VNSequenceRequestHandler()
    /// One smoother per tracked hand slot, matched frame to frame by wrist position.
    private var slots: [(wrist: Point2, smoother: HandSmoother, lastT: TimeInterval)] = []

    public init(options: Options = Options()) {
        self.options = options
        request = VNDetectHumanHandPoseRequest()
        request.maximumHandCount = options.maximumHandCount
    }

    /// Detect hands in a camera sample buffer. `t` defaults to the buffer's presentation time.
    public func process(sampleBuffer: CMSampleBuffer, t: TimeInterval? = nil) throws -> HandFrame {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return HandFrame(t: t ?? 0, hands: [])
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let time = t ?? (pts.isValid ? pts.seconds : 0)
        return try process(pixelBuffer: pixelBuffer, t: time)
    }

    /// Detect hands in a pixel buffer taken at time `t` (seconds).
    public func process(pixelBuffer: CVPixelBuffer, t: TimeInterval) throws -> HandFrame {
        try sequenceHandler.perform([request], on: pixelBuffer, orientation: options.orientation)
        let observations = request.results ?? []
        var raw: [HandLandmarks] = []
        for obs in observations {
            guard let points = try? obs.recognizedPoints(.all) else { continue }
            var dict: [HandJoint: (x: Double, y: Double, confidence: Double)] = [:]
            for (name, p) in points {
                guard let j = HandTracker.joint(for: name) else { continue }
                dict[j] = (Double(p.location.x), Double(p.location.y), Double(p.confidence))
            }
            let chir: Chirality
            switch obs.chirality {
            case .left: chir = .left
            case .right: chir = .right
            default: chir = .unknown
            }
            raw.append(HandTracker.landmarks(fromVisionPoints: dict, chirality: chir,
                                             mirror: options.mirrorHorizontally,
                                             minimumJointConfidence: options.minimumJointConfidence))
        }
        return HandFrame(t: t, hands: smooth(raw, t: t))
    }

    /// Forget smoothing history (call when an air session starts).
    public func reset() { slots.removeAll() }

    /// Converts Vision points (origin bottom-left, y up) to landmark space (origin top-left, y down),
    /// mirroring x when asked. Missing or weak joints get confidence 0.
    public static func landmarks(fromVisionPoints dict: [HandJoint: (x: Double, y: Double, confidence: Double)],
                                 chirality: Chirality, mirror: Bool,
                                 minimumJointConfidence: Double = 0.1) -> HandLandmarks {
        var pts = [Point2](repeating: .zero, count: HandJoint.count)
        var confs = [Double](repeating: 0, count: HandJoint.count)
        for j in HandJoint.allCases {
            guard let p = dict[j] else { continue }
            let x = mirror ? 1 - p.x : p.x
            pts[j.rawValue] = Point2(x, 1 - p.y)
            confs[j.rawValue] = p.confidence >= minimumJointConfidence ? p.confidence : 0
        }
        return HandLandmarks(points: pts, confidences: confs, chirality: chirality)
    }

    private func smooth(_ hands: [HandLandmarks], t: TimeInterval) -> [HandLandmarks] {
        guard options.smoothing else { return hands }
        // Drop slots not refreshed recently so a new hand does not inherit an old hand's filter state.
        slots.removeAll { t - $0.lastT > 0.5 || t < $0.lastT }
        var used = Set<Int>()
        var out: [HandLandmarks] = []
        for h in hands {
            let w = h[.wrist]
            var best: Int?
            var bestD = 0.25
            for (i, s) in slots.enumerated() where !used.contains(i) {
                let d = s.wrist.distance(to: w)
                if d < bestD { bestD = d; best = i }
            }
            let idx: Int
            if let b = best {
                idx = b
            } else {
                slots.append((w, HandSmoother(minCutoff: options.smoothingMinCutoff, beta: options.smoothingBeta), t))
                idx = slots.count - 1
            }
            used.insert(idx)
            let sm = slots[idx].smoother.smooth(h, t: t)
            slots[idx].wrist = sm[.wrist]
            slots[idx].lastT = t
            out.append(sm)
        }
        return out
    }

    static func joint(for name: VNHumanHandPoseObservation.JointName) -> HandJoint? {
        switch name {
        case .wrist: return .wrist
        case .thumbCMC: return .thumbCMC
        case .thumbMP: return .thumbMP
        case .thumbIP: return .thumbIP
        case .thumbTip: return .thumbTip
        case .indexMCP: return .indexMCP
        case .indexPIP: return .indexPIP
        case .indexDIP: return .indexDIP
        case .indexTip: return .indexTip
        case .middleMCP: return .middleMCP
        case .middlePIP: return .middlePIP
        case .middleDIP: return .middleDIP
        case .middleTip: return .middleTip
        case .ringMCP: return .ringMCP
        case .ringPIP: return .ringPIP
        case .ringDIP: return .ringDIP
        case .ringTip: return .ringTip
        case .littleMCP: return .littleMCP
        case .littlePIP: return .littlePIP
        case .littleDIP: return .littleDIP
        case .littleTip: return .littleTip
        default: return nil
        }
    }
}
