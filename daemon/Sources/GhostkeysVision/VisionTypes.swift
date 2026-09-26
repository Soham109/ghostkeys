// Shared value types for the camera add-on. No AVFoundation or Vision here, so everything is testable.
import Foundation

public enum GhostkeysVisionInfo {
    public static let version = "0.1.0"
}

/// A 2D point. In landmark space: normalized image coordinates, origin top-left, x right, y down.
/// In deck space: PROTOCOL coordinates, x 0 (left edge of the base) to 1 (right), y 0 (hinge) to 1 (front lip).
public struct Point2: Equatable, Hashable, Sendable, CustomStringConvertible {
    public var x: Double
    public var y: Double
    public init(_ x: Double, _ y: Double) { self.x = x; self.y = y }
    public init(x: Double, y: Double) { self.x = x; self.y = y }

    public static let zero = Point2(0, 0)
    public static func + (a: Point2, b: Point2) -> Point2 { Point2(a.x + b.x, a.y + b.y) }
    public static func - (a: Point2, b: Point2) -> Point2 { Point2(a.x - b.x, a.y - b.y) }
    public static func * (a: Point2, k: Double) -> Point2 { Point2(a.x * k, a.y * k) }
    public static func / (a: Point2, k: Double) -> Point2 { Point2(a.x / k, a.y / k) }
    public var length: Double { (x * x + y * y).squareRoot() }
    public func distance(to o: Point2) -> Double { (self - o).length }
    public var description: String { String(format: "(%.4f, %.4f)", x, y) }
}

/// The 21 hand joints, in the order Vision's hand pose model defines them.
public enum HandJoint: Int, CaseIterable, Sendable {
    case wrist = 0
    case thumbCMC, thumbMP, thumbIP, thumbTip
    case indexMCP, indexPIP, indexDIP, indexTip
    case middleMCP, middlePIP, middleDIP, middleTip
    case ringMCP, ringPIP, ringDIP, ringTip
    case littleMCP, littlePIP, littleDIP, littleTip

    public static let count = 21
}

/// The four long fingers (the thumb is handled separately by the pinch logic).
public enum Finger: Int, CaseIterable, Sendable {
    case index, middle, ring, little

    /// MCP, PIP, DIP, TIP joints of this finger.
    public var joints: (mcp: HandJoint, pip: HandJoint, dip: HandJoint, tip: HandJoint) {
        switch self {
        case .index: return (.indexMCP, .indexPIP, .indexDIP, .indexTip)
        case .middle: return (.middleMCP, .middlePIP, .middleDIP, .middleTip)
        case .ring: return (.ringMCP, .ringPIP, .ringDIP, .ringTip)
        case .little: return (.littleMCP, .littlePIP, .littleDIP, .littleTip)
        }
    }
}

public enum Chirality: String, Sendable, Codable {
    case left, right, unknown
}

/// One detected hand: 21 normalized joint positions with per-joint confidence (0..1).
public struct HandLandmarks: Equatable, Sendable {
    public var points: [Point2]
    public var confidences: [Double]
    public var chirality: Chirality

    public init(points: [Point2], confidences: [Double], chirality: Chirality = .unknown) {
        precondition(points.count == HandJoint.count && confidences.count == HandJoint.count,
                     "HandLandmarks needs exactly 21 points and 21 confidences")
        self.points = points
        self.confidences = confidences
        self.chirality = chirality
    }

    public subscript(_ j: HandJoint) -> Point2 {
        get { points[j.rawValue] }
        set { points[j.rawValue] = newValue }
    }

    public func confidence(_ j: HandJoint) -> Double { confidences[j.rawValue] }

    /// Mean joint confidence: the "hand confidence" used by the gates.
    public var handConfidence: Double { confidences.reduce(0, +) / Double(confidences.count) }

    /// Hand size used to normalize distances: wrist to middle-finger knuckle.
    /// Falls back to the knuckle span when the hand is foreshortened (palm pointing at the camera edge-on).
    public var handSize: Double {
        let palmLength = self[.wrist].distance(to: self[.middleMCP])
        let knuckleSpan = self[.indexMCP].distance(to: self[.littleMCP]) * 1.35
        return max(palmLength, knuckleSpan)
    }

    /// Thumb tip to index tip distance divided by hand size. Small means pinching.
    public var pinchRatio: Double {
        let s = handSize
        guard s > 1e-6 else { return .infinity }
        return self[.thumbTip].distance(to: self[.indexTip]) / s
    }

    /// Midpoint of thumb tip and index tip: where a pinch "is".
    public var pinchPoint: Point2 { (self[.thumbTip] + self[.indexTip]) / 2 }

    /// Palm center: wrist and the four knuckles averaged.
    public var palmCenter: Point2 {
        let js: [HandJoint] = [.wrist, .indexMCP, .middleMCP, .ringMCP, .littleMCP]
        return js.reduce(Point2.zero) { $0 + self[$1] } / Double(js.count)
    }

    /// A finger counts as extended when its tip is clearly farther from the wrist than its middle joint.
    public func isExtended(_ f: Finger, ratio: Double = 1.15) -> Bool {
        let j = f.joints
        let w = self[.wrist]
        return w.distance(to: self[j.tip]) > w.distance(to: self[j.pip]) * ratio
    }
}

/// All hands seen in one camera frame. `t` is seconds (any monotonic clock).
public struct HandFrame: Sendable {
    public var t: TimeInterval
    public var hands: [HandLandmarks]
    public init(t: TimeInterval, hands: [HandLandmarks]) { self.t = t; self.hands = hands }
}
