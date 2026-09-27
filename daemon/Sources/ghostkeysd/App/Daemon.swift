import Foundation
import AppKit
import ApplicationServices
import GhostkeysDetection
import GhostkeysIntegrations

/// Wires sensors, detection, the WebSocket server, config, calibration and actions together.
/// Every piece of mutable state here is touched only on `core`.
final class Daemon: @unchecked Sendable {
    static let version = "0.1.0"
    static let streams: Set<String> = ["imu", "lid", "light", "taps", "air", "debug"]

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
    /// hover_level / finger_slide slider in progress (see SliderSpec).
    private struct SliderState { var binding: Binding; var spec: SliderSpec; var gesture: String; var applied = 0
                                 var travel = 0.0; var last = 0.0 }
    private var slider: SliderState?
    private var lastSonarSuppress = 0.0
    private var motionGate = MotionGate()
    private lazy var catalog: Any = (try? JSONSerialization.jsonObject(with: Data(IntegrationCatalog.json.utf8))) ?? [:]

    private var config: Config
    private let engine: TapEngine
    /// Same detection with the input gates bypassed and no model: its candidates are every onset "before the gates",
    /// which gives rejections a zone guess and feeds the debug stream.
    private let shadow: TapEngine
    private let diag = DiagnosticsRecorder()
    private struct SeenCandidate { var t: Double; var features: TapFeatures; var zone: String; var confidence: Double; var outcome: String }
    private var recentCandidates: [SeenCandidate] = []
    private var lastAccepted: SeenCandidate?
    private var feedbackTimes: [Double] = []
    private var lastExport = -100.0
    private lazy var learner = UseLearner(modelDirectory: store.modelDirectory)
    private var lastTapAt = -1000.0
    private var lastUnfamiliar = false
    /// Every retrain takes the next generation when it starts; a result is installed only if no newer retrain has been
    /// installed meanwhile, so a slow older retrain can never overwrite a newer model (VERIFY_01 note).
    private var modelGeneration = 0
    private var installedGeneration = 0
    private var cmdZWasDown = false
    /// Test-only (--no-hardware-sessions): the next rebuildModel waits this long before installing.
    private var testRetrainDelay = 0.0
    private var learnedTapTimes: [Double] = []
    private var lastLearnTick = 0.0
    private var lastUndoCheck = 0.0
    private var adapting = false
    /// Raw IMU windows around each captured calibration tap (written to model/raw/<session>.gkrec at the end).
    private var calRaw: (session: String, samples: [DiagnosticsRecorder.Sample], segments: [GkrecSegment])?
    /// The recommendation from the last calibration, until applied or replaced.
    private var pendingRecommendation: ZoneRecommendation?
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
    private var powerObservers: [NSObjectProtocol] = []

    init(options: Options) throws {
        self.options = options
        token = try SessionToken(directory: store.directory)
        approvals = ApprovalStore(directory: store.directory)
        actions = ActionRunner(dryRun: options.dryRun, approvals: approvals)
        server = WebSocketServer(port: options.port, queue: core, token: token)
        ZoneDefaults.warnIfStale()
        config = store.loadConfig(family: device.family)
        engine = TapEngine(settings: config.settings.detection)
        shadow = TapEngine(settings: config.settings.detection)
        shadow.bypassInputGates = true
        shadow.tiltEnabled = false
        engine.model = store.loadModel()
        applyConfigToEngine()   // also sets the model's zone centres
        actions.isPaused = { [weak self] in self?.paused ?? true }
        sessions = SessionCoordinator(queue: core, simulate: options.noHardwareSessions,
                                      modelDirectory: store.modelDirectory, host: self)
    }

    // MARK: Lifecycle

    func start() throws {
        // sonar_debug (~10 Hz while a sonar session runs) goes to "debug" subscribers only.
        let server = self.server
        SoundSession.debugWanted = { server.hasSubscribers("debug") }
        SoundSession.debugSink = { server.broadcast($0, stream: "debug") }
        input.onActivate = { [weak self] id in self?.core.async { self?.sessions.frontmostChanged(to: id) } }
        input.start()
        lastAccessibility = AXIsProcessTrusted()

        server.onConnect = { [weak self] c in self?.greet(c) }
        server.onMessage = { [weak self] c, m in self?.handle(m, from: c) }
        try server.start()

        let handlers = SensorHub.Handlers(
            imu: { [weak self] s in self?.core.async { self?.onIMU(s) } },
            lid: { [weak self] a, t in self?.core.async { self?.onLid(a, t: t) } },
            light: { [weak self] v, _, t in self?.core.async { self?.onLight(v, t: t) } })
        if options.simulateSensors { hub.startSimulated(handlers: handlers) } else { hub.start(handlers: handlers) }

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

        // Sonar tones stop while the Mac or its display sleeps, and come back after.
        let ws = NSWorkspace.shared.notificationCenter
        let pairs: [(Notification.Name, (SessionCoordinator) -> Void)] = [
            (NSWorkspace.willSleepNotification, { $0.setSystemAsleep(true) }),
            (NSWorkspace.didWakeNotification, { $0.setSystemAsleep(false) }),
            (NSWorkspace.screensDidSleepNotification, { $0.setDisplayAsleep(true) }),
            (NSWorkspace.screensDidWakeNotification, { $0.setDisplayAsleep(false) }),
        ]
        for (name, apply) in pairs {
            powerObservers.append(ws.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                guard let self else { return }
                self.core.async { apply(self.sessions) }
            })
        }
        // Sonar is a setting: if it is on, it starts with the daemon.
        core.async { [weak self] in self?.sessions.syncSonar(trigger: "startup") }
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
                                   lidAngle: lidAngle, paused: capturing ? false : paused,
                                   secondsSinceKeyUp: snap.keyUp, secondsSinceModifierChange: snap.modifierChange)

        diag.record(s, sinceKey: snap.key, sinceMouse: snap.mouse, modifiers: snap.modifiers, sinceKeyUp: snap.keyUp)
        learnFromUseTick(now: s.t)
        // SonarField: typing (the typing gate) and the laptop itself moving make Doppler and phase noise. Keystrokes
        // pause sonar for 0.45 s; motion (MotionGate, not a level threshold) pauses it while moving and 0.3 s after.
        motionGate.process(s.a, t: s.t)
        var sonarUntil = -Double.infinity
        if snap.key * 1000 < config.settings.typingGateMs || snap.keyUp < 0.15 { sonarUntil = s.t + 0.45 }
        if s.t - motionGate.lastMoving <= 0.3 { sonarUntil = max(sonarUntil, motionGate.lastMoving + 0.3) }
        if sonarUntil > s.t, s.t - lastSonarSuppress > 0.05 {
            lastSonarSuppress = s.t
            sessions.suppressSonar(until: sonarUntil)
        }
        // Shadow pass first: every onset that survives the motion gate becomes a classified candidate.
        var fresh: [SeenCandidate] = []
        let shadowCtx = InputContext(secondsSinceKey: snap.key, secondsSinceMouse: snap.mouse, modifiers: snap.modifiers,
                                     lidAngle: lidAngle, paused: false,
                                     secondsSinceKeyUp: snap.keyUp, secondsSinceModifierChange: snap.modifierChange)
        for e in shadow.ingest(s, context: shadowCtx) {
            guard case .candidate(let f) = e else { continue }
            motionGate.freeze(until: f.t + 0.15)       // a tap's own rocking is not "the laptop moving"
            let r = engine.model?.classify(f) ?? (zone: "none", confidence: 0, x: 0.5, y: 0.5)
            fresh.append(SeenCandidate(t: f.t, features: f, zone: r.zone, confidence: r.confidence, outcome: "pending"))
        }
        func shadowIndex(_ t: Double) -> Int? { fresh.firstIndex { abs($0.t - t) < 1e-4 } }

        for event in engine.ingest(s, context: context) {
            switch event {
            case .candidate(let f):
                captureCandidate(f, now: now)
                if sessions.tapCalibrating { sessions.tapCandidate(t: f.t) }
            case .rejected(let t, let reason):
                var msg: [String: Any] = ["type": "rejected", "t": Clock.protocolMs(t), "reason": reason.rawValue]
                if let i = shadowIndex(t) {
                    fresh[i].outcome = reason.rawValue
                    if engine.model != nil {        // the classifier's best guess, so the Sensors screen can show why
                        msg["zone"] = fresh[i].zone
                        msg["confidence"] = Self.r4(fresh[i].confidence)
                    }
                    msg["strength"] = Self.r4(fresh[i].features[.strength])
                }
                diag.note(t, "rejected \(reason.rawValue)" + ((msg["zone"] as? String).map { " zone=\($0)" } ?? ""))
                server.broadcast(msg, stream: "taps")
            case .tap(let tap):
                lastTapAt = tap.t
                if let i = shadowIndex(tap.t) {
                    fresh[i].outcome = "accepted"
                    lastAccepted = fresh[i]
                    lastAccepted?.zone = tap.zone
                }
                diag.note(tap.t, "tap zone=\(tap.zone) confidence=\(Self.r4(tap.confidence))")
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

        if engine.isUnfamiliar != lastUnfamiliar {
            lastUnfamiliar = engine.isUnfamiliar
            server.broadcast(["type": "detection_state", "unfamiliar": lastUnfamiliar])
            Log.info(lastUnfamiliar ? "taps look unfamiliar: only clear taps fire until they look like the calibration again"
                                    : "taps look familiar again")
        }
        if !fresh.isEmpty {
            for c in fresh {
                if c.outcome == "pending" { diag.note(c.t, "candidate zone=\(c.zone) (no decision: calibration or paused)") }
                if server.hasSubscribers("debug") {
                    server.broadcast(["type": "candidate", "t": Clock.protocolMs(c.t), "zone": engine.model == nil ? NSNull() : c.zone as Any,
                                      "confidence": Self.r4(c.confidence), "strength": Self.r4(c.features[.strength]),
                                      "outcome": c.outcome], stream: "debug")
                }
            }
            recentCandidates.append(contentsOf: fresh)
            if recentCandidates.count > 60 { recentCandidates.removeFirst(recentCandidates.count - 60) }
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
        // `bound`: an enabled binding would fire for this gesture (the HUD shows only these; the Sensors screen all).
        let calibrating = calibration != nil || sessions.tapCalibrating
        let zoneDisabled = (g.zone.map { disabledZones.contains($0) } ?? false) || g.zones.contains { disabledZones.contains($0) }
        let resolved = zoneDisabled ? nil : BindingResolver.resolve(g, bindings: config.bindings, app: app)
        msg["bound"] = resolved != nil && !calibrating
        server.broadcast(msg)
        // No actions while calibrating: the user is tapping zones (or tap types) on purpose.
        guard !calibrating else { return }
        // A disabled zone never fires (its taps are also left out of the model).
        guard let binding = resolved else { return }
        let label = binding.label ?? binding.id
        // A pinch_hold binding with a knob fires per step of travel (see onAir), not when the hold begins.
        if g.gesture == "pinch_hold", let spec = binding.knob {
            knob = (binding, spec, 0)
            return
        }
        // A continuous sonar gesture with a slider fires per step of travel (see onAir), not when it begins.
        if let spec = binding.slider, g.gesture == "hover_level" || g.gesture == "finger_slide" {
            slider = SliderState(binding: binding, spec: spec, gesture: g.gesture)
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
        // Learn from use: the taps behind this gesture become confirmed if the action succeeds and nothing undoes it.
        var pendingID: Int?
        if config.settings.learnFromUse, engine.model != nil {
            let zones = Set(g.zones + [g.zone].compactMap { $0 })
            // A "tap" is exactly its own tap; double / triple / rhythm / sequence take the taps just before them.
            // Taps already registered by an earlier gesture are never counted twice.
            let taps = recentCandidates.filter { c in
                guard c.outcome == "accepted", zones.contains(c.zone), !learnedTapTimes.contains(where: { abs($0 - c.t) < 0.005 }) else { return false }
                return g.gesture == "tap" ? abs(c.t - g.t) < 0.02 : (c.t >= g.t - 1.2 && c.t <= g.t + 0.05)
            }
            learnedTapTimes = (learnedTapTimes + taps.map(\.t)).filter { g.t - $0 < 5 }
            // Only taps from familiar conditions teach (DETECTION_AUDIT 6.5): not while the engine finds taps
            // unfamiliar, and each within 1.5x the model's typical distance.
            let model = engine.model!
            let familiar = engine.isUnfamiliar ? [] : taps.filter { c in
                guard let typical = model.typicalDistance, typical > 0 else { return false }
                return model.classifyDetailed(c.features).distance <= 1.5 * typical
            }
            pendingID = learner.register(taps: familiar.map { ($0.t, $0.zone, $0.confidence, $0.features) },
                                         minConfidence: config.settings.minConfidence)
        }
        // Gesture actions are dropped if they would start more than 1 s late (stale).
        runAction(binding.action, bindingId: binding.id, label: label, t: g.t, maxAge: 1,
                  onResult: pendingID.map { id in { [weak self] ok in self?.learner.actionFinished(id: id, ok: ok) } })
    }

    /// Continuous camera messages: forwarded to `air` subscribers and, for pinch_hold, drive an active knob.
    /// One step of a knob or slider: runs `action` (positive) or `inverse`, through the knob limiter (never pauses).
    @discardableResult
    private func fireStep(_ b: Binding, positive: Bool, inverse: JSONValue?) -> Bool {
        guard let action = positive ? b.action : inverse else { return false }
        let id = b.id + (positive ? "" : "#inverse")
        guard limiter.admitKnobStep(bindingId: id, now: Clock.now()) else { return false }
        runAction(action, bindingId: id, label: (b.label ?? b.id) + (positive ? " +" : " -"), t: Clock.now(), maxAge: 0.3)
        return true
    }

    /// hover_level / finger_slide: start a slider at `began` (through the normal gesture path, so bindings, app and
    /// modifiers resolve as usual), then step it on every change.
    private func onSliderAir(_ msg: [String: Any], gesture: String, phase: String) {
        if phase == "began" {
            slider = nil
            var zone: String? = "air"
            if gesture == "finger_slide", let side = msg["side"] as? String {
                zone = config.zones.contains { $0.id == "\(side)-grille" } ? "\(side)-grille" : nil
            }
            var extra: [String: Any] = ["source": "sonar"]
            if let side = msg["side"] { extra["side"] = side }
            let t = (msg["t"] as? Double).map { Clock.start + $0 / 1000 } ?? Clock.now()
            onGesture(GestureEvent(t: t, gesture: gesture, zone: zone, zones: zone.map { [$0] } ?? [],
                                   modifiers: InputMonitor.currentModifiers(), confidence: msg["confidence"] as? Double ?? 0.9),
                      extra: extra)
            return
        }
        guard var s = slider, s.gesture == gesture else { return }
        // Hover: displacement since began (positive = hand raised). Finger slide: dyMm (positive = toward the hinge).
        let measure = gesture == "hover_level" ? (msg["displacementMm"] as? Double ?? 0) : (msg["dyMm"] as? Double ?? 0)
        if phase == "ended" {
            // absolute mode: a cancelled gesture (typing, interference) was not meant, so undo what it did.
            if s.spec.mode == "absolute", (msg["cancelled"] as? Bool) == true, s.applied != 0, !paused {
                let undoPositive = s.applied < 0
                for _ in 0..<min(abs(s.applied), 16) { fireStep(s.binding, positive: undoPositive, inverse: s.spec.inverse) }
            }
            slider = nil
            return
        }
        guard !paused else { return }
        let step = s.spec.stepMm
        var fired = 0
        if s.spec.mode == "absolute" {
            // measure can come from a message (sim_sonar) and be huge: clamp before converting (at most 10000 steps).
            guard let target = SafeNumbers.int((measure / step).rounded(.towardZero), in: -10_000...10_000) else { slider = s; return }
            while s.applied != target && fired < 8 {
                let up = target > s.applied
                if fireStep(s.binding, positive: up, inverse: s.spec.inverse) { s.applied += up ? 1 : -1 }
                else if (up ? s.binding.action : s.spec.inverse) == nil { s.applied += up ? 1 : -1 }   // no action that way
                else { break }                                                                             // limiter: retry later
                fired += 1
            }
        } else {
            s.travel += measure - s.last
            while abs(s.travel) >= step && fired < 8 {
                let up = s.travel > 0
                s.travel -= up ? step : -step
                fireStep(s.binding, positive: up, inverse: s.spec.inverse)
                fired += 1
            }
        }
        s.last = measure
        slider = s
    }

    private func onAir(_ msg: [String: Any]) {
        server.broadcast(msg, stream: "air")
        if let g = msg["gesture"] as? String, g == "hover_level" || g == "finger_slide", let phase = msg["phase"] as? String {
            return onSliderAir(msg, gesture: g, phase: phase)
        }
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
                           replyTo: WebSocketServer.Client? = nil, onResult: ((Bool) -> Void)? = nil) {
        guard !paused else {
            onResult?(false)
            if let bindingId { limiter.finished(bindingId: bindingId) }
            sendAction(t: t, bindingId: bindingId, label: label, ok: false, error: "paused", replyTo: replyTo)
            return
        }
        let replyID = replyTo?.id
        actions.run(action, maxAge: maxAge) { [weak self] ok, error in
            self?.core.async {
                guard let self else { return }
                if let bindingId { self.limiter.finished(bindingId: bindingId) }
                onResult?(ok)
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

    /// Calibration capture. Zone and doubles taps are decided 0.3 s later: a candidate with a key press or release,
    /// or any pointer event, within 150 ms either side is dropped (it may be the key or the click, not a tap on the
    /// zone). Negatives are captured at once. A raw window around every candidate is kept either way.
    private func captureCandidate(_ f: TapFeatures, now: Double) {
        guard let cal = calibration else { return }
        switch cal.phase {
        case .idle:
            return
        case .negatives:
            saveRawWindow(t: f.t, label: "none")
            _ = cal.addNegative(f, now: now)
        case .capturing(let zone):
            guard (cal.counts[zone] ?? 0) < cal.target else { return }
            saveRawWindow(t: f.t, label: zone)
            decideLater(f) { [weak self] in
                guard let self, let count = cal.addZoneTap(f, zone: zone) else { return }
                self.server.broadcast(["type": "calibration", "phase": "capturing", "zone": zone, "count": count, "target": cal.target])
                if count >= cal.target, cal.phase == .capturing(zone: zone) { cal.endPhase() }
            } dropped: { [weak self] in
                self?.server.broadcast(["type": "calibration", "phase": "capturing", "zone": zone, "count": cal.counts[zone] ?? 0,
                                        "target": cal.target, "dropped": "key or pointer event within 150 ms"])
            }
        case .doubles(let zone, let target):
            saveRawWindow(t: f.t, label: zone)
            decideLater(f) { [weak self] in
                guard let self, self.calibration === cal, cal.phase == .doubles(zone: zone, target: target) else { return }
                let r = cal.addDoubleTap(f, zone: zone, t: f.t)
                var m: [String: Any] = ["type": "calibration", "phase": "doubles", "zone": zone, "count": r.pairs, "target": target]
                if let gap = r.gap { m["lastGapMs"] = (gap * 1000).rounded() }
                self.server.broadcast(m)
                if r.pairs >= target { self.finishDoubles(cal, zone: zone) }
            } dropped: { [weak self] in
                self?.server.broadcast(["type": "calibration", "phase": "doubles", "zone": zone, "count": cal.pairs[zone] ?? 0,
                                        "target": target, "dropped": "key or pointer event within 150 ms"])
            }
        }
    }

    private func decideLater(_ f: TapFeatures, keep: @escaping () -> Void, dropped: @escaping () -> Void) {
        core.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.calibration != nil else { return }
            if self.diag.inputNear(f.t, radius: 0.15) { dropped() } else { keep() }
        }
    }

    /// Enough doubles: the user's own rhythm sets the double-tap window (90th percentile of their gaps + 80 ms).
    private func finishDoubles(_ cal: CalibrationSession, zone: String) {
        cal.endPhase()
        var m: [String: Any] = ["type": "calibration", "phase": "doubles_done", "zone": zone,
                                "gapsMs": cal.gaps.map { ($0 * 1000).rounded() }]
        if let ms = cal.suggestedDoubleWindowMs {
            var new = config
            new.settings.doubleWindowMs = ms
            do {
                try store.save(new)
                config = new
                applyConfigToEngine()
                server.broadcast(configMessage())
                m["doubleWindowMs"] = ms
                Log.info("double-tap window set to \(Int(ms)) ms from \(cal.gaps.count) measured doubles")
            } catch {
                m["error"] = "could not save the new double-tap window: \(Self.plainError(error))"
            }
        }
        server.broadcast(m)
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
        flushRawCalibration()
        server.broadcast(["type": "calibration", "phase": "training"])
        // Partial recalibration merges (VERIFY_01 bug 2): only the zones captured in this session are replaced;
        // every other zone keeps its saved samples. New negatives are added to the old ones (newest 500 kept).
        let recalibrated = Set(cal.samples.map(\.label)).subtracting([ZoneModel.noneLabel])
        var merged = store.loadSamples().filter { !recalibrated.contains($0.label) } + cal.samples
        let noneIdx = merged.indices.filter { merged[$0].label == ZoneModel.noneLabel }
        if noneIdx.count > 500 { let drop = Set(noneIdx.prefix(noneIdx.count - 500)); merged = merged.indices.filter { !drop.contains($0) }.map { merged[$0] } }
        let samples = merged
        let disabled = disabledZones
        let gen = nextGeneration()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // Disabled zones are left out of the model; their samples stay in samples.json for later.
            let trainer = Trainer()
            for s in samples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            let rec = trainer.recommendedZones()
            self?.core.async {
                guard let self else { return }
                guard self.isCurrent(gen, what: "calibration") else { return }
                do {
                    try self.store.saveModel(model, report: report)
                    try self.store.saveSamples(samples)
                } catch {
                    // Could not save (read-only or full disk): keep the previous model, say so plainly.
                    Log.error("calibration could not be saved (\(error)); keeping the previous model")
                    self.server.broadcast(["type": "calibration", "phase": "failed",
                                           "reason": "the new calibration could not be saved (\(Self.plainError(error))); the previous model is still in use",
                                           "overall": report.overall, "labels": report.labels])
                    return
                }
                self.installedGeneration = gen
                // What use taught about the recalibrated zones no longer applies; other zones keep theirs.
                self.learner.discard(labels: recalibrated, reason: "zones recalibrated")
                self.engine.model = model
                self.applyZoneCenters()
                self.pendingRecommendation = rec
                self.server.broadcast(["type": "calibration", "phase": "done", "accuracy": report.accuracy,
                                       "overall": report.overall, "confusion": report.confusion, "labels": report.labels,
                                       "recalibrated": recalibrated.sorted(),
                                       "recommendation": Self.recommendationJSON(rec),
                                       "peaks": Self.peaksJSON(model)])
                self.server.broadcast(self.status())
                Log.info("calibration done: recalibrated \(recalibrated.sorted()), overall accuracy \(report.overall), labels \(report.labels)")
            }
        }
    }

    private func nextGeneration() -> Int { modelGeneration += 1; return modelGeneration }

    /// True if a retrain started as generation `gen` may still be installed (no newer one was installed meanwhile).
    private func isCurrent(_ gen: Int, what: String) -> Bool {
        guard gen > installedGeneration else {
            Log.info("discarded a stale \(what) retrain (generation \(gen) finished after generation \(installedGeneration) was installed)")
            return false
        }
        return true
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
            sessions.syncSonar(trigger: "resume", userInitiated: true)
        case "calibration_start":
            let zones = (m["zones"] as? [String]) ?? config.zones.map(\.id)
            guard let target = SafeNumbers.field(m["target"], in: 1...500, default: 20) else {
                return sendError("calibration_start: target must be a finite number (1 to 500)", to: c)
            }
            let posture = (m["posture"] as? String) ?? "desk"
            guard CalibrationSession.postures.contains(posture) else { return sendError("posture must be desk, lap or stand", to: c) }
            negativesTimer?.cancel(); negativesTimer = nil
            flushRawCalibration()
            let cal = CalibrationSession(zones: zones, target: target, posture: posture)
            calibration = cal
            calRaw = (Self.stamp(), [], [])
            // TODO(per-posture models, DETECTION_AUDIT 6.7): one model per posture needs a ZoneModelSet with gravity
            // vectors and a public gravity accessor on TapEngine in the detection library. Samples already carry
            // their posture, so the models can be split once that exists.
            server.broadcast(["type": "calibration", "phase": "started", "zones": cal.zones, "target": cal.target, "posture": posture])
        case "calibration_zone":
            guard let cal = calibration else { return sendError("calibration_start first", to: c) }
            guard let zone = m["zone"] as? String, !zone.isEmpty, zone != "none" else { return sendError("calibration_zone needs a zone", to: c) }
            let strength = m["strength"] as? String
            if let strength, !CalibrationSession.strengths.contains(strength) { return sendError("strength must be soft or firm", to: c) }
            negativesTimer?.cancel(); negativesTimer = nil
            cal.beginZone(zone, strength: strength)
            server.broadcast(["type": "calibration", "phase": "capturing", "zone": zone,
                              "count": cal.counts[zone] ?? 0, "target": cal.target, "strength": strength ?? NSNull()])
        case "calibration_doubles":
            guard let cal = calibration else { return sendError("calibration_start first", to: c) }
            guard let zone = m["zone"] as? String, !zone.isEmpty, zone != "none" else { return sendError("calibration_doubles needs a zone", to: c) }
            guard let count = SafeNumbers.field(m["count"], in: 1...50, default: 8) else {
                return sendError("calibration_doubles: count must be a finite number (1 to 50)", to: c)
            }
            negativesTimer?.cancel(); negativesTimer = nil
            cal.beginDoubles(zone, target: count)
            server.broadcast(["type": "calibration", "phase": "doubles", "zone": zone, "count": cal.pairs[zone] ?? 0,
                              "target": max(1, min(50, count))])
        case "calibration_negatives":
            guard let cal = calibration else { return sendError("calibration_start first", to: c) }
            guard let clamped = SafeNumbers.field(m["seconds"], in: 1...600, default: 45) else {
                return sendError("calibration_negatives: seconds must be a finite number (1 to 600)", to: c)
            }
            cal.beginNegatives(seconds: Double(clamped), now: Clock.now())
            startNegativesCountdown(seconds: clamped)
        case "calibration_finish":
            finishCalibration(c)
        case "calibration_apply_recommendation":
            applyRecommendation(client: c)
        case "calibration_apply_merge":
            applyMerge(zones: m["zones"] as? [String], name: m["name"] as? String, client: c)
        case "calibration_cancel":
            negativesTimer?.cancel(); negativesTimer = nil
            calibration = nil
            flushRawCalibration()
            server.broadcast(["type": "calibration", "phase": "cancelled"])
        case "config_get":
            server.send(configMessage(), to: c)
        case "config_set":
            guard let obj = m["config"] as? [String: Any],
                  let data = try? JSONSerialization.data(withJSONObject: obj) else { return sendError("config_set needs a config object", to: c) }
            do {
                let new = try JSONDecoder().decode(Config.self, from: data)
                try store.save(new)
                let disabledBefore = disabledZones
                config = new
                if disabledZones != disabledBefore { rebuildModel(reason: "enabled zones changed") }
                applyConfigToEngine()
                server.broadcast(configMessage())
                server.broadcast(status())
                sessions.settingsChanged(client: c)
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
            guard let ttTarget = SafeNumbers.field(m["target"], in: 3...50, default: 15) else {
                return sendError("calibration_taptype_start: target must be a finite number (3 to 50)", to: c)
            }
            sessions.startTapCalibration(types: m["types"] as? [String], target: ttTarget, client: c)
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
            // Pretend the engine accepted it, with the features of a saved sample for that zone (for feedback_false tests).
            if let sample = store.loadSamples().last(where: { $0.label == zone }) {
                var values = sample.features.values
                if let k = (m["strengthScale"] as? NSNumber)?.doubleValue, k > 0 { values[FeatureIndex.strength.rawValue] += log10(k) }
                lastAccepted = SeenCandidate(t: t, features: TapFeatures(values: values, t: t), zone: zone,
                                             confidence: (m["confidence"] as? NSNumber)?.doubleValue ?? 0.95, outcome: "accepted")
                recentCandidates.append(lastAccepted!)
            }
            lastTapAt = t
            let g = GestureEvent(t: t, gesture: "tap", zone: zone, zones: [zone], modifiers: [], confidence: 0.95)
            if !sessions.holdTapGesture(t: t, zone: zone, release: { [weak self] in self?.onGesture(g) }) { onGesture(g) }
        case "sim_slow_retrain" where options.noHardwareSessions:
            testRetrainDelay = min(10, max(0, SafeNumbers.finite(m["seconds"]) ?? 2))
        case "sim_input_event" where options.noHardwareSessions:
            // Test-only: a pointer event `ago` seconds back, written into the buffered idle times.
            diag.markPointerEvent(at: Clock.now() - min(10, max(0, SafeNumbers.finite(m["ago"]) ?? 0)))
        case "sim_undo" where options.noHardwareSessions:
            learner.cancelLatest(reason: "Cmd+Z (simulated)")
        case "sim_adapt" where options.noHardwareSessions:
            // Test-only: run the idle retrain now (skips the 60 s idle wait, not the 10-confirmation minimum).
            adaptIfDue(ignoreIdle: true)
        case "sim_tap_type" where options.noHardwareSessions:
            sessions.simulateTapType(m["tapType"] as? String)
        case "sim_air" where options.noHardwareSessions:
            sessions.simulateAir(phase: (m["phase"] as? String) ?? "changed", dx: (m["dx"] as? NSNumber)?.doubleValue ?? 0,
                                 dy: (m["dy"] as? NSNumber)?.doubleValue ?? 0)
        case "feedback_missed", "feedback_false":
            // Rate limit first, so a refused feedback message has no side effects (VERIFY_01 bug 5).
            guard admitFeedback() else { return sendError("\(type): at most one every 2 s and 20 per minute", to: c) }
            // "That wasn't meant" undoes the taps of the last accepted tap's gesture; "I missed a tap" undoes nothing.
            if type == "feedback_false", let last = lastAccepted { learner.cancelGesture(containing: last.t, reason: type) }
            if type == "feedback_missed" { feedbackMissed(zone: m["zone"] as? String, client: c) } else { feedbackFalse(client: c) }
        case "diagnostics_export":
            guard Clock.now() - lastExport >= 5 else { return sendError("diagnostics_export: at most one every 5 s", to: c) }
            lastExport = Clock.now()
            let url = store.diagnosticsDirectory.appendingPathComponent("\(Self.stamp()).gkrec")
            do {
                let n = try diag.export(to: url, seconds: DiagnosticsRecorder.seconds, deviceModel: device.model,
                                        zones: config.zones.map(\.id))
                DiagnosticsRecorder.prune(store.diagnosticsDirectory)
                server.send(["type": "diagnostics", "path": url.path, "samples": n, "seconds": DiagnosticsRecorder.seconds], to: c)
            } catch {
                sendError("diagnostics_export: \(error)", to: c)
            }
        case "sim_spike" where options.noHardwareSessions:
            // With simulated sensors the transient goes through the live detector too; otherwise only into the buffer.
            if options.simulateSensors && (m["live"] as? Bool) == true { hub.injectSimulatedTap() } else {
                diag.injectSyntheticTap(ago: min(10, max(0, SafeNumbers.finite(m["ago"]) ?? 2.0)),
                                        scale: min(100, max(0, SafeNumbers.finite(m["scale"]) ?? 1)), mouseNear: (m["mouse"] as? Bool) ?? false)
            }
        case "catalog_get":
            server.send(["type": "catalog", "catalog": catalog], to: c)
        case "sound_session_start":
            sessions.startSound(seconds: (m["seconds"] as? NSNumber)?.doubleValue, client: c)
        case "sound_session_stop":
            sessions.stopSound(reason: "requested")
        case "sonar_session_start":
            sessions.startSonar(seconds: (m["seconds"] as? NSNumber)?.doubleValue, client: c)
        case "sonar_session_stop":
            // Sonar is a setting: stopping it turns the setting off (the tray and sidebar "Stop" use this).
            guard config.settings.sonar.enabled else { return sessions.settingsChanged(client: c) }
            var new = config
            new.settings.sonar.enabled = false
            do {
                try store.save(new)
                config = new
                Log.info("sonar turned off (sonar_session_stop)")
                server.broadcast(configMessage())
                sessions.settingsChanged(client: c)
            } catch {
                sendError("sonar_session_stop: could not save the setting: \(error)", to: c)
            }
        case "sim_sonar" where options.noHardwareSessions:
            // Test-only: SonarField output. {"gesture": "push", "side": "left"} or {"air": {...air message fields...}}
            var air = m["air"] as? [String: Any]
            if air != nil {
                air!["type"] = "air"; air!["source"] = "sonar"
                if air!["t"] == nil { air!["t"] = Clock.protocolMs(Clock.now()) }
            }
            sessions.simulateSonar(gesture: m["gesture"] as? String, air: air, side: m["side"] as? String,
                                   distanceMm: (m["distanceMm"] as? NSNumber)?.doubleValue)
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

    // MARK: Feedback (missed and false taps)

    private func admitFeedback() -> Bool {
        let now = Clock.now()
        feedbackTimes = feedbackTimes.filter { now - $0 < 60 }
        guard feedbackTimes.count < 20, (feedbackTimes.last.map { now - $0 >= 2 } ?? true) else { return false }
        feedbackTimes.append(now)
        return true
    }

    /// "I just tapped <zone> and nothing happened": save the last 3 s, replay it offline with the input gates off, take
    /// the best candidate the live detector did not accept, and add it to the training samples as that zone.
    private func feedbackMissed(zone: String?, client c: WebSocketServer.Client) {
        guard let zone, config.zones.contains(where: { $0.id == zone }) else {
            return sendError("feedback_missed needs a zone from the config", to: c)
        }
        let now = diag.samples(lastSeconds: 0).last?.t ?? Clock.now()
        let accepted = recentCandidates.filter { $0.outcome == "accepted" }.map(\.t)
        // Mouse / trackpad event times in the buffer (reconstructed from the idle times).
        let buffered = diag.samples(lastSeconds: FeedbackRule.lookBack + 0.5)
        var mouseTimes: [Double] = []
        for x in buffered where x.sinceMouse < 60 {
            let e = x.t - x.sinceMouse
            if mouseTimes.last.map({ abs($0 - e) > 0.005 }) ?? true { mouseTimes.append(e) }
        }
        let model = engine.model
        var verdicts: [[String: Any]] = []
        var best: (f: DiagnosticsRecorder.Found, p: Double)?
        for f in diag.offlineCandidates(settings: engine.settings, model: model, window: FeedbackRule.lookBack) {
            var v: [String: Any] = ["t": Clock.protocolMs(f.t), "strength": Self.r4(f.features[.strength])]
            let reject = FeedbackRule.check(f, zone: zone, now: now, accepted: accepted, mouseTimes: mouseTimes, model: model)
            if let why = reject.reason { v["skipped"] = why; verdicts.append(v); continue }
            v["probability"] = Self.r4(reject.probability)
            verdicts.append(v)
            if best == nil || reject.probability > best!.p { best = (f, reject.probability) }
        }

        let url = store.diagnosticsDirectory.appendingPathComponent("missed-\(zone)-\(Self.stamp()).gkrec")
        var saved: String?
        do {
            let seg = GkrecSegment(phase: "capture", zone: zone, start: now - FeedbackRule.lookBack, end: now,
                                   onsets: best.map { [$0.f.t] } ?? [], discarded: false, endedBy: "feedback")
            _ = try diag.export(to: url, seconds: FeedbackRule.lookBack, deviceModel: device.model, zones: config.zones.map(\.id),
                                segments: [seg], notes: ["feedback_missed zone=\(zone)"])
            DiagnosticsRecorder.prune(store.diagnosticsDirectory)
            saved = url.path
        } catch {
            Log.error("could not save the missed-tap diagnostic: \(error)")
        }

        var reply: [String: Any] = ["type": "feedback", "kind": "missed", "zone": zone, "found": best != nil,
                                    "diagnostic": saved ?? NSNull(), "candidates": verdicts]
        guard let best else {
            reply["retrained"] = false
            reply["reason"] = verdicts.isEmpty
                ? "no tap-like onset 0.7 to 5 s before the request (the tap may have been too soft)"
                : "no candidate passed the checks (see candidates); nothing was added"
            Log.info("feedback missed \(zone): nothing qualified (\(verdicts.count) candidates); diagnostic saved only")
            return server.send(reply, to: c)
        }
        let why = recentCandidates.first { abs($0.t - best.f.t) < 0.02 }?.outcome ?? "not seen live"
        reply["candidate"] = ["t": Clock.protocolMs(best.f.t), "zone": best.f.zone, "confidence": Self.r4(best.f.confidence),
                              "probability": Self.r4(best.p), "strength": Self.r4(best.f.features[.strength]),
                              "droppedBecause": why]
        // feedback_missed only ever adds a sample of the claimed zone (never "none").
        retrain(adding: best.f.features, label: zone, reply: reply, client: c)
    }

    /// The last accepted tap was not intended: add its features as "none" and retrain (nothing is undone).
    private func feedbackFalse(client c: WebSocketServer.Client) {
        guard let last = lastAccepted, Clock.now() - last.t < 60 else {
            return server.send(["type": "feedback", "kind": "false", "retrained": false,
                                "reason": "no accepted tap in the last 60 s"], to: c)
        }
        lastAccepted = nil
        var reply: [String: Any] = ["type": "feedback", "kind": "false", "zone": last.zone, "t": Clock.protocolMs(last.t)]
        // A tap at least as strong as this user's typical tap in that zone (its p50) was most likely meant: the
        // report is accepted and logged, but it does not teach the model "none".
        let peak = FeedbackRule.peakG(last.features)
        if let p50 = engine.model?.peakQuantiles?[last.zone]?[1], peak >= p50 {
            Log.info("feedback false on \(last.zone): strong tap (\(Self.r4(peak)) g >= p50 \(Self.r4(p50)) g); logged, not added")
            reply["retrained"] = false
            reply["reason"] = "that tap was as strong as your usual taps there, so it was probably intended; logged, not learned"
            reply["peakG"] = Self.r4(peak)
            return server.send(reply, to: c)
        }
        retrain(adding: last.features, label: "none", reply: reply, client: c)
    }

    /// Adds one labeled sample to the saved training set and retrains in the background.
    private func retrain(adding f: TapFeatures, label: String, reply base: [String: Any], client c: WebSocketServer.Client) {
        var reply = base
        var samples = store.loadSamples()
        let labels = Set(samples.map(\.label))
        guard !samples.isEmpty else {
            reply["retrained"] = false; reply["reason"] = "not calibrated yet: calibrate first, then feedback refines it"
            return server.send(reply, to: c)
        }
        guard label == "none" || labels.contains(label) else {
            reply["retrained"] = false; reply["reason"] = "zone \(label) is not calibrated"
            return server.send(reply, to: c)
        }
        samples.append(.init(label: label, features: TapFeatures(values: f.values, t: 0), kind: "feedback"))
        let replyID = c.id
        let disabled = disabledZones
        let confirmedSamples = config.settings.learnFromUse ? learner.asSamples : []
        let gen = nextGeneration()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let trainer = Trainer()
            for s in samples + confirmedSamples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            self?.core.async {
                guard let self else { return }
                if self.isCurrent(gen, what: "feedback") {
                    do {
                        try self.store.saveModel(model, report: report)
                        try self.store.saveSamples(samples)
                        self.installedGeneration = gen
                        self.engine.model = model
                        self.applyZoneCenters()
                        reply["retrained"] = true
                        reply["counts"] = trainer.counts
                        reply["overall"] = Self.r4(report.overall)
                        Log.info("feedback \(reply["kind"] ?? "?"): added a \(label) sample; accuracy \(report.overall)")
                    } catch {
                        reply["retrained"] = false
                        reply["reason"] = "could not save (\(Self.plainError(error))); the previous model is still in use"
                    }
                } else {
                    reply["retrained"] = false
                    reply["reason"] = "a newer retrain finished first; send the feedback again if it still applies"
                }
                if let client = self.server.clients[replyID] { self.server.send(reply, to: client) }
                self.server.broadcast(self.status())
            }
        }
    }

    private var disabledZones: Set<String> { Set(config.zones.filter { !$0.enabled }.map(\.id)) }

    /// Per zone p10 / p50 / p90 of the calibration taps' peak acceleration, in g (empty for older models).
    static func peaksJSON(_ model: ZoneModel) -> [String: Any] {
        (model.peakQuantiles ?? [:]).reduce(into: [String: Any]()) { out, kv in
            guard kv.value.count >= 3 else { return }
            let r = { (v: Double) in (v * 10000).rounded() / 10000 }
            out[kv.key] = ["p10": r(kv.value[0]), "p50": r(kv.value[1]), "p90": r(kv.value[2])]
        }
    }

    static func recommendationJSON(_ r: ZoneRecommendation) -> [String: Any] {
        ["keep": r.keep, "drop": r.drop, "merge": r.merge,
         "expectedAccuracy": r.expectedAccuracy.mapValues { ($0 * 1000).rounded() / 1000 }]
    }

    /// Retrains from the saved samples without the disabled zones (their samples are kept on disk, not relabeled).
    private func rebuildModel(reason: String, then done: ((CalibrationReport?) -> Void)? = nil) {
        let samples = store.loadSamples()
        guard !samples.isEmpty else { done?(nil); return }
        let disabled = disabledZones
        let confirmedSamples = config.settings.learnFromUse ? learner.asSamples : []
        let gen = nextGeneration()
        let delay = testRetrainDelay
        testRetrainDelay = 0
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let trainer = Trainer()
            for s in samples + confirmedSamples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            self?.core.async {
                guard let self else { return }
                guard self.isCurrent(gen, what: reason) else { done?(nil); return }
                do { try self.store.saveModel(model, report: report) } catch {
                    Log.error("could not save model (\(reason)): \(error); keeping the previous model")
                    done?(nil); return
                }
                self.installedGeneration = gen
                self.engine.model = model
                self.applyZoneCenters()
                Log.info("model rebuilt (\(reason)); zones \(report.labels.filter { $0 != "none" }), overall \(report.overall)")
                self.server.broadcast(self.status())
                done?(report)
            }
        }
    }

    /// `calibration_apply_recommendation`: disables the recommended drops in the config and retrains without them.
    private func applyRecommendation(client c: WebSocketServer.Client) {
        guard let rec = pendingRecommendation else { return sendError("no recommendation: finish a calibration first", to: c) }
        // Zones in a merge pair are not dropped: merging them (calibration_apply_merge) keeps them useful.
        let inMerge = Set(rec.merge.flatMap { $0 })
        let toDisable = rec.drop.keys.filter { !inMerge.contains($0) }.sorted()
        var new = config
        for i in new.zones.indices where toDisable.contains(new.zones[i].id) { new.zones[i].enabled = false }
        do { try store.save(new) } catch { return sendError("could not save config: \(error)", to: c) }
        config = new
        // Keep only the merge suggestions for later calibration_apply_merge calls.
        pendingRecommendation = rec.merge.isEmpty ? nil
            : ZoneRecommendation(keep: rec.keep, drop: [:], merge: rec.merge, expectedAccuracy: rec.expectedAccuracy)
        server.broadcast(configMessage())
        rebuildModel(reason: "recommendation applied") { [weak self] report in
            guard let self else { return }
            var m: [String: Any] = ["type": "calibration", "phase": "recommendation_applied",
                                    "disabled": toDisable, "keep": rec.keep, "mergeSuggested": rec.merge]
            if let report { m["overall"] = report.overall; m["accuracy"] = report.accuracy; m["labels"] = report.labels }
            self.server.broadcast(m)
        }
    }

    /// `calibration_apply_merge {zones: [a, b], name}`: two zones the classifier confuses become one. Their samples
    /// are relabeled to the new zone, the model is retrained, and bindings on either zone now point at the merged one.
    private func applyMerge(zones: [String]?, name: String?, client c: WebSocketServer.Client) {
        guard let zones, zones.count == 2, zones[0] != zones[1],
              let ia = config.zones.firstIndex(where: { $0.id == zones[0] }),
              let ib = config.zones.firstIndex(where: { $0.id == zones[1] }) else {
            return sendError("calibration_apply_merge needs two different zone ids from the config", to: c)
        }
        let a = config.zones[ia], b = config.zones[ib]
        let title = (name?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? "\(a.name) + \(b.name)"
        // New id: a slug of the name, unique among the other zones.
        var slug = title.lowercased().map { $0.isLetter || $0.isNumber ? String($0) : "-" }.joined()
            .split(separator: "-").joined(separator: "-")
        if slug.isEmpty { slug = "\(a.id)-\(b.id)" }
        let others = Set(config.zones.map(\.id)).subtracting([a.id, b.id])
        var id = slug, n = 2
        while others.contains(id) || id == "none" { id = "\(slug)-\(n)"; n += 1 }

        // Rect: union of both. Zones on different surfaces keep the first zone's surface (reported below).
        let x0 = min(a.rect.x, b.rect.x), y0 = min(a.rect.y, b.rect.y)
        let x1 = max(a.rect.x + a.rect.w, b.rect.x + b.rect.w), y1 = max(a.rect.y + a.rect.h, b.rect.y + b.rect.h)
        let merged = Zone(id: id, name: title, surface: a.surface, rect: ZoneRect(x: x0, y: y0, w: x1 - x0, h: y1 - y0),
                          color: a.color, enabled: true)
        var new = config
        new.zones[ia] = merged
        new.zones.removeAll { $0.id == b.id }

        // Bindings: anything on a or b now points at the merged zone.
        var changed: [[String: Any]] = []
        for i in new.bindings.indices {
            var bnd = new.bindings[i]
            var touched = false
            if let z = bnd.zone, z == a.id || z == b.id { bnd.zone = id; touched = true }
            if let zs = bnd.zones, zs.contains(where: { $0 == a.id || $0 == b.id }) {
                bnd.zones = zs.map { $0 == a.id || $0 == b.id ? id : $0 }; touched = true
            }
            guard touched else { continue }
            let old = new.bindings[i]
            changed.append(["id": bnd.id, "label": bnd.label ?? bnd.id, "gesture": bnd.gesture,
                            "from": old.zone ?? (old.zones ?? []).joined(separator: ","),
                            "to": bnd.zone ?? (bnd.zones ?? []).joined(separator: ",")])
            new.bindings[i] = bnd
        }
        // Two bindings that used to differ only by zone may now collide; only the first would ever fire.
        var seen: [String: String] = [:], conflicts: [[String]] = []
        for bnd in new.bindings where bnd.enabled {
            let key = [bnd.gesture, bnd.zone ?? "", (bnd.zones ?? []).joined(separator: ","),
                       bnd.modifiers.sorted().joined(separator: "+"), bnd.app].joined(separator: "|")
            if let first = seen[key] { conflicts.append([first, bnd.id]) } else { seen[key] = bnd.id }
        }

        // Samples: relabel both zones to the merged one (kept on disk for later retraining).
        var samples = store.loadSamples()
        let relabeled = samples.indices.filter { samples[$0].label == a.id || samples[$0].label == b.id }
        for i in relabeled { samples[i].label = id }
        learner.relabel([a.id, b.id], to: id)
        do {
            try store.save(new)
            if !relabeled.isEmpty { try store.saveSamples(samples) }
        } catch {
            return sendError("could not save the merge: \(error)", to: c)
        }
        config = new
        applyConfigToEngine()
        if var rec = pendingRecommendation {
            rec.merge.removeAll { Set($0) == Set([a.id, b.id]) }
            pendingRecommendation = rec.merge.isEmpty ? nil : rec
        }
        server.broadcast(configMessage())
        Log.info("merged zones \(a.id) + \(b.id) into \(id); \(changed.count) binding(s) updated")
        rebuildModel(reason: "zones merged") { [weak self] report in
            guard let self else { return }
            var m: [String: Any] = ["type": "calibration", "phase": "merge_applied", "zone": id, "name": title,
                                    "merged": [a.id, b.id], "samples": relabeled.count, "bindingsChanged": changed,
                                    "conflicts": conflicts]
            if a.surface != b.surface { m["note"] = "the zones were on different surfaces; the merged zone is drawn on \(a.surface)" }
            if let report { m["overall"] = report.overall; m["accuracy"] = report.accuracy; m["labels"] = report.labels }
            self.server.broadcast(m)
        }
    }

    // MARK: Learn from use

    /// Every sample: Cmd+Z watch while taps are pending (polled every 10 ms: key state needs no extra permission),
    /// then once a second promote confirmed taps and retrain when idle.
    private func learnFromUseTick(now: Double) {
        if learner.hasPending, now - lastUndoCheck >= 0.01 {
            lastUndoCheck = now
            // kVK_ANSI_Z = 6 with Command held: the frontmost app's Undo.
            let down = CGEventSource.keyState(.combinedSessionState, key: 6)
                && CGEventSource.flagsState(.combinedSessionState).contains(.maskCommand)
            // Only the press counts (the keys stay down across several 10 ms polls); it undoes the latest gesture.
            if down && !cmdZWasDown { learner.cancelLatest(reason: "Cmd+Z") }
            cmdZWasDown = down
        }
        guard now - lastLearnTick >= 1 else { return }
        lastLearnTick = now
        guard config.settings.learnFromUse else { learner.cancelPending(reason: "learnFromUse is off"); return }
        guard learner.hasPending || learner.newSinceTrain >= UseLearner.retrainAfter else { return }
        let counts = store.loadSamples().reduce(into: [String: Int]()) { $0[$1.label, default: 0] += 1 }
        learner.promoteDue(now: Clock.now(), calibrationCounts: counts, disabled: disabledZones)
        adaptIfDue(ignoreIdle: false)
    }

    /// Retrains from calibration + confirmed samples once 10 new confirmations exist and no tap came for 60 s.
    /// Ship guard: the new model must classify the calibration samples alone at least as well as the current one
    /// (within 0.02), otherwise the confirmed set is discarded.
    private func adaptIfDue(ignoreIdle: Bool) {
        guard config.settings.learnFromUse, !adapting, learner.newSinceTrain >= UseLearner.retrainAfter,
              calibration == nil, !sessions.tapCalibrating, let current = engine.model else { return }
        guard ignoreIdle || Clock.now() - lastTapAt >= UseLearner.idleSeconds else { return }
        let calib = store.loadSamples()
        guard !calib.isEmpty else { return }
        adapting = true
        let disabled = disabledZones
        let confirmed = learner.confirmed.filter { !disabled.contains($0.label) }
        let minConf = config.settings.minConfidence
        let gen = nextGeneration()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let evalCalib = calib.filter { !disabled.contains($0.label) }
            // Ship guard, deterministic (VERIFY_01 bug 3):
            // 1. confirmed taps that disagree with their calibration neighbours are rejected outright;
            // 2. a model trained on calibration + half the rest (every other one, in stored order) must label the
            //    calibration samples and the held-out half at least as well as the current model (within 0.02).
            let rejected = UseLearner.disagreeing(confirmed, calibration: evalCalib)
            let vetted = confirmed.filter { !rejected.contains($0.ts) }
            let asSample = { (c: UseLearner.Confirmed) in ConfigStore.LabeledSample(label: c.label, features: c.features, kind: "confirmed") }
            let trainHalf = vetted.enumerated().filter { $0.offset % 2 == 0 }.map { asSample($0.element) }
            let heldOut = vetted.enumerated().filter { $0.offset % 2 == 1 }.map { asSample($0.element) }
            let probe = Trainer()
            for s in evalCalib + trainHalf { probe.add(s.features, label: s.label) }
            let (probeModel, _) = probe.train()
            let calibNew = Self.accuracy(probeModel, on: evalCalib, minConfidence: minConf)
            let calibCur = Self.accuracy(current, on: evalCalib, minConfidence: minConf)
            let heldNew = heldOut.isEmpty ? 1 : Self.accuracy(probeModel, on: heldOut, minConfidence: minConf)
            let heldCur = heldOut.isEmpty ? 1 : Self.accuracy(current, on: heldOut, minConfidence: minConf)
            let keep = !vetted.isEmpty && calibNew >= calibCur - 0.02 && heldNew >= heldCur - 0.02
            var final: (ZoneModel, CalibrationReport)?
            if keep {
                let trainer = Trainer()
                for s in evalCalib + vetted.map(asSample) { trainer.add(s.features, label: s.label) }
                final = trainer.train()
            }
            self?.core.async {
                guard let self else { return }
                self.adapting = false
                if !rejected.isEmpty { self.learner.remove(ts: rejected, reason: "they disagree with the calibration taps around them") }
                var msg: [String: Any] = ["type": "adaptation", "kept": keep, "confirmed": vetted.count, "rejected": rejected.count,
                                          "accuracyBefore": Self.r4(calibCur), "accuracyAfter": Self.r4(calibNew),
                                          "heldOutBefore": Self.r4(heldCur), "heldOutAfter": Self.r4(heldNew)]
                if keep, let (model, report) = final {
                    guard self.isCurrent(gen, what: "learn-from-use") else { return }
                    do { try self.store.saveModel(model, report: report) } catch {
                        Log.error("could not save the adapted model: \(error); keeping the previous model")
                        return
                    }
                    self.installedGeneration = gen
                    self.engine.model = model
                    self.applyZoneCenters()
                    self.learner.markTrained()
                    Log.info("learn-from-use: model updated with \(vetted.count) confirmed taps (calibration \(Self.r4(calibCur)) -> \(Self.r4(calibNew)), held-out \(Self.r4(heldCur)) -> \(Self.r4(heldNew)))")
                } else {
                    self.learner.discardAll(reason: "ship guard: calibration \(Self.r4(calibCur)) -> \(Self.r4(calibNew)), held-out confirmed \(Self.r4(heldCur)) -> \(Self.r4(heldNew))")
                    msg["reason"] = vetted.isEmpty ? "every confirmed tap disagreed with the calibration; discarded"
                        : "the updated model did worse on the calibration or held-out confirmed taps; confirmed taps discarded"
                }
                self.server.broadcast(msg)
                if keep { self.server.broadcast(self.status()) }
            }
        }
    }

    /// Share of samples the model labels correctly, counting low-confidence answers as "none" (as the engine does).
    private static func accuracy(_ model: ZoneModel, on samples: [ConfigStore.LabeledSample], minConfidence: Double) -> Double {
        guard !samples.isEmpty else { return 0 }
        let right = samples.filter { s in
            let r = model.classify(s.features)
            let predicted = r.confidence >= minConfidence ? r.zone : ZoneModel.noneLabel
            return predicted == s.label
        }.count
        return Double(right) / Double(samples.count)
    }

    // MARK: Raw calibration windows

    /// Keeps 0.1 s before to 0.25 s after a captured calibration tap (cut once that much has been recorded).
    private func saveRawWindow(t: Double, label: String) {
        core.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self, self.calRaw != nil else { return }
            let w = self.diag.window(from: t - 0.1, to: t + 0.25)
            guard let first = w.first, let last = w.last else { return }
            let lastT = self.calRaw!.samples.last?.t ?? -1
            self.calRaw!.samples += w.filter { $0.t > lastT }          // overlapping windows: no duplicates
            self.calRaw!.segments.append(GkrecSegment(phase: label == "none" ? "negatives" : "capture",
                                                      zone: label == "none" ? nil : label, start: first.t, end: last.t,
                                                      onsets: [t], discarded: false, endedBy: nil))
        }
    }

    /// Writes the session's raw windows to model/raw/<session>.gkrec (total capped at 20 MB, oldest dropped).
    private func flushRawCalibration() {
        guard let raw = calRaw else { return }
        calRaw = nil
        guard !raw.samples.isEmpty else { return }
        let dir = store.modelDirectory.appendingPathComponent("raw", isDirectory: true)
        let url = dir.appendingPathComponent("\(raw.session).gkrec")
        do {
            let n = try DiagnosticsRecorder.write(raw.samples, to: url, deviceModel: device.model, zones: config.zones.map(\.id),
                                                  segments: raw.segments, notes: ["calibration raw tap windows (0.1 s before to 0.25 s after)"])
            Log.info("saved \(raw.segments.count) raw calibration tap windows (\(n) samples) to \(url.lastPathComponent)")
        } catch {
            Log.error("could not save raw calibration windows: \(error)")
        }
        Self.capDirectory(dir, maxBytes: rawCapBytes)
    }

    /// 20 MB; tests (--no-hardware-sessions only) may lower it with GHOSTKEYS_TEST_RAW_CAP_BYTES.
    private var rawCapBytes: Int {
        if options.noHardwareSessions, let v = ProcessInfo.processInfo.environment["GHOSTKEYS_TEST_RAW_CAP_BYTES"], let n = Int(v) { return n }
        return 20 * 1024 * 1024
    }

    private static func capDirectory(_ dir: URL, maxBytes: Int) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard var files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys) else { return }
        files.sort {
            ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
                < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
        }
        var total = files.reduce(0) { $0 + ((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        // Oldest first, and never the newest file (the one just written), even if it alone exceeds the budget.
        for f in files.dropLast() where total > maxBytes {
            total -= (try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            try? fm.removeItem(at: f)
        }
    }

    /// "permission denied", "disk full" and similar, without Foundation's long error dump.
    static func plainError(_ e: Error) -> String {
        let ns = e as NSError
        if let posix = (ns.userInfo[NSUnderlyingErrorKey] as? NSError), posix.domain == NSPOSIXErrorDomain {
            return String(cString: strerror(Int32(posix.code))).lowercased()
        }
        switch ns.code {
        case NSFileWriteNoPermissionError: return "no permission to write the model folder"
        case NSFileWriteOutOfSpaceError: return "the disk is full"
        case NSFileWriteVolumeReadOnlyError: return "the disk is read-only"
        default: return ns.localizedDescription
        }
    }

    private static func stamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd-HHmmss-SSS"
        return f.string(from: Date())
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
                             "level": Self.r4(engine.level * 1000), "unfamiliar": engine.isUnfamiliar]]
    }

    private func configMessage() -> [String: Any] {
        let data = (try? JSONEncoder().encode(config)) ?? Data("{}".utf8)
        let obj = (try? JSONSerialization.jsonObject(with: data)) ?? [:]
        return ["type": "config", "config": obj]
    }

    private func applyConfigToEngine() {
        // The engine reads settings (sensitivity, gates, windows) on every sample, so this takes effect immediately.
        engine.settings = config.settings.detection
        shadow.settings = config.settings.detection
        applyZoneCenters()
        engine.zonesNeedingMultiTap = config.zonesNeedingMultiTap
        // Tilt detection only when something is bound to it (a tilted lap or a nudge otherwise makes noise).
        engine.tiltEnabled = config.bindings.contains { $0.enabled && $0.gesture.hasPrefix("tilt_") }
        Log.debug("tilt detection \(engine.tiltEnabled ? "on (a tilt binding exists)" : "off (no tilt binding)")")
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
        let s = input.snapshot(now: Clock.now())
        return s.key * 1000 < config.settings.typingGateMs || s.keyUp < 0.15
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
