import Foundation
import AppKit
import ApplicationServices
import GhostkeysDetection

/// Wires sensors, detection, the WebSocket server, config, calibration and actions together.
/// Every piece of mutable state here is touched only on `core`.
final class Daemon: @unchecked Sendable {
    static let version = "0.1.0"
    static let streams: Set<String> = ["imu", "lid", "light", "taps"]

    let options: Options
    let core = DispatchQueue(label: "ghostkeys.core", qos: .userInteractive)
    let store = ConfigStore()
    let device = DeviceInfo.current()
    let hub = SensorHub()
    let input = InputMonitor()
    let actions: ActionRunner
    let server: WebSocketServer

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

    init(options: Options) {
        self.options = options
        actions = ActionRunner(dryRun: options.dryRun)
        server = WebSocketServer(port: options.port, queue: core)
        config = store.loadConfig()
        engine = TapEngine(settings: config.settings.detection)
        engine.model = store.loadModel()
        applyConfigToEngine()   // also sets the model's zone centres
        actions.isPaused = { [weak self] in self?.paused ?? true }
    }

    // MARK: Lifecycle

    func start() throws {
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
            case .rejected(let t, let reason):
                server.broadcast(["type": "rejected", "t": Clock.protocolMs(t), "reason": reason.rawValue], stream: "taps")
            case .tap(let tap):
                server.broadcast(["type": "tap", "t": Clock.protocolMs(tap.t), "zone": tap.zone, "confidence": tap.confidence,
                                  "x": tap.x, "y": tap.y, "strength": tap.strength], stream: "taps")
            case .gesture(let g):
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

    private func onGesture(_ g0: GestureEvent, fillModifiers: Bool = false) {
        var g = g0
        if fillModifiers && g.modifiers.isEmpty { g.modifiers = InputMonitor.currentModifiers() }
        if paused {
            server.broadcast(["type": "rejected", "t": Clock.protocolMs(g.t), "reason": RejectReason.paused.rawValue], stream: "taps")
            return
        }
        let app = input.frontmostBundleID
        server.broadcast(["type": "gesture", "t": Clock.protocolMs(g.t), "gesture": g.gesture, "zone": g.zone ?? NSNull(),
                          "zones": g.zones, "modifiers": g.modifiers.sorted(), "confidence": g.confidence,
                          "app": app ?? NSNull()])
        // No actions while calibrating: the user is tapping zones on purpose.
        guard calibration == nil else { return }
        guard let binding = BindingResolver.resolve(g, bindings: config.bindings, app: app) else { return }
        runAction(binding.action, bindingId: binding.id, label: binding.label ?? binding.id, t: g.t)
    }

    private func runAction(_ action: JSONValue, bindingId: String?, label: String, t: Double) {
        guard !paused else {
            sendAction(t: t, bindingId: bindingId, label: label, ok: false, error: "paused")
            return
        }
        actions.run(action) { [weak self] ok, error in
            self?.core.async {
                if let error { Log.info("action \(label) failed: \(error)") }
                self?.sendAction(t: t, bindingId: bindingId, label: label, ok: ok, error: error)
            }
        }
    }

    private func sendAction(t: Double, bindingId: String?, label: String, ok: Bool, error: String?) {
        let msg: [String: Any] = ["type": "action", "t": Clock.protocolMs(t), "bindingId": bindingId ?? NSNull(),
                                  "label": label, "ok": ok, "error": error ?? NSNull()]
        server.broadcast(msg)
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
            server.broadcast(status())
        case "resume":
            paused = false
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
            runAction(action, bindingId: nil, label: label, t: Clock.now())
        case "request_permission":
            guard (m["which"] as? String) == "accessibility" else { return sendError("unknown permission", to: c) }
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
                "sensors": ["imu": p.contains(.accel), "gyro": p.contains(.gyro), "lid": p.contains(.lid), "light": p.contains(.light)],
                "permissions": ["accessibility": AXIsProcessTrusted()]]
    }

    private func status() -> [String: Any] {
        let labels = (engine.model?.labels ?? []).filter { $0 != "none" }
        return ["type": "status", "paused": paused, "calibrated": !labels.isEmpty, "zones": labels,
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

    /// Tap x,y comes from the zone centres, so custom zone rectangles must reach the model.
    private func applyZoneCenters() {
        let centers = Dictionary(config.zones.map { ($0.id, [$0.rect.x + $0.rect.w / 2, $0.rect.y + $0.rect.h / 2]) },
                                 uniquingKeysWith: { a, _ in a })
        engine.model?.setZoneCenters(centers)
    }

    private static func r4(_ v: Double) -> Double { (v * 10000).rounded() / 10000 }
}
