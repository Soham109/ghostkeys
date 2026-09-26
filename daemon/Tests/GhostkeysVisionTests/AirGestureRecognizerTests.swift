import Darwin
import Testing
@testable import GhostkeysVision

@Suite struct AirGestureTests {
    let open = makeHand(.open)
    let pinch = makeHand(.pinch)

    // MARK: each gesture

    @Test func airTap() {
        var tl = Timeline()
        tl.add(6, open); tl.add(5, pinch); tl.add(6, open)
        let ev = run(tl.frames)
        #expect(discrete(ev) == [.airTap])
        #expect(!ev.contains { $0.gesture == .pinchHold })
        let tap = ev.first { $0.gesture == .airTap }!
        #expect(tap.confidence > 0.6)
        #expect(tap.hand == .right)
    }

    @Test func pinchHoldStillThenRelease() {
        var tl = Timeline()
        tl.add(6, open); tl.add(15, pinch); tl.add(6, open)
        let ev = run(tl.frames)
        #expect(discrete(ev).isEmpty, "a long pinch is not a tap")
        let holds = ev.filter { $0.gesture == .pinchHold }.map(\.phase)
        #expect(holds.first == .began)
        #expect(holds.last == .ended)
        #expect(holds.filter { $0 == .began }.count == 1)
    }

    @Test func pinchHoldStreamsDeltasAsAKnob() {
        var tl = Timeline()
        tl.add(6, open)
        tl.add(10, pinch)   // still: becomes a hold at 250 ms
        tl.add(20) { i in [makeHand(.pinch, wrist: Point2(0.5, 0.7 - Double(i + 1) * 0.004))] }  // slide up 0.08
        tl.add(6, makeHand(.open, wrist: Point2(0.5, 0.62)))
        let ev = run(tl.frames)
        let changed = ev.filter { $0.gesture == .pinchHold && $0.phase == .changed }
        #expect(changed.count >= 15)
        let sumDy = changed.reduce(0) { $0 + $1.delta!.y }
        #expect(abs(sumDy - -0.08) < 1e-6, "deltas add up to the travel: \(sumDy)")
        #expect(discrete(ev).isEmpty, "moving inside a hold is not a drag")
    }

    @Test func pinchDragAllDirections() {
        func drag(_ step: Point2) -> [AirGesture] {
            var tl = Timeline()
            let start = Point2(0.5, 0.6)
            tl.add(6, makeHand(.open, wrist: start))
            tl.add(3, makeHand(.pinch, wrist: start))
            tl.add(10) { i in [makeHand(.pinch, wrist: start + step * Double(i + 1))] }
            tl.add(6, makeHand(.open, wrist: start + step * 10))
            return discrete(run(tl.frames))
        }
        #expect(drag(Point2(0.02, 0)) == [.pinchDragRight])
        #expect(drag(Point2(-0.02, 0)) == [.pinchDragLeft])
        #expect(drag(Point2(0, -0.02)) == [.pinchDragUp])
        #expect(drag(Point2(0, 0.02)) == [.pinchDragDown])
        // Diagonal: no dominant axis, so nothing fires.
        #expect(drag(Point2(0.015, 0.015)) == [])
    }

    @Test func palmSwipeWithReturnStrokeSuppressed() {
        var tl = Timeline()
        var x = 0.3
        tl.add(6) { _ in [makeHand(.open, wrist: Point2(x, 0.6))] }
        tl.add(8) { _ in x += 0.04; return [makeHand(.open, wrist: Point2(x, 0.6))] }   // swipe right
        tl.add(3) { _ in [makeHand(.open, wrist: Point2(x, 0.6))] }
        tl.add(8) { _ in x -= 0.04; return [makeHand(.open, wrist: Point2(x, 0.6))] }   // arm comes back
        tl.add(30) { _ in [makeHand(.open, wrist: Point2(x, 0.6))] }                    // rest 1 s
        tl.add(8) { _ in x -= 0.04; return [makeHand(.open, wrist: Point2(x, 0.6))] }   // real swipe left
        let ev = run(tl.frames)
        #expect(discrete(ev) == [.palmSwipeRight, .palmSwipeLeft])
    }

    @Test func slowPalmMoveIsNotASwipe() {
        var tl = Timeline()
        var x = 0.3
        tl.add(6) { _ in [makeHand(.open, wrist: Point2(x, 0.6))] }
        tl.add(40) { _ in x += 0.01; return [makeHand(.open, wrist: Point2(x, 0.6))] }   // 0.3/s
        #expect(discrete(run(tl.frames)).isEmpty)
    }

    @Test func twoHandZoom() {
        var tl = Timeline()
        let l0 = Point2(0.35, 0.7), r0 = Point2(0.65, 0.7)
        tl.add(5) { _ in [makeHand(.open, wrist: l0, chirality: .left), makeHand(.open, wrist: r0)] }
        tl.add(4) { _ in [makeHand(.pinch, wrist: l0, chirality: .left), makeHand(.pinch, wrist: r0)] }
        tl.add(10) { i in
            let d = Double(i + 1) * 0.01
            return [makeHand(.pinch, wrist: l0 - Point2(d, 0), chirality: .left), makeHand(.pinch, wrist: r0 + Point2(d, 0))]
        }
        tl.add(5) { _ in [makeHand(.open, wrist: l0 - Point2(0.1, 0), chirality: .left),
                          makeHand(.open, wrist: r0 + Point2(0.1, 0))] }
        let ev = run(tl.frames)
        let zoom = ev.filter { $0.gesture == .twoHandZoom }
        #expect(zoom.first?.phase == .began)
        #expect(zoom.last?.phase == .ended)
        let final = zoom.last!.scale!
        #expect(abs(final - 0.5 / 0.3) < 0.01, "scale \(final)")
        #expect(discrete(ev).isEmpty, "zoom pinches never become taps or drags")
        #expect(!ev.contains { $0.gesture == .pinchHold && $0.phase == .began })
    }

    @Test func pointWithPointerPosition() {
        var tl = Timeline()
        tl.add(6, makeHand(.point))
        tl.add(10) { i in [makeHand(.point, wrist: Point2(0.5 + Double(i + 1) * 0.01, 0.7))] }
        tl.add(4, makeHand(.fist, wrist: Point2(0.6, 0.7)))
        let ev = run(tl.frames).filter { $0.gesture == .point }
        #expect(ev.first?.phase == .began)
        let began = ev.first!.position!
        // Index tip is at wrist + (-0.3, -1.9) * 0.12 = (0.464, 0.472); the box maps 0.15..0.85 to 0..1.
        #expect(abs(began.x - (0.464 - 0.15) / 0.7) < 1e-6)
        #expect(abs(began.y - (0.472 - 0.15) / 0.7) < 1e-6)
        let changed = ev.filter { $0.phase == .changed }
        #expect(changed.count >= 9)
        #expect(changed.last!.position!.x > began.x + 0.13)
        #expect(ev.last?.phase == .ended)
        #expect(discrete(run(tl.frames)).isEmpty)
    }

    // MARK: anti-misfire

    @Test func jitteringOpenHandFiresNothing() {
        var rng = SynthRNG(seed: 1)
        var tl = Timeline()
        tl.add(600) { i in
            let w = Point2(0.5 + 0.05 * sin(Double(i) / 40), 0.7)
            return [jittered(makeHand(.open, wrist: w), sigma: 0.004, rng: &rng)]
        }
        #expect(run(tl.frames).isEmpty)
    }

    @Test func jitteringHoldStaysOneHold() {
        var rng = SynthRNG(seed: 2)
        var tl = Timeline()
        tl.add(6, open)
        tl.add(60) { _ in [jittered(makeHand(.pinch), sigma: 0.002, rng: &rng)] }
        tl.add(6, open)
        let ev = run(tl.frames)
        #expect(discrete(ev).isEmpty)
        #expect(ev.filter { $0.gesture == .pinchHold && $0.phase == .began }.count == 1)
        #expect(ev.filter { $0.gesture == .pinchHold && $0.phase == .ended }.count == 1)
    }

    @Test func randomLandmarksFireNoDiscreteGestures() {
        var rng = SynthRNG(seed: 3)
        var tl = Timeline()
        tl.add(900) { _ in
            let n = Int.random(in: 0...2, using: &rng)
            return (0..<n).map { _ in
                let pts = (0..<21).map { _ in Point2(Double.random(in: 0...1, using: &rng), Double.random(in: 0...1, using: &rng)) }
                let c = (0..<21).map { _ in Double.random(in: 0.3...1, using: &rng) }
                return HandLandmarks(points: pts, confidences: c)
            }
        }
        #expect(discrete(run(tl.frames)).isEmpty)
    }

    @Test func lowConfidenceHandsAreIgnored() {
        var tl = Timeline()
        tl.add(6, makeHand(.open, confidence: 0.5)); tl.add(5, makeHand(.pinch, confidence: 0.5)); tl.add(6, makeHand(.open, confidence: 0.5))
        #expect(run(tl.frames).isEmpty)
    }

    @Test func partialHandMissingThumbTipIsIgnored() {
        func partial(_ p: Posture) -> HandLandmarks {
            var h = makeHand(p)
            h.confidences[HandJoint.thumbTip.rawValue] = 0.05
            return h
        }
        var tl = Timeline()
        tl.add(6, partial(.open)); tl.add(5, partial(.pinch)); tl.add(6, partial(.open))
        #expect(run(tl.frames).isEmpty)
    }

    @Test func handEnteringAlreadyPinchedNeedsAReset() {
        var tl = Timeline()
        tl.add(5, pinch); tl.add(6, open)
        #expect(discrete(run(tl.frames)).isEmpty)
        tl.add(5, pinch); tl.add(6, open)   // after the reset, a real tap works
        #expect(discrete(run(tl.frames)) == [.airTap])
    }

    @Test func oneFramePinchFlickerIsNotATap() {
        var tl = Timeline()
        tl.add(6, open); tl.add(1, pinch); tl.add(6, open)
        #expect(run(tl.frames).isEmpty)
    }

    @Test func fistIsNotAPinch() {
        var tl = Timeline()
        tl.add(6, open); tl.add(5, makeHand(.fist)); tl.add(6, open)
        #expect(discrete(run(tl.frames)).isEmpty)
    }

    @Test func handThatNeverSettlesNeverArms() {
        // A hand passing through the frame fast (walking past the laptop) is never steady for 2 frames.
        var tl = Timeline()
        tl.add(12) { i in [makeHand(i % 3 == 1 ? .pinch : .open, wrist: Point2(0.1 + Double(i) * 0.07, 0.7))] }
        #expect(run(tl.frames).isEmpty)
    }

    @Test func tapCooldown() {
        var fast = Timeline()
        fast.add(6, open); fast.add(4, pinch); fast.add(2, open); fast.add(3, pinch); fast.add(6, open)
        #expect(discrete(run(fast.frames)) == [.airTap], "second tap inside the cooldown is dropped")
        var slow = Timeline()
        slow.add(6, open); slow.add(4, pinch); slow.add(8, open); slow.add(4, pinch); slow.add(6, open)
        #expect(discrete(run(slow.frames)) == [.airTap, .airTap])
    }

    @Test func losingTheHandMidHoldEndsTheHold() {
        var tl = Timeline()
        tl.add(6, open); tl.add(15, pinch); tl.add(15, nil)
        let holds = run(tl.frames).filter { $0.gesture == .pinchHold }.map(\.phase)
        #expect(holds == [.began, .ended])
    }

    // MARK: names and protocol

    @Test func gestureNamesAreSnakeCase() {
        let names = AirGesture.allCases.map(\.rawValue) + [RotationDirection.clockwise.gestureName,
                                                           RotationDirection.counterClockwise.gestureName]
        for n in names {
            let parts = n.split(separator: "_", omittingEmptySubsequences: false)
            #expect(!parts.isEmpty && parts.allSatisfy { !$0.isEmpty && $0.allSatisfy { ("a"..."z").contains($0) } }, "\(n)")
        }
        // No clash with the existing PROTOCOL gestures.
        let existing: Set = ["tap", "double", "triple", "sequence", "rhythm", "lid_nudge", "cover", "cover_hold",
                             "tilt_left", "tilt_right"]
        #expect(Set(names).isDisjoint(with: existing))
    }

    @Test func protocolMessages() {
        let tap = AirGestureEvent(t: 1, gesture: .airTap, phase: .instant, hand: .left, confidence: 0.912345,
                                  position: Point2(0.4, 0.5))
        let m = tap.protocolMessage(tMillis: 1234.5)
        #expect(m["type"] as? String == "gesture")
        #expect(m["gesture"] as? String == "air_tap")
        #expect(m["zone"] as? String == "air")
        #expect(m["hand"] as? String == "left")
        #expect(m["confidence"] as? Double == 0.912)
        let json = tap.protocolJSON(tMillis: 1234.5)
        #expect(json?.hasPrefix("{") == true)
        #expect(json?.contains("\"gesture\":\"air_tap\"") == true)
        let zoom = AirGestureEvent(t: 1, gesture: .twoHandZoom, phase: .changed, hand: .unknown, confidence: 1, scale: 1.3)
        let z = zoom.protocolMessage(tMillis: 10)
        #expect(z["type"] as? String == "air")
        #expect(z["phase"] as? String == "changed")
        #expect(z["scale"] as? Double == 1.3)
        #expect(z["hand"] == nil)
    }

    // MARK: performance

    @Test func performanceTenMinutesOfTwoHands() {
        var rng = SynthRNG(seed: 9)
        var frames: [HandFrame] = []
        frames.reserveCapacity(18_000)
        for i in 0..<18_000 {
            let t = Double(i) / 30
            let a = makeHand(i % 40 < 20 ? .open : .pinch, wrist: Point2(0.35, 0.7), chirality: .left)
            let b = makeHand(i % 50 < 10 ? .point : .open, wrist: Point2(0.65 + 0.05 * sin(t), 0.7))
            frames.append(HandFrame(t: t, hands: [jittered(a, sigma: 0.002, rng: &rng), jittered(b, sigma: 0.002, rng: &rng)]))
        }
        let r = AirGestureRecognizer()
        let clock = ContinuousClock()
        let start = clock.now
        var n = 0
        for f in frames { n += r.process(f).count }
        let dt = seconds(clock.now - start)
        print("recognizer: 18000 two-hand frames in \(fmt(dt, 3)) s (\(fmt(dt / 18_000 * 1e6, 1)) us/frame), \(n) events")
        #expect(dt < 3.0)
    }
}
