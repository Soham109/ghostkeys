import CoreVideo
import Darwin
import Testing
@testable import GhostkeysVision

@Suite struct TrackerAndFilterTests {
    @Test func oneEuroCalmsAStillSignal() {
        var rng = SynthRNG(seed: 11)
        var f = OneEuroFilter(minCutoff: 1.0, beta: 0.5)
        var raw: [Double] = [], out: [Double] = []
        for i in 0..<300 {
            let x = 0.5 + rng.gaussian() * 0.01
            raw.append(x)
            out.append(f.filter(x, t: Double(i) / 30))
        }
        func variance(_ v: ArraySlice<Double>) -> Double {
            let m = v.reduce(0, +) / Double(v.count)
            return v.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Double(v.count)
        }
        #expect(variance(out[30...]) < variance(raw[30...]) * 0.2)
    }

    @Test func oneEuroFollowsFastMotion() {
        var f = OneEuroFilter(minCutoff: 1.0, beta: 8.0)
        var last = 0.0
        for i in 0..<30 { last = f.filter(Double(i) * 0.03, t: Double(i) / 30) }   // 0.9 units/s ramp
        #expect(abs(last - 29 * 0.03) < 0.03, "lag \(29 * 0.03 - last)")
    }

    @Test func handSmootherSkipsUnseenJoints() {
        var s = HandSmoother()
        var h = makeHand(.open)
        _ = s.smooth(h, t: 0)
        h.confidences[HandJoint.thumbTip.rawValue] = 0
        h[.thumbTip] = Point2(0, 0)
        let out = s.smooth(h, t: 1.0 / 30)
        #expect(out[.thumbTip] == Point2(0, 0))
    }

    @Test func visionPointsAreFlippedAndMirrored() {
        let dict: [HandJoint: (x: Double, y: Double, confidence: Double)] = [
            .wrist: (0.2, 0.3, 0.9), .indexTip: (0.25, 0.6, 0.05),
        ]
        let h = HandTracker.landmarks(fromVisionPoints: dict, chirality: .left, mirror: true)
        #expect(abs(h[.wrist].x - 0.8) < 1e-12)
        #expect(abs(h[.wrist].y - 0.7) < 1e-12)
        #expect(h.confidence(.wrist) == 0.9)
        #expect(h.confidence(.indexTip) == 0, "below the minimum joint confidence")
        #expect(h.confidence(.thumbTip) == 0, "missing joint")
        let u = HandTracker.landmarks(fromVisionPoints: dict, chirality: .left, mirror: false)
        #expect(abs(u[.wrist].x - 0.2) < 1e-12)
    }

    @Test func visionOnABlankFrameFindsNoHands() throws {
        // Runs the real Vision hand model on a synthetic gray buffer. No camera involved.
        var pb: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any]] as CFDictionary
        let st = CVPixelBufferCreate(nil, 320, 240, kCVPixelFormatType_32BGRA, attrs, &pb)
        #expect(st == kCVReturnSuccess)
        let buffer = try #require(pb)
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddress(buffer), 0x80, CVPixelBufferGetDataSize(buffer))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let tracker = HandTracker()
        let clock = ContinuousClock()
        let start = clock.now
        let frame = try tracker.process(pixelBuffer: buffer, t: 0)
        let dt = seconds(clock.now - start)
        print("vision hand pose on 320x240: \(fmt(dt * 1000, 1)) ms (first call includes model load)")
        #expect(frame.hands.isEmpty)
        let warm = clock.now
        for i in 1...10 { _ = try tracker.process(pixelBuffer: buffer, t: Double(i) / 30) }
        print("vision hand pose on 320x240, warm: \(fmt(seconds(clock.now - warm) * 100, 1)) ms per frame")
    }

    @Test func listingCamerasDoesNotOpenThem() {
        // DiscoverySession only enumerates; it does not start capture or prompt for permission.
        let devices = CameraSession.availableDevices()
        for d in devices { print("camera: \(d.name) [\(d.kind.rawValue)] max \(d.maxWidth)x\(d.maxHeight) centerStage=\(d.centerStageSupported)") }
        #expect(devices.allSatisfy { !$0.uniqueID.isEmpty })
    }
}
