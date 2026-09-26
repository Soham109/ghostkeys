// EXPERIMENTAL: map Desk View fingertips onto the laptop deck (the palm-rest surface), decide touch vs hover,
// and turn circling fingers into a rotary knob.
import Foundation

// MARK: - Homography

/// A 3x3 projective transform (row-major), mapping (x, y) to ((h0 x + h1 y + h2) / w, (h3 x + h4 y + h5) / w)
/// with w = h6 x + h7 y + h8.
public struct Homography: Equatable, Sendable {
    public var m: [Double]

    public init(_ m: [Double]) {
        precondition(m.count == 9)
        self.m = m
    }

    public static let identity = Homography([1, 0, 0, 0, 1, 0, 0, 0, 1])

    /// nil when the point maps to infinity (it is on the camera's horizon line).
    public func apply(_ p: Point2) -> Point2? {
        let w = m[6] * p.x + m[7] * p.y + m[8]
        guard abs(w) > 1e-12 else { return nil }
        return Point2((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w)
    }

    public var inverse: Homography? {
        let a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8]
        let A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
        let det = a * A + b * B + c * C
        guard abs(det) > 1e-15 else { return nil }
        let r0: [Double] = [A, c * h - b * i, b * f - c * e]
        let r1: [Double] = [B, a * i - c * g, c * d - a * f]
        let r2: [Double] = [C, b * g - a * h, a * e - b * d]
        let inv = (r0 + r1 + r2).map { $0 / det }
        return Homography(inv)
    }

    public static func * (l: Homography, r: Homography) -> Homography {
        var out = [Double](repeating: 0, count: 9)
        for row in 0..<3 { for col in 0..<3 {
            var sum = 0.0
            for k in 0..<3 { sum += l.m[row * 3 + k] * r.m[k * 3 + col] }
            out[row * 3 + col] = sum
        } }
        return Homography(out)
    }

    /// The exact homography taking 4 source points to 4 destination points (no three collinear).
    /// This is also the calibration path: the user touches the four deck corners and we fit from those.
    public static func fit(from src: [Point2], to dst: [Point2]) -> Homography? {
        guard src.count == 4, dst.count == 4 else { return nil }
        // Normalize both sides (Hartley) for numerical stability.
        guard let ts = normalizer(src), let td = normalizer(dst), let tdInv = td.inverse else { return nil }
        let s = src.compactMap { ts.apply($0) }, d = dst.compactMap { td.apply($0) }
        var a = [[Double]]()
        var bvec = [Double]()
        for k in 0..<4 {
            let (x, y, u, v) = (s[k].x, s[k].y, d[k].x, d[k].y)
            a.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); bvec.append(u)
            a.append([0, 0, 0, x, y, 1, -v * x, -v * y]); bvec.append(v)
        }
        guard let h = solve(a, bvec) else { return nil }
        let hn = Homography(h + [1])
        return tdInv * hn * ts
    }

    private static func normalizer(_ pts: [Point2]) -> Homography? {
        let c = pts.reduce(Point2.zero, +) / Double(pts.count)
        let meanD = pts.reduce(0) { $0 + $1.distance(to: c) } / Double(pts.count)
        guard meanD > 1e-12 else { return nil }
        let s = 2.0.squareRoot() / meanD
        return Homography([s, 0, -s * c.x, 0, s, -s * c.y, 0, 0, 1])
    }

    /// Gaussian elimination with partial pivoting.
    static func solve(_ a: [[Double]], _ b: [Double]) -> [Double]? {
        let n = b.count
        var m = a
        var v = b
        for col in 0..<n {
            var piv = col
            for r in col + 1..<n where abs(m[r][col]) > abs(m[piv][col]) { piv = r }
            guard abs(m[piv][col]) > 1e-12 else { return nil }
            m.swapAt(col, piv); v.swapAt(col, piv)
            for r in col + 1..<n {
                let f = m[r][col] / m[col][col]
                if f == 0 { continue }
                for k in col..<n { m[r][k] -= f * m[col][k] }
                v[r] -= f * v[col]
            }
        }
        var x = [Double](repeating: 0, count: n)
        for r in stride(from: n - 1, through: 0, by: -1) {
            var s = v[r]
            for k in r + 1..<n { s -= m[r][k] * x[k] }
            x[r] = s / m[r][r]
        }
        return x
    }
}

// MARK: - Laptop geometry

public enum LaptopFamily: String, CaseIterable, Sendable {
    case macbookPro14 = "macbook-pro-14"
    case macbookPro16 = "macbook-pro-16"
    case macbookAir13 = "macbook-air-13"
    case macbookAir15 = "macbook-air-15"

    /// Published outer dimensions (mm) plus an estimate of the hinge-to-camera distance along the lid.
    public var dimensions: LaptopDimensions {
        switch self {
        case .macbookPro14: return LaptopDimensions(width: 312.6, depth: 221.2, lidCameraDistance: 212)
        case .macbookPro16: return LaptopDimensions(width: 355.7, depth: 248.1, lidCameraDistance: 239)
        case .macbookAir13: return LaptopDimensions(width: 304.1, depth: 215.0, lidCameraDistance: 207)
        case .macbookAir15: return LaptopDimensions(width: 340.4, depth: 237.6, lidCameraDistance: 229)
        }
    }
}

public struct LaptopDimensions: Equatable, Sendable {
    /// Base width, left to right (mm).
    public var width: Double
    /// Base depth, hinge to front lip (mm).
    public var depth: Double
    /// Distance from the hinge axis to the camera, measured along the lid (mm).
    public var lidCameraDistance: Double
    public init(width: Double, depth: Double, lidCameraDistance: Double) {
        self.width = width; self.depth = depth; self.lidCameraDistance = lidCameraDistance
    }
}

/// Model of the Desk View image as a virtual pinhole camera at the lid camera's position, looking down
/// and tilted toward the user, with the user's side at the bottom of the image. Apple does not publish the
/// real warp, so the defaults are a prior to refine with the 4-corner calibration (`Homography.fit`).
public struct DeskViewCameraModel: Equatable, Sendable {
    /// Horizontal field of view of the Desk View image.
    public var horizontalFOVDegrees: Double = 90
    /// Image width / height (Desk View delivers 1920x1440, so 4:3).
    public var aspect: Double = 4.0 / 3.0
    /// Tilt of the view direction from straight down toward the user.
    public var tiltTowardUserDegrees: Double = 25
    public init() {}
}

// MARK: - Deck zones

/// A rectangle in deck coordinates (same shape as PROTOCOL zone rects). Only base-surface zones make sense here.
public struct DeckZone: Equatable, Sendable {
    public var id: String
    public var x: Double, y: Double, w: Double, h: Double
    public init(id: String, x: Double, y: Double, w: Double, h: Double) {
        self.id = id; self.x = x; self.y = y; self.w = w; self.h = h
    }
    public func contains(_ p: Point2) -> Bool { p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h }
}

// MARK: - Mapper

public struct DeskSurfaceMapper: Sendable {
    /// Desk View image (normalized, origin top-left) to deck (PROTOCOL x, y).
    public let imageToDeck: Homography
    /// Deck to Desk View image.
    public let deckToImage: Homography

    /// Build from a known (for example, calibrated) image-to-deck homography.
    public init?(imageToDeck: Homography) {
        guard let inv = imageToDeck.inverse else { return nil }
        self.imageToDeck = imageToDeck
        self.deckToImage = inv
    }

    /// Build from the geometric model: lid angle in degrees (0 closed, 90 upright, typically 100 to 130).
    public init?(lidAngleDegrees: Double, family: LaptopFamily, camera: DeskViewCameraModel = DeskViewCameraModel()) {
        self.init(lidAngleDegrees: lidAngleDegrees, dimensions: family.dimensions, camera: camera)
    }

    public init?(lidAngleDegrees: Double, dimensions: LaptopDimensions, camera: DeskViewCameraModel = DeskViewCameraModel()) {
        let corners = [Point2(0, 0), Point2(1, 0), Point2(1, 1), Point2(0, 1)]
        var img: [Point2] = []
        for c in corners {
            guard let p = DeskSurfaceMapper.project(deck: c, lidAngleDegrees: lidAngleDegrees,
                                                     dimensions: dimensions, camera: camera) else { return nil }
            img.append(p)
        }
        guard let h = Homography.fit(from: corners, to: img), let hi = h.inverse else { return nil }
        self.deckToImage = h
        self.imageToDeck = hi
    }

    /// Calibrate from where the four deck corners appear in the Desk View image
    /// (order: hinge-left, hinge-right, front-right, front-left).
    public init?(imageCorners: [Point2]) {
        let corners = [Point2(0, 0), Point2(1, 0), Point2(1, 1), Point2(0, 1)]
        guard let h = Homography.fit(from: imageCorners, to: corners) else { return nil }
        self.init(imageToDeck: h)
    }

    public func deckPoint(fromImage p: Point2) -> Point2? { imageToDeck.apply(p) }
    public func imagePoint(fromDeck p: Point2) -> Point2? { deckToImage.apply(p) }

    /// Fingertips (index, middle, ring, little, thumb) of a Desk View hand mapped to the deck.
    public func fingertips(of hand: HandLandmarks, minConfidence: Double = 0.3) -> [(joint: HandJoint, deck: Point2)] {
        [HandJoint.indexTip, .middleTip, .ringTip, .littleTip, .thumbTip].compactMap { j in
            guard hand.confidence(j) >= minConfidence, let d = deckPoint(fromImage: hand[j]) else { return nil }
            return (j, d)
        }
    }

    /// Fraction (0..1) of the deck that lands inside the Desk View image, sampled on a grid.
    /// Near 0 means Desk View cannot see the palm rests at this lid angle.
    public func visibleDeckFraction(samples: Int = 20) -> Double {
        var inside = 0
        for i in 0..<samples { for j in 0..<samples {
            let d = Point2((Double(i) + 0.5) / Double(samples), (Double(j) + 0.5) / Double(samples))
            if let p = imagePoint(fromDeck: d), (0...1).contains(p.x), (0...1).contains(p.y) { inside += 1 }
        } }
        return Double(inside) / Double(samples * samples)
    }

    /// Pinhole projection of a deck point (PROTOCOL coordinates) into the Desk View image model.
    /// World frame (mm): X to the user's right from the base's left edge, Y from the hinge toward the user,
    /// Z up from the deck surface.
    public static func project(deck p: Point2, lidAngleDegrees: Double, dimensions: LaptopDimensions,
                               camera: DeskViewCameraModel) -> Point2? {
        let th = lidAngleDegrees * .pi / 180
        let L = dimensions.lidCameraDistance
        let cam = (x: dimensions.width / 2, y: L * cos(th), z: L * sin(th))
        let a = camera.tiltTowardUserDegrees * .pi / 180
        let fwd = (x: 0.0, y: sin(a), z: -cos(a))   // view direction
        let right = (x: 1.0, y: 0.0, z: 0.0)         // image +x
        let down = (x: 0.0, y: cos(a), z: sin(a))    // image +y (toward the user)
        let v = (x: p.x * dimensions.width - cam.x, y: p.y * dimensions.depth - cam.y, z: -cam.z)
        let zc = v.x * fwd.x + v.y * fwd.y + v.z * fwd.z
        guard zc > 1e-6 else { return nil }   // behind the camera
        let fx = 0.5 / tan(camera.horizontalFOVDegrees * .pi / 360)
        let fy = fx * camera.aspect
        let u = 0.5 + fx * (v.x * right.x + v.y * right.y + v.z * right.z) / zc
        let w = 0.5 + fy * (v.x * down.x + v.y * down.y + v.z * down.z) / zc
        return Point2(u, w)
    }
}

// MARK: - Touch vs hover

public enum ContactConfirmation: Sendable {
    case confirmed, rejected, unknown
}

public struct DeskTouchEvent: Sendable, Equatable {
    public enum Phase: String, Sendable { case began, ended }
    public var t: TimeInterval
    public var phase: Phase
    public var zone: String
    public var position: Point2
    /// Lower when no motion-sensor confirmation was available.
    public var confidence: Double
}

/// A camera from above cannot see height, so "touch" is inferred: the fingertip stops (speed near zero)
/// inside a deck zone for a short dwell. If the daemon passes a contact confirmer (for example, "did the motion
/// sensor feel a tap within the last 150 ms?"), a rejected confirmation turns the candidate into a hover.
public final class DeskTouchDetector {
    public var zones: [DeckZone]
    /// Max fingertip speed (deck units per second) to count as stopped.
    public var maxStillSpeed = 0.08
    /// How long the fingertip must stay stopped.
    public var dwell: TimeInterval = 0.12
    /// Speed that ends a touch (hysteresis over maxStillSpeed).
    public var releaseSpeed = 0.25
    public var contactConfirmer: ((_ zone: String, _ t: TimeInterval) -> ContactConfirmation)?

    private var last: (t: TimeInterval, p: Point2)?
    private var stillSince: TimeInterval?
    private var touching: (zone: String, p: Point2)?
    private var rejectedUntilMove = false

    public init(zones: [DeckZone], contactConfirmer: ((String, TimeInterval) -> ContactConfirmation)? = nil) {
        self.zones = zones
        self.contactConfirmer = contactConfirmer
    }

    public var isTouching: Bool { touching != nil }

    /// Feed one fingertip position in deck coordinates, or nil when the fingertip is not visible.
    public func process(_ p: Point2?, t: TimeInterval) -> [DeskTouchEvent] {
        guard let p = p else {
            defer { reset() }
            if let tc = touching {
                return [DeskTouchEvent(t: t, phase: .ended, zone: tc.zone, position: tc.p, confidence: 1)]
            }
            return []
        }
        var events: [DeskTouchEvent] = []
        let speed: Double
        if let l = last, t > l.t { speed = p.distance(to: l.p) / (t - l.t) } else { speed = .infinity }
        last = (t, p)

        if let tc = touching {
            let zoneStill = zones.first { $0.id == tc.zone }?.contains(p) ?? false
            if speed > releaseSpeed || !zoneStill {
                events.append(DeskTouchEvent(t: t, phase: .ended, zone: tc.zone, position: p, confidence: 1))
                touching = nil
                stillSince = nil
            }
            return events
        }
        if speed > maxStillSpeed {
            stillSince = nil
            rejectedUntilMove = false
            return events
        }
        if rejectedUntilMove { return events }
        if stillSince == nil { stillSince = t }
        guard let s = stillSince, t - s >= dwell, let zone = zones.first(where: { $0.contains(p) }) else { return events }
        var conf = 0.6
        switch contactConfirmer?(zone.id, t) ?? .unknown {
        case .confirmed: conf = 0.95
        case .rejected:
            rejectedUntilMove = true   // a hovering finger: do not ask again until it moves
            return events
        case .unknown: break
        }
        touching = (zone.id, p)
        events.append(DeskTouchEvent(t: t, phase: .began, zone: zone.id, position: p, confidence: conf))
        return events
    }

    public func reset() {
        last = nil
        stillSince = nil
        touching = nil
        rejectedUntilMove = false
    }
}

// MARK: - Circle knob

public enum RotationDirection: String, Sendable {
    /// Clockwise as seen by the user (y grows toward the user / down the image).
    case clockwise = "cw"
    case counterClockwise = "ccw"

    /// Proposed PROTOCOL gesture names for one knob step.
    public var gestureName: String { self == .clockwise ? "circle_cw" : "circle_ccw" }
}

public struct KnobStep: Sendable, Equatable {
    public var t: TimeInterval
    public var direction: RotationDirection
    /// Signed step count since the knob started turning (+ clockwise).
    public var index: Int
}

/// Accumulates the signed turning angle of a moving point (fingertip in deck or image coordinates, or an air
/// pointer) and emits one step every `stepDegrees` of rotation. Works in any y-down 2D coordinate system.
public final class CircleKnob {
    public var stepDegrees = 30.0
    /// Ignore movement shorter than this between samples (kills jitter). Units of the input coordinates.
    public var minSegment = 0.01
    /// A single turn larger than this is a glitch, not a circle.
    public var maxTurnPerSegmentDegrees = 100.0
    /// Turning back against the current direction by this much restarts the count (backlash).
    public var reverseResetDegrees = 45.0
    /// Pausing this long restarts the count.
    public var idleReset: TimeInterval = 0.6
    /// Rotation needed before the first step (a little more than one step, so wobble does not engage the knob).
    public var engageDegrees = 45.0
    /// Of the recent turns, at least this share must bend the same way as the rotation. A circle bends
    /// consistently; a noisy straight line alternates left and right.
    public var minTurnAgreement = 0.75
    public var agreementWindow = 6

    private var anchor: Point2?
    private var lastHeading: Double?
    private var lastMoveT: TimeInterval = 0
    private var accumulated = 0.0       // degrees since the last emitted step, signed
    private var reverseAccum = 0.0
    private var stepIndex = 0
    private var direction = 0           // +1 cw, -1 ccw, 0 unknown
    private var engaged = false
    private var recentSigns: [Int] = []

    public init() {}

    /// Total signed steps since the last reset (+ clockwise).
    public var steps: Int { stepIndex }

    public func reset() {
        anchor = nil
        lastHeading = nil
        accumulated = 0
        reverseAccum = 0
        stepIndex = 0
        direction = 0
        engaged = false
        recentSigns.removeAll()
    }

    public func process(_ p: Point2, t: TimeInterval) -> [KnobStep] {
        guard let a = anchor else { anchor = p; lastMoveT = t; return [] }
        if t - lastMoveT > idleReset {
            lastHeading = nil
            accumulated = 0
            reverseAccum = 0
            direction = 0
            engaged = false
            recentSigns.removeAll()
        }
        let seg = p - a
        guard seg.length >= minSegment else { return [] }
        anchor = p
        lastMoveT = t
        let heading = atan2(seg.y, seg.x) * 180 / .pi
        defer { lastHeading = heading }
        guard let lh = lastHeading else { return [] }
        var turn = heading - lh
        while turn > 180 { turn -= 360 }
        while turn < -180 { turn += 360 }
        // In y-down coordinates a positive heading change is clockwise as the user sees it.
        guard abs(turn) <= maxTurnPerSegmentDegrees else {
            accumulated = 0; direction = 0; engaged = false; recentSigns.removeAll(); return []
        }

        let sign = turn > 0.5 ? 1 : (turn < -0.5 ? -1 : 0)
        recentSigns.append(sign)
        if recentSigns.count > agreementWindow { recentSigns.removeFirst() }
        if direction != 0, sign == -direction {
            reverseAccum += abs(turn)
            if reverseAccum >= reverseResetDegrees {
                direction = sign
                accumulated = turn
                reverseAccum = 0
            } else {
                accumulated += turn
            }
        } else {
            if direction == 0 && sign != 0 { direction = sign }
            reverseAccum = max(0, reverseAccum - abs(turn))
            accumulated += turn
        }

        var out: [KnobStep] = []
        let eps = 1e-9
        let rotSign = accumulated > 0 ? 1 : -1
        let agree = Double(recentSigns.filter { $0 == rotSign }.count) / Double(max(recentSigns.count, 1))
        guard recentSigns.count >= 3, agree >= minTurnAgreement else { return out }
        if !engaged {
            guard abs(accumulated) >= engageDegrees - eps else { return out }
            engaged = true
        }
        while abs(accumulated) >= stepDegrees - eps {
            let s = accumulated > 0 ? 1 : -1
            accumulated -= Double(s) * stepDegrees
            stepIndex += s
            out.append(KnobStep(t: t, direction: s > 0 ? .clockwise : .counterClockwise, index: stepIndex))
        }
        return out
    }
}
