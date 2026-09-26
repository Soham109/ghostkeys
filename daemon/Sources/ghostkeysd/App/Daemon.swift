import Foundation
import AppKit
import ApplicationServices
import GhostkeysDetection
import GhostkeysIntegrations

/// Wires sensors, detection, the WebSocket server, config, calibration and actions together.
/// Every piece of mutable state here is touched only on `core`.
final class Daemon: @unchecked Sendable {
    static let version = "0.1.0"
    static let streams: Set<String> = ["imu", "lid", "light", "taps", "air"]

    let options: Options
    let core = DispatchQueue(label: "ghostkeys.core", qos: .userInteractive)
    let store = ConfigStore()
    let device = DeviceInfo.current()
    let hub = SensorHub()
    let input = InputMonitor()
    let actions: ActionRunner
    let server: WebSocketServer
    let token: SessionToken
    let approvals: ApprovalStore
    private var limiter = ActionLimiter()
    private var pausedReason: String?          // "user" or "rate_limit" while paused
    private var lastPermissionPrompt = -100.0
    /// Optional sound (mic) and air (camera) sessions. Off unless the app asks or the user pinned an app.
    private var sessions: SessionCoordinator!
    /// pinch_hold knob in progress: the binding and the travel accumulated since the last step.
    private var knob: (binding: Binding, spec: KnobSpec, travel: Double)?
    private lazy var catalog: Any = (try? JSONSerialization.jsonObject(with: Data(IntegrationCatalog.json.utf8))) ?? [:]

    private var config: Config
    private let engine: TapEngine
    private let lidDetector = LidGestureDetector()
    private let lightDetector = LightGestureDetector()
    private var calibration: CalibrationSession?
    private var negativesTimer: DispatchSourceTimer?
    private var housekeeping: DispatchSourceTimer?
    private var lightPoll: DispatchSourceTimer?

    // paused is read by the action queue too.
    private let pausedLock = NSLock()
    private var _paused = false
    private var paused: Bool {
        get { pausedLock.lock(); defer { pausedLock.unlock() }; return _paused }
        set { pausedLock.lock(); _paused = newValue; pausedLock.unlock() }
    }

    // Stream state.
    private var lidAngle: Double?
    private var lastLidSent: Double?
    private var lastLightSentAt = -1.0
    private var lastIMUSentAt = -1.0
    private var imuCountWindow = 0
    private var imuWindowStart = -1.0
    private var imuHz = 0.0
    private var lastAccessibility = false

    init(options: Options) throws {
        self.options = options
        token = try SessionToken(directory: store.directory)
        approvals = ApprovalStore(directory: store.directory)
        actions = ActionRunner(dryRun: options.dryRun, approvals: approvals)
        server = WebSocketServer(port: options.port, queue: core, token: token)
        ZoneDefaults.warnIfStale()
        config = store.loadConfig(family: device.family)
        engine = TapEngine(settings: config.settings.detection)
        engine.model = store.loadModel()
        applyConfigToEngine()   // also sets the model's zone centres
        actions.isPaused = { [weak self] in self?.paused ?? true }
        sessions = SessionCoordinator(queue: core, simulate: options.noHardwareSessions,
                                      modelDirectory: store.modelDirectory, host: self)
    }

    // MARK: Lifecycle

    func start() throws {
        input.onActivate = { [weak self] id in self?.core.async { self?.sessions.frontmostChanged(to: id) } }
        input.start()
        lastAccessibility = AXIsProcessTrusted()

        server.onConnect = { [weak self] c in self?.greet(c) }
        server.onMessage = { [weak self] c, m in self?.handle(m, from: c) }
        try server.start()

        hub.start(handlers: .init(
            imu: { [weak self] s in self?.core.async { self?.onIMU(s) } },
            lid: { [weak self] a, t in self?.core.async { self?.onLid(a, t: t) } },
            light: { [weak self] v, _, t in self?.core.async { self?.onLight(v, t: t) } }))

        let timer = DispatchSource.makeTimerSource(queue: core)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        housekeeping = timer

        // cover_hold must fire on time even when the light sensor only reports on change.
        let poll = DispatchSource.makeTimerSource(queue: core)
        poll.schedule(deadline: .now() + 0.1, repeating: 0.1, leeway: .milliseconds(10))
        poll.setEventHandler { [weak self] in
            guard let self, self.hub.present.contains(.light) else { return }
            if let g = self.lightDetector.poll(t: Clock.now()) { self.onGesture(g, fillModifiers: true) }
        }
        poll.resume()
        lightPoll = poll

        Log.info("ghostkeysd \(Self.version) on \(device.model) (\(device.chip), \(device.family))"
                 + (options.dryRun ? " [dry-run]" : "") + "; config in \(store.directory.path)")
    }

    func stop() {
        hub.stop()
        server.stop()
    }

    /// Every 5 s: status (imuHz) and an accessibility check so the app learns when permission is granted.
    private func tick() {
        let ax = AXIsProcessTrusted()
        if ax != lastAccessibility {
            lastAccessibility = ax
            server.broadcast(hello())
        }
        server.broadcast(status())
    }

    // MARK: Sensor input (core queue)

    private func onIMU(_ s: IMUSample) {
        if imuWindowStart < 0 { imuWindowStart = s.t }
        imuCountWindow += 1
        if s.t - imuWindowStart >= 1 {
            imuHz = Double(imuCountWindow) / (s.t - imuWindowStart)
            imuCountWindow = 0
            imuWindowStart = s.t
        }

        let now = s.t
        let snap = input.snapshot(now: Clock.now())
        // While capturing, the typing / trackpad / burst gates must not block samples: every spike becomes a labeled
        // candidate (during negatives the user types on purpose; those spikes are exactly the "none" examples).
        // Normal operation keeps every gate.
        let capturing = calibration.map { $0.phase != .idle } ?? false
        engine.bypassInputGates = capturing
        let context = InputContext(secondsSinceKey: snap.key, secondsSinceMouse: snap.mouse, modifiers: snap.modifiers,
                                   lidAngle: lidAngle, paused: capturing ? false : paused)

        for event in engine.ingest(s, context: context) {
            switch event {
            case .candidate(let f):
                captureCandidate(f, now: now)
                if sessions.tapCalibrating { sessions.tapCandidate(t: f.t) }
            case .rejected(let t, let reason):
                server.broadcast(["type": "rejected", "t": Clock.protocolMs(t), "reason": reason.rawValue], stream: "taps")
            case .tap(let tap):
                let msg: [String: Any] = ["type": "tap", "t": Clock.protocolMs(tap.t), "zone": tap.zone, "confidence": tap.confidence,
                                          "x": tap.x, "y": tap.y, "strength": tap.strength, "source": "imu"]
                // During a sound session the message may wait (at most 150 ms) for its tapType.
                if !sessions.imuTap(t: tap.t, zone: tap.zone, message: msg) { server.broadcast(msg, stream: "taps") }
            case .gesture(let g):
                // In zones a knock_knuckle binding could claim, the plain tap waits (<= 150 ms) for the tap type.
                if g.gesture == "tap", sessions.holdTapGesture(t: g.t, zone: g.zone, release: { [weak self] in self?.onGesture(g) }) {
                    continue
                }
                onGesture(g)
            }
        }

        if now - lastIMUSentAt >= 1.0 / 60 - 0.0005, server.hasSubscribers("imu") {
            lastIMUSentAt = now
            server.broadcast(["type": "imu", "t": Clock.protocolMs(now),
                              "a": [Self.r4(s.a.x), Self.r4(s.a.y), Self.r4(s.a.z)],
                              "g": [Self.r4(s.g.x), Self.r4(s.g.y), Self.r4(s.g.z)]], stream: "imu")
        }
    }

    private func onLid(_ angle: Double, t: Double) {
        lidAngle = angle
        if lastLidSent != angle {
            lastLidSent = angle
            server.broadcast(["type": "lid", "t": Clock.protocolMs(t), "angle": angle], stream: "lid")
        }
        sessions.lidChanged(angle: angle)
        if let g = lidDetector.ingest(angle: angle, t: t) { onGesture(g, fillModifiers: true) }
    }

    private func onLight(_ value: Double, t: Double) {
        if t - lastLightSentAt >= 0.09 {
            lastLightSentAt = t
            server.broadcast(["type": "light", "t": Clock.protocolMs(t), "value": Self.r4(value)], stream: "light")
        }
        if let g = lightDetector.ingest(value: value, t: t) { onGesture(g, fillModifiers: true) }
    }

    // MARK: Gestures and bindings

    /// `extra`: fields added to the gesture message (camera: hand, x, y; sound/camera: source).
    private func onGesture(_ g0: GestureEvent, fillModifiers: Bool = false, extra: [String: Any] = [:]) {
        var g = g0
        if fillModifiers && g.modifiers.isEmpty { g.modifiers = InputMonitor.currentModifiers() }
        if paused {
            server.broadcast(["type": "rejected", "t": Clock.protocolMs(g.t), "reason": RejectReason.paused.rawValue], stream: "taps")
            return
        }
        let app = input.frontmostBundleID
        var msg: [String: Any] = ["type": "gesture", "t": Clock.protocolMs(g.t), "gesture": g.gesture, "zone": g.zone ?? NSNull(),
                                  "zones": g.zones, "modifiers": g.modifiers.sorted(), "confidence": g.confidence,
                                  "app": app ?? NSNull()]
        for (k, v) in extra where msg[k] == nil { msg[k] = v }
        server.broadcast(msg)
        // No actions while calibrating: the user is tapping zones (or tap types) on purpose.
        guard calibration == nil, !sessions.tapCalibrating else { return }
        guard let binding = BindingResolver.resolve(g, bindings: config.bindings, app: app) else { return }
        let label = binding.label ?? binding.id
        // A pinch_hold binding with a knob fires per step of travel (see onAir), not when the hold begins.
        if g.gesture == "pinch_hold", let spec = binding.knob {
            knob = (binding, spec, 0)
            return
        }
        switch limiter.admit(bindingId: binding.id, gesture: g.gesture, now: Clock.now()) {
        case .ok: break
        case .cooldown:
            Log.debug("binding \(binding.id) in cooldown or still running; skipped")
            return
        case .tripped(let why):
            tripRateLimit(why)
            sendAction(t: g.t, bindingId: binding.id, label: label, ok: false, error: "rate limit: \(why); paused")
            return
        }
        // Gesture actions are dropped if they would start more than 1 s late (stale).
        runAction(binding.action, bindingId: binding.id, label: label, t: g.t, maxAge: 1)
    }

    /// Continuous camera messages: forwarded to `air` subscribers and, for pinch_hold, drive an active knob.
    private func onAir(_ msg: [String: Any]) {
        server.broadcast(msg, stream: "air")
        guard (msg["gesture"] as? String) == "pinch_hold", let phase = msg["phase"] as? String else { return }
        if phase == "ended" || phase == "began" && knob != nil { knob = nil; if phase == "ended" { return } }
        guard phase == "changed", var k = knob, !paused else { return }
        // Landmark y points down; the knob's positive y is up.
        let d = k.spec.axis == "x" ? (msg["dx"] as? Double ?? 0) : -(msg["dy"] as? Double ?? 0)
        k.travel += d
        let step = k.spec.stepFraction
        var fired = 0
        while abs(k.travel) >= step && fired < 8 {
            let positive = k.travel > 0
            k.travel -= positive ? step : -step
            fired += 1
            guard let action = positive ? k.binding.action : k.spec.inverse else { continue }
            let id = k.binding.id + (positive ? "" : "#inverse")
            guard limiter.admitKnobStep(bindingId: id, now: Clock.now()) else { continue }   // dropped, never pauses
            runAction(action, bindingId: id, label: (k.binding.label ?? k.binding.id) + (positive ? " +" : " -"),
                      t: Clock.now(), maxAge: 0.3)
        }
        knob = k
    }

    /// Too many actions: pause everything and tell the app why (SAFETY_AUDIT H5).
    private func tripRateLimit(_ why: String) {
        guard !paused else { return }
        Log.info("action rate limit tripped (\(why)); pausing")
        paused = true
        pausedReason = "rate_limit"
        sessions.stopAll(reason: "paused")
        server.broadcast(status())
    }

    /// `replyTo`: for test_action, the result (and any error detail) goes only to the client that asked.
    private func runAction(_ action: JSONValue, bindingId: String?, label: String, t: Double, maxAge: TimeInterval? = nil,
                           replyTo: WebSocketServer.Client? = nil) {
        guard !paused else {
            if let bindingId { limiter.finished(bindingId: bindingId) }
            sendAction(t: t, bindingId: bindingId, label: label, ok: false, error: "paused", replyTo: replyTo)
            return
        }
        let replyID = replyTo?.id
        actions.run(action, maxAge: maxAge) { [weak self] ok, error in
            self?.core.async {
                guard let self else { return }
                if let bindingId { self.limiter.finished(bindingId: bindingId) }
                if let error { Log.info("action \(label) failed: \(error)") }
                let client = replyID.flatMap { self.server.clients[$0] }
                if replyID != nil && client == nil { return }   // requester is gone
                self.sendAction(t: t, bindingId: bindingId, label: label, ok: ok, error: error, replyTo: client)
            }
        }
    }

    private func sendAction(t: Double, bindingId: String?, label: String, ok: Bool, error: String?,
                            replyTo: WebSocketServer.Client? = nil) {
        let msg: [String: Any] = ["type": "action", "t": Clock.protocolMs(t), "bindingId": bindingId ?? NSNull(),
                                  "label": label, "ok": ok, "error": error ?? NSNull()]
        if let replyTo { server.send(msg, to: replyTo) } else { server.broadcast(msg) }
    }

    // MARK: Calibration

    private func captureCandidate(_ f: TapFeatures, now: Double) {
        guard let cal = calibration else { return }
        guard let (zone, count) = cal.capture(f, now: now) else { return }
        server.broadcast(["type": "calibration", "phase": "capturing", "zone": zone, "count": count, "target": cal.target])
        if count >= cal.target { cal.endPhase() }
    }

    private func startNegativesCountdown(seconds: Int) {
        negativesTimer?.cancel()
        var left = seconds
        server.broadcast(["type": "calibration", "phase": "negatives", "secondsLeft": left])
        let timer = DispatchSource.makeTimerSource(queue: core)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, let cal = self.calibration else { return }
            left -= 1
            self.server.broadcast(["type": "calibration", "phase": "negatives", "secondsLeft": max(0, left)])
            if left <= 0 {
                cal.endPhase()
                self.negativesTimer?.cancel()
                self.negativesTimer = nil
            }
        }
        timer.resume()
        negativesTimer = timer
    }

    private func finishCalibration(_ client: WebSocketServer.Client) {
        guard let cal = calibration else { return sendError("no calibration in progress", to: client) }
        negativesTimer?.cancel(); negativesTimer = nil
        cal.endPhase()
        guard !cal.samples.isEmpty else { return sendError("no samples captured yet", to: client) }
        calibration = nil
        server.broadcast(["type": "calibration", "phase": "training"])
        let samples = cal.samples
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let (model, report) = cal.trainer.train()
            guard let self else { return }
            do {
                try self.store.saveModel(model, report: report)
                try self.store.saveSamples(samples)
            } catch {
                Log.error("could not save model: \(error)")
            }
            self.core.async {
                self.engine.model = model
                self.applyZoneCenters()
                self.server.broadcast(["type": "calibration", "phase": "done", "accuracy": report.accuracy,
                                       "overall": report.overall, "confusion": report.confusion, "labels": report.labels])
                self.server.broadcast(self.status())
                Log.info("calibration done: overall accuracy \(report.overall), labels \(report.labels)")
            }
        }
    }

    // MARK: Messages from the app

    private func greet(_ c: WebSocketServer.Client) {
        server.send(hello(), to: c)
        server.send(status(), to: c)
        server.send(configMessage(), to: c)
        for m in sessions.stateMessages() { server.send(m, to: c) }
    }

    private func handle(_ m: [String: Any], from c: WebSocketServer.Client) {
        guard let type = m["type"] as? String else { return sendError("message has no type", to: c) }
        Log.debug("<- \(type)")
        switch type {
        case "subscribe", "unsubscribe":
            let streams = Set((m["streams"] as? [String]) ?? []).intersection(Self.streams)
            if type == "subscribe" {
                c.streams.formUnion(streams)
                // Give new subscribers the current value right away.
                if streams.contains("lid"), let a = lidAngle {
                    server.send(["type": "lid", "t": Clock.protocolMs(Clock.now()), "angle": a], to: c)
                }
                if streams.contains("light"), let v = hub.lightValue {
                    server.send(["type": "light", "t": Clock.protocolMs(Clock.now()), "value": Self.r4(v)], to: c)
                }
            } else {
                c.streams.subtract(streams)
            }
        case "pause":
            paused = true
            pausedReason = "user"
            sessions.stopAll(reason: "paused")
            server.broadcast(status())
        case "resume":
            paused = false
            pausedReason = nil
            limiter.reset()
            server.broadcast(status())
        case "calibration_start":
            let zones = (m["zones"] as? [String]) ?? config.zones.map(\.id)
            let target = (m["target"] as? NSNumber)?.intValue ?? 20
            negativesTimer?.cancel(); negativesTimer = nil
            let cal = CalibrationSession(zones: zones, target: target)
            calibration = cal
            server.broadcast(["type": "calibration", "phase": "started", "zones": cal.zones, "target": cal.target])
        case "calibration_zone":
            guard let cal = calibration else { return sendError("calibration_start first", to: c) }
            guard let zone = m["zone"] as? String, !zone.isEmpty, zone != "none" else { return sendError("calibration_zone needs a zone", to: c) }
            negativesTimer?.cancel(); negativesTimer = nil
            cal.beginZone(zone)
            server.broadcast(["type": "calibration", "phase": "capturing", "zone": zone,
                              "count": cal.counts[zone] ?? 0, "target": cal.target])
        case "calibration_negatives":
            guard let cal = calibration else { return sendError("calibration_start first", to: c) }
            let seconds = Int(((m["seconds"] as? NSNumber)?.doubleValue ?? 45).rounded())
            let clamped = max(1, min(600, seconds))
            cal.beginNegatives(seconds: Double(clamped), now: Clock.now())
            startNegativesCountdown(seconds: clamped)
        case "calibration_finish":
            finishCalibration(c)
        case "calibration_cancel":
            negativesTimer?.cancel(); negativesTimer = nil
            calibration = nil
            server.broadcast(["type": "calibration", "phase": "cancelled"])
        case "config_get":
            server.send(configMessage(), to: c)
        case "config_set":
            guard let obj = m["config"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: obj) else { return sendError("config_set needs a config object", to: c) }
            do {
                let new = try JSONDecoder().decode(Config.self, from: data)
                try store.save(new)
                config = new
                applyConfigToEngine()
                server.broadcast(configMessage())
                server.broadcast(status())
            } catch {
                sendError("invalid config: \(error)", to: c)
            }
        case "test_action":
            guard let a = m["action"] else { return sendError("test_action needs an action", to: c) }
            let action = JSONValue(any: a)
            let label = action["label"]?.string ?? "Test: \(action["kind"]?.string ?? "?")"
            let now = Clock.now()
            c.testActionTimes = c.testActionTimes.filter { now - $0 < 1 }
            guard c.testActionTimes.count < 2 else {
                return sendAction(t: now, bindingId: nil, label: label, ok: false, error: "rate limit: at most 2 test actions per second", replyTo: c)
            }
            c.testActionTimes.append(now)
            if case .tripped(let why) = limiter.admitGlobal(now: now) {
                tripRateLimit(why)
                return sendAction(t: now, bindingId: nil, label: label, ok: false, error: "rate limit: \(why); paused", replyTo: c)
            }
            runAction(action, bindingId: nil, label: label, t: now, replyTo: c)
        case "approve_action":
            // The app shows a native confirmation with the exact command before sending this.
            guard let a = m["action"] else { return sendError("approve_action needs an action", to: c) }
            let action = JSONValue(any: a)
            do {
                let h = try approvals.approve(action)
                Log.info("approved \(ActionRunner.describe(action))")
                server.send(["type": "approved", "hash": h, "kind": action["kind"]?.string ?? NSNull()], to: c)
            } catch {
                sendError("approve_action: \(error)", to: c)
            }
        case "revoke_action":
            let h = (m["hash"] as? String) ?? (m["action"]).flatMap { ApprovalStore.hash(JSONValue(any: $0)) }
            guard let h else { return sendError("revoke_action needs a hash or an action", to: c) }
            do {
                let found = try approvals.revoke(hash: h)
                server.send(["type": "revoked", "hash": h, "found": found], to: c)
            } catch {
                sendError("revoke_action: \(error)", to: c)
            }
        case "calibration_taptype_start":
            sessions.startTapCalibration(types: m["types"] as? [String], target: (m["target"] as? NSNumber)?.intValue, client: c)
        case "calibration_taptype_cancel":
            sessions.cancelTapCalibration()
        // Test-only hooks, reachable only with --no-hardware-sessions: they inject events at the points where the
        // IMU engine, the sound processor and the camera would, so dry-run tests can exercise those paths.
        case "sim_tap" where options.noHardwareSessions:
            let t = Clock.now()
            if sessions.tapCalibrating { sessions.tapCandidate(t: t); break }
            // An accepted IMU tap and its immediate "tap" gesture, exactly as the engine reports them.
            let zone = (m["zone"] as? String) ?? "right-grille"
            let msg: [String: Any] = ["type": "tap", "t": Clock.protocolMs(t), "zone": zone, "confidence": 0.95,
                                      "x": 0.9, "y": 0.3, "strength": 0.5, "source": "imu"]
            if !sessions.imuTap(t: t, zone: zone, message: msg) { server.broadcast(msg, stream: "taps") }
            let g = GestureEvent(t: t, gesture: "tap", zone: zone, zones: [zone], modifiers: [], confidence: 0.95)
            if !sessions.holdTapGesture(t: t, zone: zone, release: { [weak self] in self?.onGesture(g) }) { onGesture(g) }
        case "sim_tap_type" where options.noHardwareSessions:
            sessions.simulateTapType(m["tapType"] as? String)
        case "sim_air" where options.noHardwareSessions:
            sessions.simulateAir(phase: (m["phase"] as? String) ?? "changed", dx: (m["dx"] as? NSNumber)?.doubleValue ?? 0,
                                 dy: (m["dy"] as? NSNumber)?.doubleValue ?? 0)
        case "catalog_get":
            server.send(["type": "catalog", "catalog": catalog], to: c)
        case "sound_session_start":
            sessions.startSound(seconds: (m["seconds"] as? NSNumber)?.doubleValue, client: c)
        case "sound_session_stop":
            sessions.stopSound(reason: "requested")
        case "air_session_start":
            sessions.startAir(seconds: (m["seconds"] as? NSNumber)?.doubleValue, camera: m["camera"] as? String, client: c)
        case "air_session_stop":
            sessions.stopAir(reason: "requested")
        case "request_permission":
            guard (m["which"] as? String) == "accessibility" else { return sendError("unknown permission", to: c) }
            // The system prompt must not be spammable.
            guard Clock.now() - lastPermissionPrompt > 10 else { return server.send(hello(), to: c) }
            lastPermissionPrompt = Clock.now()
            DispatchQueue.main.async { [weak self] in
                let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                let trusted = AXIsProcessTrustedWithOptions(opts)
                self?.core.async {
                    guard let self else { return }
                    self.lastAccessibility = trusted
                    self.server.send(self.hello(), to: c)
                }
            }
        default:
            sendError("unknown message type: \(type)", to: c)
        }
    }

    private func sendError(_ message: String, to c: WebSocketServer.Client) {
        server.send(["type": "error", "message": message], to: c)
    }

    // MARK: Outgoing snapshots

    private func hello() -> [String: Any] {
        let p = hub.present
        return ["type": "hello", "version": Self.version,
                "device": ["model": device.model, "chip": device.chip, "family": device.family],
                // sound / camera: the hardware exists (checked without opening the mic or camera).
                "sensors": ["imu": p.contains(.accel), "gyro": p.contains(.gyro), "lid": p.contains(.lid), "light": p.contains(.light),
                            "sound": SessionCoordinator.soundHardware, "camera": SessionCoordinator.cameraHardware],
                "permissions": ["accessibility": AXIsProcessTrusted(),
                                "microphone": SoundSession.permission, "camera": AirSession.permission]]
    }

    private func status() -> [String: Any] {
        let labels = (engine.model?.labels ?? []).filter { $0 != "none" }
        return ["type": "status", "paused": paused, "calibrated": !labels.isEmpty, "zones": labels,
                // Addition to PROTOCOL.md: why the daemon is paused ("user" or "rate_limit"), null when running.
                "pausedReason": paused ? (pausedReason ?? "user") : NSNull(),
                "imuHz": Int(imuHz.rounded()),
                // Addition to PROTOCOL.md: live onset detector state, all in milli-g.
                "detector": ["noiseFloorMg": Self.r4(engine.noiseFloor * 1000), "thresholdMg": Self.r4(engine.onsetThreshold * 1000),
                             "level": Self.r4(engine.level * 1000)]]
    }

    private func configMessage() -> [String: Any] {
        let data = (try? JSONEncoder().encode(config)) ?? Data("{}".utf8)
        let obj = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
        return ["type": "config", "config": obj]
    }

    private func applyConfigToEngine() {
        // The engine reads settings (sensitivity, gates, windows) on every sample, so this takes effect immediately.
        engine.settings = config.settings.detection
        applyZoneCenters()
        engine.zonesNeedingMultiTap = config.zonesNeedingMultiTap
        Log.debug("zones needing multi-tap: \(config.zonesNeedingMultiTap.sorted())")
    }

    /// Tap x,y comes from the zone centres, so the configured zone rectangles must reach the model (converted to
    /// deck-plane centres per surface: edges at x 0/1, lid at the hinge, front lip at y 1).
    private func applyZoneCenters() {
        engine.model?.setZoneCenters(config.zoneCenters)
    }

    private static func r4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
}

// MARK: - Session host

extension Daemon: SessionHost {
    var currentConfig: Config { config }
    var isPaused: Bool { paused }
    var currentLidAngle: Double? { lidAngle }
    var deviceFamily: String { device.family }
    var typingActive: Bool {
        input.snapshot(now: Clock.now()).key * 1000 < config.settings.typingGateMs
    }

    func broadcast(_ message: [String: Any], stream: String?) { server.broadcast(message, stream: stream) }
    func deliverAir(_ message: [String: Any]) { onAir(message) }
    func send(_ message: [String: Any], to client: WebSocketServer.Client) { server.send(message, to: client) }

    func deliverGesture(name: String, t: Double, zone: String?, confidence: Double, extra: [String: Any]) {
        let g = GestureEvent(t: t, gesture: name, zone: zone, zones: zone.map { [$0] } ?? [],
                             modifiers: InputMonitor.currentModifiers(), confidence: confidence)
        onGesture(g, extra: extra)
    }
}
