import Foundation

/// What the session coordinator needs from the daemon. Everything is called on the core queue.
protocol SessionHost: AnyObject {
    var currentConfig: Config { get }
    var isPaused: Bool { get }
    var currentLidAngle: Double? { get }
    var deviceFamily: String { get }
    /// True while the typing gate is active (sound gestures are suppressed then).
    var typingActive: Bool { get }
    func broadcast(_ message: [String: Any], stream: String?)
    func send(_ message: [String: Any], to client: WebSocketServer.Client)
    /// Runs a gesture through the normal path (paused check, gesture message, binding resolution, limiter).
    func deliverGesture(name: String, t: Double, zone: String?, confidence: Double, extra: [String: Any])
}

/// Owns the optional sound (microphone) and air (camera) sessions: when they may start, how long they run, and how
/// their output reaches the binding path. Off by default: nothing starts unless the app asks (`sound_session_start`,
/// `air_session_start`) or the user pinned an app in settings (`settings.sound.autoApps` / `settings.camera.autoApps`)
/// and a binding for those gestures exists.
final class SessionCoordinator {
    static let maxSeconds = 120.0
    static let noHandTimeout = 10.0

    private let queue: DispatchQueue
    private weak var host: SessionHost?
    let sound: SoundSession
    let air: AirSession
    private let soundTimer: SessionTimer
    private let airTimer: SessionTimer
    private var soundError: String?
    private var airError: String?

    // Recent IMU taps: knuckle gestures take the zone of the tap they came from; desk touches need IMU contact.
    private var recentTaps: [(t: Double, zone: String)] = []
    private let tapTimesLock = NSLock()
    private var tapTimes: [Double] = []
    // Tap messages held back briefly while a tap-type classification may still arrive.
    private var heldTaps: [(t: Double, message: [String: Any])] = []

    init(queue: DispatchQueue, simulate: Bool, modelDirectory: URL, host: SessionHost) {
        self.queue = queue
        self.host = host
        sound = SoundSession(queue: queue, simulate: simulate, modelDirectory: modelDirectory)
        air = AirSession(queue: queue, simulate: simulate)
        soundTimer = SessionTimer(kind: .sound, queue: queue)
        airTimer = SessionTimer(kind: .air, queue: queue)

        soundTimer.onExpire = { [weak self] in self?.stopSound(reason: "timeout") }
        airTimer.onExpire = { [weak self] in self?.stopAir(reason: "timeout") }
        soundTimer.onTick = { [weak self] left in
            guard let self else { return }
            self.sound.tick()
            if left % 5 == 0 { self.report(.sound) }
        }
        airTimer.onTick = { [weak self] left in
            guard let self else { return }
            // Real camera sessions end after 10 s without a hand (the green light should not stay on for nothing).
            if !self.air.simulate, Clock.now() - self.air.lastHandSeen > Self.noHandTimeout {
                self.stopAir(reason: "no_hand"); return
            }
            if left % 5 == 0 { self.report(.air) }
        }
        sound.onGesture = { [weak self] g in self?.soundGesture(g) }
        sound.onTapType = { [weak self] onset, type in self?.tapTypeArrived(onset: onset, type: type) }
        air.onOutput = { [weak self] o in self?.airOutput(o) }
        air.onStopped = { [weak self] reason in
            guard let self, self.airTimer.active else { return }
            self.airTimer.end()
            self.report(.air, reason: reason)
        }
    }

    // MARK: hello

    static var soundHardware: Bool { SoundSession.hardwarePresent }
    static var cameraHardware: Bool { AirSession.hardwarePresent }

    // MARK: Requests from the app

    func startSound(seconds requested: Double?, client: WebSocketServer.Client?) {
        guard let host else { return }
        guard !host.isPaused else { return fail(.sound, "paused", client) }
        let cfg = host.currentConfig
        let seconds = clampSeconds(requested ?? cfg.settings.sound.sessionSeconds)
        if sound.running {                        // extend
            soundTimer.begin(seconds: seconds, reason: soundTimer.reason ?? "request")
            return report(.sound)
        }
        let wantSonar = cfg.hasBinding(for: Config.waveGestures)
        if let err = sound.start(wantSonar: wantSonar, userInitiated: client != nil) {
            soundError = err
            return fail(.sound, err, client)
        }
        soundError = nil
        soundTimer.begin(seconds: seconds, reason: client != nil ? "request" : "auto")
        report(.sound)
    }

    func stopSound(reason: String) {
        guard soundTimer.active || sound.running else { return }
        sound.stop()
        soundTimer.end()
        flushHeldTaps()
        report(.sound, reason: reason)
    }

    func startAir(seconds requested: Double?, camera: String?, client: WebSocketServer.Client?) {
        guard let host else { return }
        guard !host.isPaused else { return fail(.air, "paused", client) }
        let cfg = host.currentConfig
        let wantsDesk = camera == "desk_view"
        if wantsDesk && !cfg.settings.camera.deskMode {
            return fail(.air, "desk mode is off (settings.camera.deskMode)", client)
        }
        let seconds = clampSeconds(requested ?? cfg.settings.camera.sessionSeconds)
        if air.running {
            airTimer.begin(seconds: seconds, reason: airTimer.reason ?? "request")
            return report(.air)
        }
        var desk: AirSession.DeskConfig?
        if wantsDesk {
            let zones = cfg.zones.filter { $0.surface == "base" }.map { (id: $0.id, x: $0.rect.x, y: $0.rect.y, w: $0.rect.w, h: $0.rect.h) }
            desk = AirSession.DeskConfig(lidAngle: host.currentLidAngle ?? 115, family: host.deviceFamily, zones: zones,
                                         imuTapNear: { [weak self] t in self?.imuTapNear(t) ?? false })
        }
        airTimer.begin(seconds: seconds, reason: client != nil ? "request" : "auto")
        air.start(seconds: seconds, desk: desk, userInitiated: client != nil) { [weak self] err in
            guard let self else { return }
            if let err {
                self.airTimer.end()
                self.airError = err
                self.fail(.air, err, client)
            } else {
                self.airError = nil
                self.report(.air)
            }
        }
    }

    func stopAir(reason: String) {
        guard airTimer.active || air.running else { return }
        air.stop()
        airTimer.end()
        report(.air, reason: reason)
    }

    func stopAll(reason: String) {
        stopSound(reason: reason)
        stopAir(reason: reason)
    }

    /// Current state of both sessions, for a newly connected client.
    func stateMessages() -> [[String: Any]] { [message(.sound, reason: nil), message(.air, reason: nil)] }

    // MARK: Automatic sessions (pinned apps)

    func frontmostChanged(to bundleID: String?) {
        guard let host, !host.isPaused else { return }
        let cfg = host.currentConfig
        // Leaving a pinned app ends the automatic session it started.
        if soundTimer.isAuto || soundTimer.reason == "auto" { stopSound(reason: "app_changed") }
        if airTimer.isAuto || airTimer.reason == "auto" { stopAir(reason: "app_changed") }
        guard let id = bundleID else { return }
        if cfg.settings.sound.enabled, cfg.settings.sound.autoApps.contains(id),
           cfg.hasBinding(for: Config.soundGestures, app: id), !sound.running {
            startSound(seconds: nil, client: nil)
        }
        if cfg.settings.camera.enabled, cfg.settings.camera.autoApps.contains(id),
           cfg.hasBinding(for: Config.cameraGestures, app: id), !air.running {
            startAir(seconds: nil, camera: "front", client: nil)
        }
    }

    func lidChanged(angle: Double) {
        // Lid (nearly) closed: the camera cannot see anything useful and should not stay on.
        if angle < 20 { stopAir(reason: "lid_closed") }
    }

    // MARK: IMU taps

    /// Called for every accepted IMU tap. Returns true if the tap message was held back (it will be sent later with
    /// its `tapType`), false if the caller should send it now.
    func imuTap(t: Double, zone: String, message: [String: Any]) -> Bool {
        recentTaps.append((t, zone))
        recentTaps.removeAll { t - $0.t > 1 }
        tapTimesLock.lock(); tapTimes.append(t); tapTimes.removeAll { t - $0 > 1 }; tapTimesLock.unlock()
        guard sound.running else { return false }
        sound.noteTapOnset(t)
        guard sound.tapTypesOn else { return false }
        heldTaps.append((t, message))
        // Classification needs 40 ms of audio after the onset; never hold a tap longer than 150 ms.
        queue.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.releaseTap(onset: t, type: nil) }
        return true
    }

    private func imuTapNear(_ t: Double) -> Bool {
        tapTimesLock.lock(); defer { tapTimesLock.unlock() }
        return tapTimes.contains { abs($0 - t) < 0.15 }
    }

    private func tapTypeArrived(onset: Double, type: String?) {
        releaseTap(onset: onset, type: type)
    }

    private func releaseTap(onset: Double, type: String?) {
        guard let i = heldTaps.firstIndex(where: { abs($0.t - onset) < 0.02 }) else { return }
        var m = heldTaps.remove(at: i).message
        if let type { m["tapType"] = type }
        host?.broadcast(m, stream: "taps")
    }

    private func flushHeldTaps() {
        let all = heldTaps
        heldTaps.removeAll()
        for h in all { host?.broadcast(h.message, stream: "taps") }
    }

    // MARK: Session output -> binding path

    private func soundGesture(_ g: SoundSession.Gesture) {
        guard let host, sound.running else { return }
        // Typing and hands near the keyboard make friction and Doppler noise: suppress while the typing gate is on.
        if host.typingActive {
            host.broadcast(["type": "rejected", "t": Clock.protocolMs(g.time), "reason": "typing", "gesture": g.name], stream: "taps")
            return
        }
        var zone: String?
        if g.name == "knock_knuckle" {
            zone = recentTaps.min { abs($0.t - g.time) < abs($1.t - g.time) }.flatMap { abs($0.t - g.time) < 0.1 ? $0.zone : nil }
        }
        var extra = g.extra
        extra["source"] = "sound"
        host.deliverGesture(name: g.name, t: g.time, zone: zone, confidence: g.confidence, extra: extra)
    }

    private func airOutput(_ o: AirSession.Output) {
        guard let host, air.running else { return }
        switch o {
        case .gesture(let name, let t, let confidence, var extra):
            extra["source"] = "camera"
            host.deliverGesture(name: name, t: t, zone: "air", confidence: confidence, extra: extra)
        case .air(let msg, _):
            host.broadcast(msg, stream: "air")
        case .deskTap(let zone, let t, let x, let y, let confidence):
            host.broadcast(["type": "tap", "t": Clock.protocolMs(t), "zone": zone, "confidence": confidence,
                            "x": x, "y": y, "strength": 0, "source": "camera"], stream: "taps")
        }
    }

    // MARK: Messages

    private func clampSeconds(_ s: Double) -> Double { max(1, min(Self.maxSeconds, s.isFinite ? s : 30)) }

    private func message(_ kind: SessionTimer.Kind, reason: String?) -> [String: Any] {
        let timer = kind == .sound ? soundTimer : airTimer
        let simulated = kind == .sound ? sound.simulate : air.simulate
        var m: [String: Any] = ["type": "session", "kind": kind.rawValue, "active": timer.active,
                                "secondsLeft": timer.secondsLeft]
        if simulated { m["simulated"] = true }
        if let reason { m["reason"] = reason }
        if timer.active { m["trigger"] = timer.reason ?? "request" }
        if kind == .sound && timer.active { m["sonar"] = sound.sonarOn; m["tapTypes"] = sound.tapTypesOn }
        return m
    }

    private func report(_ kind: SessionTimer.Kind, reason: String? = nil) {
        host?.broadcast(message(kind, reason: reason), stream: nil)
    }

    private func fail(_ kind: SessionTimer.Kind, _ error: String, _ client: WebSocketServer.Client?) {
        Log.info("\(kind.rawValue) session not started: \(error)")
        var m = message(kind, reason: "error")
        m["error"] = error
        if let client { host?.send(m, to: client) } else { host?.broadcast(m, stream: nil) }
    }
}
