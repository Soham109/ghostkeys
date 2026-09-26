import Foundation
import AVFoundation
import CoreMedia
import GhostkeysVision

/// Runs short camera sessions for in-air gestures (GhostkeysVision README "How the daemon should integrate").
/// Control methods are called on the daemon's core queue. Frames are processed on the camera's capture queue
/// (tracker + recognizer), and the resulting events are hopped onto the core queue.
/// With `simulate`, no camera is touched: the session only exists as state and a timer (for tests).
final class AirSession: @unchecked Sendable {
    /// Discrete gesture (bound like a tap, zone "air") or a continuous `air` message.
    enum Output {
        case gesture(name: String, t: Double, confidence: Double, extra: [String: Any])
        case air([String: Any], t: Double)
        /// Desk mode: a fingertip touch the IMU confirmed, reported as a `tap` with source "camera".
        case deskTap(zone: String, t: Double, x: Double, y: Double, confidence: Double)
    }

    let simulate: Bool
    private let queue: DispatchQueue
    private var camera: CameraSession?
    private var simulatedRunning = false

    // Capture-queue state (created per session, touched only from the capture queue after start).
    private var tracker: HandTracker?
    private var recognizer: AirGestureRecognizer?
    private var knob: CircleKnob?
    private var desk: (mapper: DeskSurfaceMapper, touch: DeskTouchDetector)?
    private let lastHandLock = NSLock()
    private var _lastHandSeen = 0.0
    var lastHandSeen: Double { lastHandLock.lock(); defer { lastHandLock.unlock() }; return _lastHandSeen }

    /// Called on the core queue.
    var onOutput: (Output) -> Void = { _ in }
    /// Called on the core queue when the camera stopped by itself ("timeout", "error", "interrupted").
    var onStopped: (String) -> Void = { _ in }

    init(queue: DispatchQueue, simulate: Bool) {
        self.queue = queue
        self.simulate = simulate
    }

    /// A camera exists. Lists devices without opening any; never prompts, never turns on the light.
    static var hardwarePresent: Bool { !CameraSession.availableDevices().isEmpty }

    static var permission: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "authorized"
        case .notDetermined: return "not_determined"
        default: return "denied"
        }
    }

    var running: Bool { camera != nil || simulatedRunning }

    struct DeskConfig {
        var lidAngle: Double
        var family: String
        var zones: [(id: String, x: Double, y: Double, w: Double, h: Double)]
        /// Confirms contact: true if the IMU saw a tap within ~150 ms of `t` (Clock seconds). Called on the capture queue.
        var imuTapNear: @Sendable (Double) -> Bool
    }

    /// Starts the camera. `desk` non-nil selects experimental Desk View mode. Completion runs on the core queue with
    /// an error message or nil.
    func start(seconds: Double, desk: DeskConfig?, userInitiated: Bool, completion: @escaping (String?) -> Void) {
        guard !running else { return completion(nil) }
        if simulate {
            simulatedRunning = true
            Log.info("air session started (simulated: no camera opened)")
            return completion(nil)
        }
        let kind: CameraKind = desk == nil ? .front : .deskView
        guard CameraSession.availableDevices().contains(where: { $0.kind == kind }) else {
            return completion(kind == .front ? "no camera on this Mac" : "Desk View is not available on this Mac")
        }
        switch Self.permission {
        case "denied": return completion("camera access is denied (System Settings > Privacy & Security > Camera)")
        case "not_determined" where !userInitiated: return completion("camera permission not granted yet; start a session from the app first")
        default: break
        }

        var trackerOptions = HandTracker.Options()
        trackerOptions.mirrorHorizontally = kind == .front
        tracker = HandTracker(options: trackerOptions)
        recognizer = AirGestureRecognizer()
        knob = CircleKnob()
        self.desk = nil
        if let desk, let fam = LaptopFamily(rawValue: desk.family),
           let mapper = DeskSurfaceMapper(lidAngleDegrees: desk.lidAngle, family: fam) {
            let zones = desk.zones.map { DeckZone(id: $0.id, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
            let near = desk.imuTapNear
            let touch = DeskTouchDetector(zones: zones) { _, t in near(t) ? .confirmed : .unknown }
            self.desk = (mapper, touch)
        } else if desk != nil {
            Log.info("desk mode: no geometry for this laptop; running without deck mapping")
        }

        var options = CameraSession.Options()
        options.kind = kind
        options.maxDuration = seconds          // the module stops by itself at this limit too
        let cam = CameraSession(options: options)
        cam.onFrame = { [weak self, weak cam] sb in
            guard let self, let cam else { return }
            self.handleFrame(sb, camera: cam)
        }
        cam.onStop = { [weak self] reason in
            self?.queue.async {
                guard let self, self.camera === cam else { return }
                self.teardown()
                if reason != .requested { self.onStopped(reason.rawValue) }
            }
        }
        camera = cam
        lastHandLock.lock(); _lastHandSeen = Clock.now(); lastHandLock.unlock()
        cam.start { [weak self] error in
            self?.queue.async {
                guard let self else { return }
                if let error {
                    self.teardown()
                    completion("could not start the camera: \(error)")
                } else {
                    Log.info("air session started (camera on, \(kind.rawValue))")
                    completion(nil)
                }
            }
        }
    }

    func stop() {
        simulatedRunning = false
        camera?.stop()
        teardown()
    }

    private func teardown() {
        camera?.onFrame = nil
        camera = nil
    }

    // MARK: Capture queue

    private func handleFrame(_ sb: CMSampleBuffer, camera cam: CameraSession) {
        guard let tracker, let recognizer else { return }
        let t = Clock.now()
        guard let frame = try? tracker.process(sampleBuffer: sb, t: t) else { return }
        let events = recognizer.process(frame)
        let handPresent = recognizer.handPresent
        cam.setHandPresent(handPresent)
        if handPresent { lastHandLock.lock(); _lastHandSeen = t; lastHandLock.unlock() }

        var outputs: [Output] = []
        for e in events {
            var msg = e.protocolMessage(tMillis: Clock.protocolMs(e.t))
            if e.phase == .instant {
                var extra: [String: Any] = [:]
                for k in ["hand", "x", "y"] { if let v = msg[k] { extra[k] = v } }
                outputs.append(.gesture(name: e.gesture.rawValue, t: e.t, confidence: e.confidence, extra: extra))
            } else {
                msg["type"] = "air"
                outputs.append(.air(msg, t: e.t))
                // pinch_hold drives bindings once, when it begins.
                if e.gesture == .pinchHold && e.phase == .began {
                    var extra: [String: Any] = [:]
                    for k in ["hand", "x", "y"] { if let v = msg[k] { extra[k] = v } }
                    outputs.append(.gesture(name: e.gesture.rawValue, t: e.t, confidence: e.confidence, extra: extra))
                }
                // The pointer drives the circle knob: one circle_cw / circle_ccw per 30 degrees.
                if e.gesture == .point, let p = e.position, let knob {
                    for step in knob.process(p, t: e.t) {
                        outputs.append(.gesture(name: step.direction.gestureName, t: step.t, confidence: e.confidence,
                                                extra: ["step": step.index]))
                    }
                }
            }
        }
        if let desk, let hand = frame.hands.first {
            let tip = desk.mapper.fingertips(of: hand).first { $0.joint == .indexTip }?.deck
            for touch in desk.touch.process(tip, t: t) where touch.phase == .began {
                outputs.append(.deskTap(zone: touch.zone, t: touch.t, x: touch.position.x, y: touch.position.y,
                                        confidence: touch.confidence))
            }
        }
        guard !outputs.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, self.camera != nil else { return }
            for o in outputs { self.onOutput(o) }
        }
    }
}
