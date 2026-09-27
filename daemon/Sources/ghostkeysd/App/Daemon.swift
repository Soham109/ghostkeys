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
    private lazy var catalog: Any = (try? JSONSerialization.jsonObject(with: Data(IntegrationCatalog.json.utf8))) ?? [:]

    private var config: Config
    private let engine: TapEngine
    /// Same detection with the input gates bypassed and no model: its candidates are every onset "before the gates",
    /// which gives rejections a zone guess and feeds the debug stream.
    private let shadow: TapEngine
    private let diag = DiagnosticsRecorder()
    private struct SeenCandidate { var t: Double; var features: TapFeatures; var zone: String; var confidence: Double; var outcome: String
                                   var detail: ZoneModel.Result? = nil }
    private lazy var tapLog = TapLog(enabled: options.logTaps)
    private var recentCandidates: [SeenCandidate] = []
    private var lastAccepted: SeenCandidate?
    private var feedbackTimes: [Double] = []
    private var lastExport = -100.0
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

        diag.record(s, sinceKey: snap.key, sinceMouse: snap.mouse, modifiers: snap.modifiers)
        // SonarField: typing (the typing gate) and laptop motion or bumps (|a| away from 1 g, or any rotation) make
        // Doppler and phase noise; keep sonar detection off for 0.45 s after each.
        let aMag = (s.a * s.a).sum().squareRoot(), gMag = (s.g * s.g).sum().squareRoot()
        if snap.key * 1000 < config.settings.typingGateMs || snap.keyUp < 0.15 || abs(aMag - 1) > 0.05 || gMag > 15 {
            if s.t - lastSonarSuppress > 0.05 {
                lastSonarSuppress = s.t
                sessions.suppressSonar(until: s.t + 0.45)
            }
        }
        // Shadow pass first: every onset that survives the motion gate becomes a classified candidate.
        var fresh: [SeenCandidate] = []
        let shadowCtx = InputContext(secondsSinceKey: snap.key, secondsSinceMouse: snap.mouse, modifiers: snap.modifiers,
                                     lidAngle: lidAngle, paused: false,
                                     secondsSinceKeyUp: snap.keyUp, secondsSinceModifierChange: snap.modifierChange)
        for e in shadow.ingest(s, context: shadowCtx) {
            guard case .candidate(let f) = e else { continue }
            // --log-taps wants the runner-up zone too, which only the detailed result carries.
            let detail = tapLog.enabled ? engine.model?.classifyDetailed(f) : nil
            let r = detail.map { (zone: $0.zone, confidence: $0.confidence, x: $0.x, y: $0.y) }
                ?? engine.model?.classify(f) ?? (zone: "none", confidence: 0, x: 0.5, y: 0.5)
            fresh.append(SeenCandidate(t: f.t, features: f, zone: r.zone, confidence: r.confidence, outcome: "pending", detail: detail))
        }
        tapLog.track(level: engine.level, threshold: engine.onsetThreshold, t: s.t,
                     inputBusy: capturing || snap.key * 1000 < config.settings.typingGateMs || snap.mouse < 0.3)
        func peakMg(_ i: Int?) -> Double? { i.map { pow(10, fresh[$0].features[.strength]) } }
        let labels = engine.model?.labels ?? []
        let minConfidence = config.settings.detection.minConfidence
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
                let i = shadowIndex(t)
                tapLog.rejected(t: t, reason: reason, peakMg: peakMg(i), detail: i.flatMap { fresh[$0].detail }, labels: labels,
                                minConfidence: minConfidence, sinceKey: snap.key, sinceMouse: snap.mouse, hasModel: engine.model != nil)
                server.broadcast(msg, stream: "taps")
            case .tap(let tap):
                if let i = shadowIndex(tap.t) {
                    fresh[i].outcome = "accepted"
                    lastAccepted = fresh[i]
                    lastAccepted?.zone = tap.zone
                }
                diag.note(tap.t, "tap zone=\(tap.zone) confidence=\(Self.r4(tap.confidence))")
                let i = shadowIndex(tap.t)
                tapLog.accepted(tap, peakMg: peakMg(i), detail: i.flatMap { fresh[$0].detail }, labels: labels, minConfidence: minConfidence)
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

        if !fresh.isEmpty {
            for c in fresh {
                if c.outcome == "pending" {
                    diag.note(c.t, "candidate zone=\(c.zone) (no decision: calibration or paused)")
                    tapLog.undecided(t: c.t, peakMg: pow(10, c.features[.strength]), calibrating: capturing, hasModel: engine.model != nil)
                }
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
            tapLog.gesture(g, app: input.frontmostBundleID, "nothing ran: paused" + (pausedReason == "rate_limit" ? " by the rate limit" : ""))
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
        guard calibration == nil, !sessions.tapCalibrating else { return tapLog.gesture(g, app: app, "nothing ran: calibrating") }
        // A disabled zone never fires (its taps are also left out of the model).
        if let z = g.zone, disabledZones.contains(z) { return tapLog.gesture(g, app: app, "nothing ran: zone \(z) is disabled") }
        if g.zones.contains(where: { disabledZones.contains($0) }) { return tapLog.gesture(g, app: app, "nothing ran: a zone is disabled") }
        guard let binding = BindingResolver.resolve(g, bindings: config.bindings, app: app) else {
            if tapLog.enabled {
                let here = Set(config.bindings.filter { $0.enabled && $0.zone != nil && $0.zone == g.zone }.map(\.gesture)).sorted()
                tapLog.gesture(g, app: app, "nothing ran: no binding for this gesture"
                               + (here.isEmpty ? "" : " (bound on this zone: \(here.joined(separator: ", ")))"))
            }
            return
        }
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
            tapLog.gesture(g, app: app, "nothing ran: \"\(label)\" is in cooldown or still running")
            return
        case .tripped(let why):
            tripRateLimit(why)
            sendAction(t: g.t, bindingId: binding.id, label: label, ok: false, error: "rate limit: \(why); paused")
            return
        }
        // Gesture actions are dropped if they would start more than 1 s late (stale).
        tapLog.gesture(g, app: app, "runs \"\(label)\"")
        runAction(binding.action, bindingId: binding.id, label: label, t: g.t, maxAge: 1)
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
            let target = Int((measure / step).rounded(.towardZero))
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
                if let error { Log.info("action \(label) failed: \(error)") } else { self.tapLog.action(label, ok: true, error: nil) }
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
        let samples = CalibrationMerge.merge(saved: store.loadSamples(), run: cal.samples,
                                             knownZones: Set(config.zones.map(\.id)), label: \.label)
        let carried = samples.count - cal.samples.count
        let disabled = disabledZones
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            // Disabled zones are left out of the model; their samples stay in samples.json for later.
            let trainer = Trainer()
            for s in samples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            let rec = trainer.recommendedZones()
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
                self.pendingRecommendation = rec
                self.server.broadcast(["type": "calibration", "phase": "done", "accuracy": report.accuracy,
                                       "overall": report.overall, "confusion": report.confusion, "labels": report.labels,
                                       "recommendation": Self.recommendationJSON(rec),
                                       "peaks": Self.peaksJSON(model)])
                self.server.broadcast(self.status())
                Log.info("calibration done: overall accuracy \(report.overall), labels \(report.labels), \(carried) saved sample(s) kept from zones not redone")
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
        case "calibration_apply_recommendation":
            applyRecommendation(client: c)
        case "calibration_apply_merge":
            applyMerge(zones: m["zones"] as? [String], name: m["name"] as? String, client: c)
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
                let disabledBefore = disabledZones
                config = new
                if disabledZones != disabledBefore { rebuildModel(reason: "enabled zones changed") }
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
            // Pretend the engine accepted it, with the features of a saved sample for that zone (for feedback_false tests).
            if let sample = store.loadSamples().last(where: { $0.label == zone }) {
                var values = sample.features.values
                if let k = (m["strengthScale"] as? NSNumber)?.doubleValue, k > 0 { values[FeatureIndex.strength.rawValue] += log10(k) }
                lastAccepted = SeenCandidate(t: t, features: TapFeatures(values: values, t: t), zone: zone,
                                             confidence: 0.95, outcome: "accepted")
            }
            let g = GestureEvent(t: t, gesture: "tap", zone: zone, zones: [zone], modifiers: [], confidence: 0.95)
            if !sessions.holdTapGesture(t: t, zone: zone, release: { [weak self] in self?.onGesture(g) }) { onGesture(g) }
        case "sim_tap_type" where options.noHardwareSessions:
            sessions.simulateTapType(m["tapType"] as? String)
        case "sim_air" where options.noHardwareSessions:
            sessions.simulateAir(phase: (m["phase"] as? String) ?? "changed", dx: (m["dx"] as? NSNumber)?.doubleValue ?? 0,
                                 dy: (m["dy"] as? NSNumber)?.doubleValue ?? 0)
        case "feedback_missed", "feedback_false":
            guard admitFeedback() else { return sendError("\(type): at most one every 2 s and 20 per minute", to: c) }
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
                diag.injectSyntheticTap(ago: (m["ago"] as? NSNumber)?.doubleValue ?? 2.0,
                                        scale: (m["scale"] as? NSNumber)?.doubleValue ?? 1, mouseNear: (m["mouse"] as? Bool) ?? false)
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
            sessions.stopSonar(reason: "requested")
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
        samples.append(.init(label: label, features: TapFeatures(values: f.values, t: 0)))
        let replyID = c.id
        let disabled = disabledZones
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let trainer = Trainer()
            for s in samples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            var saveError: String?
            do {
                try self.store.saveModel(model, report: report)
                try self.store.saveSamples(samples)
            } catch { saveError = "\(error)" }
            self.core.async {
                self.engine.model = model
                self.applyZoneCenters()
                reply["retrained"] = saveError == nil
                if let saveError { reply["reason"] = "could not save: \(saveError)" }
                reply["counts"] = trainer.counts
                reply["overall"] = Self.r4(report.overall)
                Log.info("feedback \(reply["kind"] ?? "?"): added a \(label) sample; accuracy \(report.overall)")
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
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let trainer = Trainer()
            for s in samples where !disabled.contains(s.label) { trainer.add(s.features, label: s.label) }
            let (model, report) = trainer.train()
            guard let self else { return }
            do { try self.store.saveModel(model, report: report) } catch { Log.error("could not save model: \(error)") }
            self.core.async {
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
        shadow.settings = config.settings.detection
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
