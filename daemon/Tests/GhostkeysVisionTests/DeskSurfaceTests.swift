import Darwin
import Testing
@testable import GhostkeysVision

@Suite struct DeskSurfaceTests {
    // MARK: homography

    @Test func fitIsExactAndRoundTrips() throws {
        let src = [Point2(0, 0), Point2(1, 0), Point2(1, 1), Point2(0, 1)]
        let dst = [Point2(0.21, 0.12), Point2(0.83, 0.09), Point2(0.97, 0.88), Point2(0.05, 0.93)]
        let h = try #require(Homography.fit(from: src, to: dst))
        for (s, d) in zip(src, dst) { #expect(h.apply(s)!.distance(to: d) < 1e-12) }
        let inv = try #require(h.inverse)
        var rng = SynthRNG(seed: 4)
        var worst = 0.0
        for _ in 0..<1000 {
            let p = Point2(Double.random(in: 0...1, using: &rng), Double.random(in: 0...1, using: &rng))
            worst = max(worst, inv.apply(h.apply(p)!)!.distance(to: p))
        }
        #expect(worst < 1e-12)
    }

    @Test func degenerateCorrespondencesAreRejected() {
        #expect(Homography.fit(from: [Point2(0, 0)], to: [Point2(0, 0)]) == nil)
        let same = [Point2](repeating: Point2(0.3, 0.3), count: 4)
        #expect(Homography.fit(from: same, to: same) == nil)
    }

    @Test func geometricModelRoundTripsForEveryFamilyAndAngle() throws {
        for fam in LaptopFamily.allCases {
            for angle in stride(from: 95.0, through: 135.0, by: 10) {
                let m = try #require(DeskSurfaceMapper(lidAngleDegrees: angle, family: fam), "\(fam) \(angle)")
                var worstRT = 0.0, worstModel = 0.0
                for i in 0...10 { for j in 0...10 {
                    let d = Point2(Double(i) / 10, Double(j) / 10)
                    let img = try #require(m.imagePoint(fromDeck: d))
                    let back = try #require(m.deckPoint(fromImage: img))
                    worstRT = max(worstRT, back.distance(to: d))
                    // The fitted homography must agree with the pinhole projection everywhere on the plane.
                    let direct = try #require(DeskSurfaceMapper.project(deck: d, lidAngleDegrees: angle,
                                                                         dimensions: fam.dimensions,
                                                                         camera: DeskViewCameraModel()))
                    worstModel = max(worstModel, direct.distance(to: img))
                } }
                #expect(worstRT < 1e-9, "\(fam) \(angle): round trip \(worstRT)")
                #expect(worstModel < 1e-9, "\(fam) \(angle): model \(worstModel)")
            }
        }
    }

    @Test func modelOrientationIsSane() throws {
        let m = try #require(DeskSurfaceMapper(lidAngleDegrees: 115, family: .macbookPro14))
        // The front lip (y = 1) is nearer the user, so lower in the image than the hinge (y = 0).
        #expect(m.imagePoint(fromDeck: Point2(0.5, 1))!.y > m.imagePoint(fromDeck: Point2(0.5, 0))!.y)
        // The user's right (x = 1) is on the image right.
        #expect(m.imagePoint(fromDeck: Point2(1, 0.5))!.x > m.imagePoint(fromDeck: Point2(0, 0.5))!.x)
        let frac = m.visibleDeckFraction()
        print("desk view model, MBP 14 at 115 deg: \(Int(frac * 100))% of the deck inside the image")
        #expect((0...1).contains(frac))
    }

    @Test func cornerCalibrationMapsFingertips() throws {
        let corners = [Point2(0.2, 0.1), Point2(0.8, 0.12), Point2(0.9, 0.6), Point2(0.1, 0.58)]
        let m = try #require(DeskSurfaceMapper(imageCorners: corners))
        #expect(m.deckPoint(fromImage: corners[2])!.distance(to: Point2(1, 1)) < 1e-9)
        var hand = makeHand(.open, wrist: Point2(0.5, 0.8), s: 0.1)
        hand.confidences[HandJoint.littleTip.rawValue] = 0.1
        let tips = m.fingertips(of: hand)
        #expect(tips.count == 4, "little tip is below confidence")
        for (j, d) in tips {
            #expect(m.imagePoint(fromDeck: d)!.distance(to: hand[j]) < 1e-9)
        }
    }

    // MARK: touch vs hover

    let zones = [DeckZone(id: "right-grille", x: 0.88, y: 0.08, w: 0.1, h: 0.45),
                 DeckZone(id: "left-palm", x: 0.05, y: 0.6, w: 0.3, h: 0.35)]

    func approachAndStop(_ det: DeskTouchDetector, at target: Point2, stillFrames: Int = 10) -> [DeskTouchEvent] {
        var ev: [DeskTouchEvent] = []
        var t = 0.0
        for i in 0..<10 {   // glide in at ~1.5 units/s
            ev += det.process(target + Point2(0.05 * Double(10 - i), 0), t: t); t += 1.0 / 30
        }
        for _ in 0..<stillFrames { ev += det.process(target, t: t); t += 1.0 / 30 }
        for i in 1...5 { ev += det.process(target - Point2(0.05 * Double(i), 0), t: t); t += 1.0 / 30 }
        return ev
    }

    @Test func stillFingertipInZoneIsATouch() {
        let ev = approachAndStop(DeskTouchDetector(zones: zones), at: Point2(0.2, 0.8))
        #expect(ev.map(\.phase) == [.began, .ended])
        #expect(ev.first?.zone == "left-palm")
        #expect(ev.first!.confidence < 0.9, "no sensor confirmation, so moderate confidence")
    }

    @Test func movingFingertipIsNotATouch() {
        let det = DeskTouchDetector(zones: zones)
        var ev: [DeskTouchEvent] = []
        for i in 0..<60 { ev += det.process(Point2(0.05 + Double(i) * 0.01, 0.8), t: Double(i) / 30) }
        #expect(ev.isEmpty)
    }

    @Test func stillOutsideZonesIsNotATouch() {
        #expect(approachAndStop(DeskTouchDetector(zones: zones), at: Point2(0.5, 0.3)).isEmpty)
    }

    @Test func sensorConfirmationDecides() {
        let yes = approachAndStop(DeskTouchDetector(zones: zones, contactConfirmer: { _, _ in .confirmed }),
                                  at: Point2(0.2, 0.8))
        #expect(yes.first?.confidence ?? 0 > 0.9)
        let no = approachAndStop(DeskTouchDetector(zones: zones, contactConfirmer: { _, _ in .rejected }),
                                 at: Point2(0.2, 0.8))
        #expect(no.isEmpty, "hovering finger the motion sensor did not feel")
    }

    @Test func losingTheFingertipEndsTheTouch() {
        let det2 = DeskTouchDetector(zones: zones)
        var ev: [DeskTouchEvent] = []
        for i in 0..<10 { ev += det2.process(Point2(0.9, 0.3), t: Double(i) / 30) }
        ev += det2.process(nil, t: 0.5)
        #expect(ev.map(\.phase) == [.began, .ended])
        #expect(ev.first?.zone == "right-grille")
    }

    // MARK: circle knob

    func circle(from a0: Double, degrees: Double, stepDeg: Double = 10, r: Double = 0.15,
                center: Point2 = Point2(0.5, 0.5), noise: Double = 0, seed: UInt64 = 5) -> [Point2] {
        var rng = SynthRNG(seed: seed)
        let n = Int(abs(degrees) / stepDeg)
        return (0...n).map { i in
            let a = (a0 + Double(i) * stepDeg * (degrees > 0 ? 1 : -1)) * .pi / 180
            return center + Point2(r * cos(a), r * sin(a)) + Point2(rng.gaussian() * noise, rng.gaussian() * noise)
        }
    }

    func feed(_ pts: [Point2], _ knob: CircleKnob = CircleKnob(), dt: Double = 1.0 / 30) -> [KnobStep] {
        pts.enumerated().flatMap { knob.process($1, t: Double($0) * dt) }
    }

    @Test func clockwiseCircleGivesTwelveSteps() {
        // One extra 10 degree sample: the first segment only sets the heading.
        let steps = feed(circle(from: 0, degrees: 370))
        #expect(steps.count == 12)
        #expect(steps.allSatisfy { $0.direction == .clockwise })
        #expect(steps.last?.index == 12)
    }

    @Test func counterClockwiseCircle() {
        let steps = feed(circle(from: 90, degrees: -370))
        #expect(steps.count == 12)
        #expect(steps.allSatisfy { $0.direction == .counterClockwise })
        #expect(steps.last?.index == -12)
    }

    @Test func oneAndAHalfTurnsWithNoise() {
        let steps = feed(circle(from: 0, degrees: 550, noise: 0.002))
        #expect((17...19).contains(steps.count), "\(steps.count)")
        #expect(steps.allSatisfy { $0.direction == .clockwise })
    }

    @Test func reversingDirectionCountsBack() {
        let knob = CircleKnob()
        let cw = circle(from: 0, degrees: 190)                  // ~6 cw steps
        let ccw = circle(from: 190, degrees: -190).dropFirst()  // then ~6 back
        let steps = feed(cw + ccw, knob)
        #expect(steps.filter { $0.direction == .clockwise }.count >= 5)
        #expect(steps.filter { $0.direction == .counterClockwise }.count >= 4)
        #expect(abs(knob.steps) <= 2)
    }

    @Test func straightJitteryLineIsNotACircle() {
        var rng = SynthRNG(seed: 6)
        let pts = (0..<120).map { i in Point2(0.1 + Double(i) * 0.006 + rng.gaussian() * 0.0015, 0.5 + rng.gaussian() * 0.0015) }
        #expect(feed(pts).isEmpty)
        // Pure jitter around one spot: segments never reach the minimum length.
        let still = (0..<120).map { _ in Point2(0.5 + rng.gaussian() * 0.002, 0.5 + rng.gaussian() * 0.002) }
        #expect(feed(still).isEmpty)
    }

    // MARK: performance

    @Test func mappingPerformance() throws {
        let m = try #require(DeskSurfaceMapper(lidAngleDegrees: 115, family: .macbookPro16))
        var rng = SynthRNG(seed: 7)
        let pts = (0..<100_000).map { _ in Point2(Double.random(in: 0...1, using: &rng), Double.random(in: 0...1, using: &rng)) }
        let clock = ContinuousClock()
        let start = clock.now
        var acc = 0.0
        for p in pts { acc += m.deckPoint(fromImage: p)?.x ?? 0 }
        let dt = seconds(clock.now - start)
        print("homography: 100000 points in \(fmt(dt, 4)) s")
        #expect(dt < 1.0)
        #expect(acc.isFinite)
    }
}
