// Turns a stream of hand landmarks into in-air gestures. Pure logic: no camera, no Vision, fully testable.
//
// Coordinates are landmark space (normalized, origin top-left, y down) already mirrored so "right" is the
// user's right. Time is seconds.
import Foundation

/// Gesture names. Raw values are the snake_case strings used in PROTOCOL `gesture` messages and bindings.
public enum AirGesture: String, CaseIterable, Sendable {
    case airTap = "air_tap"
    case pinchHold = "pinch_hold"
    case pinchDragLeft = "pinch_drag_left"
    case pinchDragRight = "pinch_drag_right"
    case pinchDragUp = "pinch_drag_up"
    case pinchDragDown = "pinch_drag_down"
    case palmSwipeLeft = "palm_swipe_left"
    case palmSwipeRight = "palm_swipe_right"
    case twoHandZoom = "two_hand_zoom"
    case point = "point"

    /// Discrete gestures fire once (bindable like `tap`); continuous ones stream began/changed/ended.
    public var isDiscrete: Bool {
        switch self {
        case .pinchHold, .twoHandZoom, .point: return false
        default: return true
        }
    }
}

public enum GesturePhase: String, Sendable {
    /// A discrete gesture fired.
    case instant
    case began, changed, ended
}

public struct AirGestureEvent: Sendable, Equatable {
    public var t: TimeInterval
    public var gesture: AirGesture
    public var phase: GesturePhase
    public var hand: Chirality
    public var confidence: Double
    /// Pinch point (pinch gestures), pointer position (point, mapped through the interaction box), or palm center.
    public var position: Point2?
    /// Change since the previous event of this gesture (pinch_hold: a value-knob delta).
    public var delta: Point2?
    /// Change since the gesture began.
    public var total: Point2?
    /// two_hand_zoom: current distance between the pinches divided by the starting distance.
    public var scale: Double?

    public init(t: TimeInterval, gesture: AirGesture, phase: GesturePhase, hand: Chirality, confidence: Double,
                position: Point2? = nil, delta: Point2? = nil, total: Point2? = nil, scale: Double? = nil) {
        self.t = t; self.gesture = gesture; self.phase = phase; self.hand = hand; self.confidence = confidence
        self.position = position; self.delta = delta; self.total = total; self.scale = scale
    }

    /// The PROTOCOL message for this event. Discrete gestures become a `gesture` message with zone "air";
    /// continuous phases become the proposed `air` message (see the module README).
    /// `tMillis` is milliseconds since daemon start.
    public func protocolMessage(tMillis: Double) -> [String: Any] {
        var m: [String: Any] = ["t": tMillis, "gesture": gesture.rawValue,
                                "confidence": (confidence * 1000).rounded() / 1000]
        if phase == .instant {
            m["type"] = "gesture"
            m["zone"] = "air"
            m["zones"] = ["air"]
            m["modifiers"] = [String]()
        } else {
            m["type"] = "air"
            m["phase"] = phase.rawValue
        }
        if hand != .unknown { m["hand"] = hand.rawValue }
        if let p = position { m["x"] = p.x; m["y"] = p.y }
        if let d = delta { m["dx"] = d.x; m["dy"] = d.y }
        if let s = scale { m["scale"] = s }
        return m
    }

    /// `protocolMessage` serialized as one JSON text frame (keys sorted).
    public func protocolJSON(tMillis: Double) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: protocolMessage(tMillis: tMillis),
                                                     options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

public struct AirGestureConfig: Sendable {
    // Confidence gating
    /// Mean joint confidence a hand needs to be used at all (activation posture requires > this).
    public var minHandConfidence = 0.6
    /// Confidence each key joint (wrist, thumb tip, index tip, middle knuckle) needs.
    public var minKeyJointConfidence = 0.3
    /// Hands smaller than this (hand size in normalized units) are too far away to trust.
    public var minHandSize = 0.03

    // Activation posture
    /// Consecutive good, steady frames before a new hand may produce gestures.
    public var activationFrames = 2
    /// Max wrist movement per frame, as a fraction of hand size, to count as "steady".
    public var activationMaxMotion = 0.15
    /// A track with no good frame for this long is dropped.
    public var lostTimeout: TimeInterval = 0.3

    // Pinch
    /// Pinch closes below this ratio (thumb-index distance / hand size) and opens above `pinchOff` (hysteresis).
    public var pinchOn = 0.25
    public var pinchOff = 0.40
    /// Wrist to index tip distance (in hand sizes) a pinch needs, so a closed fist is not read as a pinch.
    public var pinchMinIndexReach = 1.1
    /// Consecutive frames needed to change pinch state (debounce).
    public var pinchDebounceFrames = 2
    public var tapMaxDuration: TimeInterval = 0.3
    /// Max pinch-point travel (normalized image units) for air_tap and for a pinch to become a hold.
    public var tapMaxMove = 0.035
    public var holdDelay: TimeInterval = 0.25
    /// Travel that commits a pinch to drag mode (instead of tap / hold).
    public var dragStartDistance = 0.035
    /// Travel along the dominant axis that fires pinch_drag_*.
    public var dragMinDistance = 0.12
    /// Dominant axis must beat the other by this factor.
    public var dragAxisDominance = 1.5
    public var dragMaxDuration: TimeInterval = 1.2
    /// Minimum movement per frame to report a pinch_hold `changed` event.
    public var holdMinDelta = 0.0005

    // Palm swipe
    public var swipeWindow: TimeInterval = 0.45
    public var swipeMinDistance = 0.2
    public var swipeMinSpeed = 0.7
    public var swipeAxisDominance = 2.0
    public var swipeCooldown: TimeInterval = 0.6
    /// An opposite-direction swipe this soon after a swipe is the arm returning, not a gesture.
    public var swipeReturnSuppression: TimeInterval = 0.9
    /// After a swipe, palm speed must drop below this (or the palm must close) before another swipe.
    public var swipeResetSpeed = 0.35

    // Point
    public var pointDebounceFrames = 2
    /// Region of the image mapped to pointer 0..1 (so the user does not have to reach the frame edge).
    public var pointerBoxMin = Point2(0.15, 0.15)
    public var pointerBoxMax = Point2(0.85, 0.85)

    // Zoom
    public var zoomMinBaseline = 0.05

    // General
    /// Minimum time between two discrete gestures from the same hand.
    public var discreteCooldown: TimeInterval = 0.25

    public init() {}
}

public final class AirGestureRecognizer {
    public var config: AirGestureConfig

    private enum PinchMode { case pending, hold, drag, consumed, suppressed }

    private struct Track {
        let id: Int
        var chirality: Chirality
        var hand: HandLandmarks
        var lastSeen: TimeInterval
        var steadyFrames = 0
        var armed = false
        var needsReset = true          // must be seen open (not pinching) before pinch gestures count
        var lastDiscreteT = -Double.infinity

        // pinch
        var pinched = false
        var pinchCandidate = 0          // consecutive frames disagreeing with `pinched`
        var pinchCandidateT: TimeInterval = 0
        var pinchCandidatePoint = Point2.zero
        var pinchStartT: TimeInterval = 0
        var pinchStartPoint = Point2.zero
        var lastPinchPoint = Point2.zero
        var mode: PinchMode = .suppressed

        // swipe
        var palmHistory: [(t: TimeInterval, p: Point2)] = []
        var swipeNeedsReset = false
        var lastSwipeT = -Double.infinity
        var lastSwipeDir = 0
        var lastPalm: (t: TimeInterval, p: Point2)?

        // point
        var pointing = false
        var pointCandidate = 0
        var lastPointer: Point2?
    }

    private var tracks: [Track] = []
    private var nextID = 0
    private var zoom: (a: Int, b: Int, base: Double, last: Double)?

    public init(config: AirGestureConfig = AirGestureConfig()) {
        self.config = config
    }

    /// True while any tracked hand is present (drives the camera's adaptive frame rate).
    public var handPresent: Bool { !tracks.isEmpty }

    public func reset() {
        tracks.removeAll()
        zoom = nil
    }

    /// Feed one frame; returns the gestures it completed or updated, in order.
    public func process(_ frame: HandFrame) -> [AirGestureEvent] {
        var events: [AirGestureEvent] = []
        let t = frame.t
        let good = frame.hands.filter(passesGate)

        // Match good hands to existing tracks by wrist distance (chirality mismatch costs extra).
        var unmatched = Array(good.indices)
        var matched: [Int: HandLandmarks] = [:]   // track index -> hand
        var pairs: [(d: Double, ti: Int, hi: Int)] = []
        for (ti, tr) in tracks.enumerated() {
            for hi in good.indices {
                var d = tr.hand[.wrist].distance(to: good[hi][.wrist])
                if tr.chirality != .unknown, good[hi].chirality != .unknown, tr.chirality != good[hi].chirality {
                    d += 0.2
                }
                if d < 0.3 { pairs.append((d, ti, hi)) }
            }
        }
        var usedT = Set<Int>()
        for p in pairs.sorted(by: { $0.d < $1.d }) where !usedT.contains(p.ti) && unmatched.contains(p.hi) {
            usedT.insert(p.ti)
            unmatched.removeAll { $0 == p.hi }
            matched[p.ti] = good[p.hi]
        }

        for ti in tracks.indices {
            if let h = matched[ti] { update(&tracks[ti], with: h, t: t, events: &events) }
        }
        for hi in unmatched {
            var tr = Track(id: nextID, chirality: good[hi].chirality, hand: good[hi], lastSeen: t)
            nextID += 1
            tr.pinched = good[hi].pinchRatio < config.pinchOff
            tr.steadyFrames = 1
            if tr.steadyFrames >= config.activationFrames { tr.armed = true }
            tracks.append(tr)
        }

        // Drop lost tracks, closing anything they had open.
        var i = 0
        while i < tracks.count {
            if t - tracks[i].lastSeen > config.lostTimeout || t < tracks[i].lastSeen {
                close(tracks[i], t: t, events: &events)
                tracks.remove(at: i)
            } else {
                i += 1
            }
        }

        updateZoom(t: t, events: &events)
        return events
    }

    // MARK: gating

    private func passesGate(_ h: HandLandmarks) -> Bool {
        guard h.handConfidence > config.minHandConfidence else { return false }
        for j in [HandJoint.wrist, .thumbTip, .indexTip, .middleMCP] where h.confidence(j) < config.minKeyJointConfidence {
            return false
        }
        return h.handSize >= config.minHandSize
    }

    // MARK: per-hand update

    private func update(_ tr: inout Track, with h: HandLandmarks, t: TimeInterval, events: inout [AirGestureEvent]) {
        let prev = tr.hand
        tr.hand = h
        tr.lastSeen = t
        if tr.chirality == .unknown { tr.chirality = h.chirality }
        let size = h.handSize

        // Activation posture: steady for N frames.
        if !tr.armed {
            let motion = prev[.wrist].distance(to: h[.wrist]) / max(size, 1e-6)
            tr.steadyFrames = motion <= config.activationMaxMotion ? tr.steadyFrames + 1 : 1
            if tr.steadyFrames >= config.activationFrames { tr.armed = true }
        }

        let ratio = h.pinchRatio
        let conf = h.handConfidence
        updatePinch(&tr, ratio: ratio, t: t, conf: conf, events: &events)
        if tr.armed, !tr.pinched, ratio > config.pinchOff { tr.needsReset = false }
        updateSwipe(&tr, ratio: ratio, t: t, conf: conf, events: &events)
        updatePoint(&tr, ratio: ratio, t: t, conf: conf, events: &events)
    }

    private func updatePinch(_ tr: inout Track, ratio: Double, t: TimeInterval, conf: Double,
                             events: inout [AirGestureEvent]) {
        let p = tr.hand.pinchPoint
        // A fist also brings thumb and index tips together; a real pinch keeps the index tip out, away from the palm.
        let reach = tr.hand[.wrist].distance(to: tr.hand[.indexTip]) / max(tr.hand.handSize, 1e-6)
        let rawWants: Bool = tr.pinched ? !(ratio > config.pinchOff)
                                        : (ratio < config.pinchOn && reach >= config.pinchMinIndexReach)
        if rawWants != tr.pinched {
            if tr.pinchCandidate == 0 { tr.pinchCandidateT = t; tr.pinchCandidatePoint = p }
            tr.pinchCandidate += 1
        } else {
            tr.pinchCandidate = 0
        }
        let flips = tr.pinchCandidate >= config.pinchDebounceFrames

        if flips && !tr.pinched {
            tr.pinched = true
            tr.pinchCandidate = 0
            tr.pinchStartT = tr.pinchCandidateT
            tr.pinchStartPoint = tr.pinchCandidatePoint
            tr.lastPinchPoint = p
            let inZoom = zoom.map { $0.a == tr.id || $0.b == tr.id } ?? false
            tr.mode = (tr.armed && !tr.needsReset && !inZoom) ? .pending : .suppressed
        } else if flips && tr.pinched {
            tr.pinched = false
            tr.pinchCandidate = 0
            let releaseT = tr.pinchCandidateT
            switch tr.mode {
            case .pending:
                let move = tr.pinchStartPoint.distance(to: tr.pinchCandidatePoint)
                if releaseT - tr.pinchStartT <= config.tapMaxDuration, move <= config.tapMaxMove,
                   t - tr.lastDiscreteT >= config.discreteCooldown {
                    tr.lastDiscreteT = t
                    events.append(AirGestureEvent(t: t, gesture: .airTap, phase: .instant, hand: tr.chirality,
                                                  confidence: conf, position: tr.pinchStartPoint))
                }
            case .hold:
                events.append(AirGestureEvent(t: t, gesture: .pinchHold, phase: .ended, hand: tr.chirality,
                                              confidence: conf, position: tr.lastPinchPoint, delta: .zero,
                                              total: tr.lastPinchPoint - tr.pinchStartPoint))
            default: break
            }
            tr.mode = .suppressed
        } else if tr.pinched && tr.pinchCandidate == 0 {
            // (Frames that already look released are skipped: the hand shape change would read as motion.)
            let disp = p - tr.pinchStartPoint
            switch tr.mode {
            case .pending:
                if disp.length > config.dragStartDistance {
                    tr.mode = .drag
                    fireDragIfReady(&tr, disp: disp, t: t, conf: conf, events: &events)
                } else if t - tr.pinchStartT >= config.holdDelay {
                    tr.mode = .hold
                    events.append(AirGestureEvent(t: t, gesture: .pinchHold, phase: .began, hand: tr.chirality,
                                                  confidence: conf, position: p, delta: .zero, total: disp))
                }
            case .drag:
                fireDragIfReady(&tr, disp: disp, t: t, conf: conf, events: &events)
            case .hold:
                let d = p - tr.lastPinchPoint
                if d.length >= config.holdMinDelta {
                    events.append(AirGestureEvent(t: t, gesture: .pinchHold, phase: .changed, hand: tr.chirality,
                                                  confidence: conf, position: p, delta: d, total: disp))
                } else {
                    return   // keep lastPinchPoint so small moves accumulate into the next delta
                }
            case .consumed, .suppressed:
                break
            }
            tr.lastPinchPoint = p
        }
    }

    private func fireDragIfReady(_ tr: inout Track, disp: Point2, t: TimeInterval, conf: Double,
                                 events: inout [AirGestureEvent]) {
        if t - tr.pinchStartT > config.dragMaxDuration { tr.mode = .consumed; return }
        let ax = abs(disp.x), ay = abs(disp.y)
        let major = max(ax, ay), minor = min(ax, ay)
        guard major >= config.dragMinDistance, major >= minor * config.dragAxisDominance else { return }
        tr.mode = .consumed   // one drag per pinch; releasing is the reset
        guard t - tr.lastDiscreteT >= config.discreteCooldown else { return }
        tr.lastDiscreteT = t
        let g: AirGesture = ax >= ay ? (disp.x > 0 ? .pinchDragRight : .pinchDragLeft)
                                     : (disp.y > 0 ? .pinchDragDown : .pinchDragUp)
        events.append(AirGestureEvent(t: t, gesture: g, phase: .instant, hand: tr.chirality, confidence: conf,
                                      position: tr.hand.pinchPoint, total: disp))
    }

    private func isOpenPalm(_ h: HandLandmarks, ratio: Double) -> Bool {
        ratio > config.pinchOff && Finger.allCases.allSatisfy { h.isExtended($0) }
    }

    private func updateSwipe(_ tr: inout Track, ratio: Double, t: TimeInterval, conf: Double,
                             events: inout [AirGestureEvent]) {
        let open = isOpenPalm(tr.hand, ratio: ratio)
        let c = tr.hand.palmCenter
        defer { tr.lastPalm = (t, c) }
        guard tr.armed, open else {
            tr.palmHistory.removeAll()
            tr.swipeNeedsReset = false
            return
        }
        if tr.swipeNeedsReset {
            if let lp = tr.lastPalm, t > lp.t, c.distance(to: lp.p) / (t - lp.t) < config.swipeResetSpeed {
                tr.swipeNeedsReset = false
            } else {
                return
            }
        }
        tr.palmHistory.append((t, c))
        tr.palmHistory.removeAll { t - $0.t > config.swipeWindow }
        guard let first = tr.palmHistory.first, t > first.t else { return }
        let d = c - first.p
        let dt = t - first.t
        guard abs(d.x) >= config.swipeMinDistance, abs(d.x) >= abs(d.y) * config.swipeAxisDominance,
              abs(d.x) / dt >= config.swipeMinSpeed else { return }
        let dir = d.x > 0 ? 1 : -1
        tr.palmHistory.removeAll()
        tr.swipeNeedsReset = true
        if dir == -tr.lastSwipeDir, t - tr.lastSwipeT < config.swipeReturnSuppression {
            // The arm coming back after a swipe. Swallow it; the next real swipe needs a fresh reset.
            tr.lastSwipeT = t
            return
        }
        guard t - tr.lastSwipeT >= config.swipeCooldown, t - tr.lastDiscreteT >= config.discreteCooldown else { return }
        tr.lastSwipeT = t
        tr.lastSwipeDir = dir
        tr.lastDiscreteT = t
        events.append(AirGestureEvent(t: t, gesture: dir > 0 ? .palmSwipeRight : .palmSwipeLeft, phase: .instant,
                                      hand: tr.chirality, confidence: conf, position: c, total: d))
    }

    private func pointer(for tip: Point2) -> Point2 {
        let lo = config.pointerBoxMin, hi = config.pointerBoxMax
        func m(_ v: Double, _ a: Double, _ b: Double) -> Double { min(1, max(0, (v - a) / max(b - a, 1e-6))) }
        return Point2(m(tip.x, lo.x, hi.x), m(tip.y, lo.y, hi.y))
    }

    private func updatePoint(_ tr: inout Track, ratio: Double, t: TimeInterval, conf: Double,
                             events: inout [AirGestureEvent]) {
        let h = tr.hand
        let posture = tr.armed && !tr.pinched && ratio > config.pinchOff && h.isExtended(.index)
            && !h.isExtended(.middle) && !h.isExtended(.ring) && !h.isExtended(.little)
        if posture != tr.pointing {
            tr.pointCandidate += 1
            if tr.pointCandidate >= config.pointDebounceFrames {
                tr.pointCandidate = 0
                tr.pointing = posture
                let pos = pointer(for: h[.indexTip])
                if posture {
                    tr.lastPointer = pos
                    events.append(AirGestureEvent(t: t, gesture: .point, phase: .began, hand: tr.chirality,
                                                  confidence: conf, position: pos, delta: .zero))
                } else {
                    events.append(AirGestureEvent(t: t, gesture: .point, phase: .ended, hand: tr.chirality,
                                                  confidence: conf, position: tr.lastPointer))
                    tr.lastPointer = nil
                }
            }
        } else {
            tr.pointCandidate = 0
            if tr.pointing {
                let pos = pointer(for: h[.indexTip])
                let d = pos - (tr.lastPointer ?? pos)
                if d.length > 0.001 {
                    tr.lastPointer = pos
                    events.append(AirGestureEvent(t: t, gesture: .point, phase: .changed, hand: tr.chirality,
                                                  confidence: conf, position: pos, delta: d))
                }
            }
        }
    }

    private func close(_ tr: Track, t: TimeInterval, events: inout [AirGestureEvent]) {
        if tr.pinched, tr.mode == .hold {
            events.append(AirGestureEvent(t: t, gesture: .pinchHold, phase: .ended, hand: tr.chirality,
                                          confidence: tr.hand.handConfidence, position: tr.lastPinchPoint,
                                          delta: .zero, total: tr.lastPinchPoint - tr.pinchStartPoint))
        }
        if tr.pointing {
            events.append(AirGestureEvent(t: t, gesture: .point, phase: .ended, hand: tr.chirality,
                                          confidence: tr.hand.handConfidence, position: tr.lastPointer))
        }
    }

    // MARK: two-hand zoom

    private func updateZoom(t: TimeInterval, events: inout [AirGestureEvent]) {
        if let z = zoom {
            guard let a = tracks.firstIndex(where: { $0.id == z.a }), let b = tracks.firstIndex(where: { $0.id == z.b }),
                  tracks[a].pinched, tracks[b].pinched else {
                events.append(AirGestureEvent(t: t, gesture: .twoHandZoom, phase: .ended, hand: .unknown,
                                              confidence: 1, scale: z.last))
                zoom = nil
                return
            }
            let d = tracks[a].hand.pinchPoint.distance(to: tracks[b].hand.pinchPoint)
            let s = d / z.base
            let conf = min(tracks[a].hand.handConfidence, tracks[b].hand.handConfidence)
            if abs(s - z.last) > 0.002 {
                zoom?.last = s
                events.append(AirGestureEvent(t: t, gesture: .twoHandZoom, phase: .changed, hand: .unknown,
                                              confidence: conf, position: midpoint(a, b), scale: s))
            }
            return
        }
        // Start when two armed hands are both pinching with an eligible pinch.
        let ready = tracks.indices.filter {
            tracks[$0].armed && tracks[$0].pinched && (tracks[$0].mode == .pending || tracks[$0].mode == .hold)
        }
        guard ready.count >= 2 else { return }
        let a = ready[0], b = ready[1]
        let d = tracks[a].hand.pinchPoint.distance(to: tracks[b].hand.pinchPoint)
        guard d >= config.zoomMinBaseline else { return }
        for i in [a, b] {
            if tracks[i].mode == .hold {
                events.append(AirGestureEvent(t: t, gesture: .pinchHold, phase: .ended, hand: tracks[i].chirality,
                                              confidence: tracks[i].hand.handConfidence,
                                              position: tracks[i].lastPinchPoint, delta: .zero,
                                              total: tracks[i].lastPinchPoint - tracks[i].pinchStartPoint))
            }
            tracks[i].mode = .suppressed   // no taps, holds or drags out of a zoom pinch
        }
        zoom = (tracks[a].id, tracks[b].id, d, 1)
        let conf = min(tracks[a].hand.handConfidence, tracks[b].hand.handConfidence)
        events.append(AirGestureEvent(t: t, gesture: .twoHandZoom, phase: .began, hand: .unknown, confidence: conf,
                                      position: midpoint(a, b), scale: 1))
    }

    private func midpoint(_ a: Int, _ b: Int) -> Point2 {
        (tracks[a].hand.pinchPoint + tracks[b].hand.pinchPoint) / 2
    }
}
