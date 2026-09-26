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
    /// Continuous `air` message (pinch_hold also drives knob bindings).
    func deliverAir(_ message: [String: Any])
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
    // IMU "tap" gestures held back in zones that also have a knock_knuckle binding: exactly one of the two fires.
    private var heldGestures: [(t: Double, zone: String, release: () -> Void)] = []
    static let holdWindow = 0.15

    // Tap-type calibration state.
    private struct TapCalibration { var types: [String]; var target: Int; var index = 0; var counts: [String: Int] = [:] }
    private var tapCal: TapCalibration?
    var tapCalibrating: Bool { tapCal != nil }

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
        sound.onCalibrationSample = { [weak self] label, ok in self?.tapCalibrationSample(label: label, captured: ok) }
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
        if tapCal != nil { cancelTapCalibration(reason: "sound session ended (\(reason))") }
        sound.stop()
        soundTimer.end()
        flushHeldTaps()
        releaseAllHeldGestures()
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
        // (Simulated sessions have no camera, so the rule does not apply to them.)
        if angle < 20 && !air.simulate { stopAir(reason: "lid_closed") }
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

    fileprivate func tapTypeArrived(onset: Double, type: String?) {
        releaseTap(onset: onset, type: type)
        // A knuckle tap becomes knock_knuckle (emitted by the sound processor): drop the held "tap" gesture.
        // Anything else (fingertip, nail, unclassified) releases the plain "tap".
        while let i = heldGestures.firstIndex(where: { abs($0.t - onset) < 0.03 }) {
            let h = heldGestures.remove(at: i)
            if type != "knuckle" { h.release() }
        }
    }

    /// Called for each IMU "tap" gesture. Returns true if it was held (the caller must not deliver it now):
    /// a sound session with tap types is running and a knock_knuckle binding could claim this zone.
    func holdTapGesture(t: Double, zone: String?, release: @escaping () -> Void) -> Bool {
        guard let host, let zone, sound.running, sound.tapTypesOn, tapCal == nil else { return false }
        let claims = host.currentConfig.bindings.contains {
            $0.enabled && $0.gesture == "knock_knuckle" && ($0.zone == nil || $0.zone == zone)
        }
        guard claims else { return false }
        heldGestures.append((t, zone, release))
        queue.asyncAfter(deadline: .now() + Self.holdWindow) { [weak self] in
            guard let self, let i = self.heldGestures.firstIndex(where: { $0.t == t && $0.zone == zone }) else { return }
            self.heldGestures.remove(at: i).release()      // no classification in time: it was a plain tap
        }
        return true
    }

    private func releaseAllHeldGestures() {
        let all = heldGestures
        heldGestures.removeAll()
        for h in all { h.release() }
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

    // MARK: Tap-type calibration

    /// `calibration_taptype_start`: needs a running sound session. Captures `target` taps of each type in order
    /// (the app shows which one to make), then trains, saves model/tap-types.json and reports taptype_done.
    func startTapCalibration(types requested: [String]?, target: Int?, client: WebSocketServer.Client) {
        guard sound.running else { return calError("start a sound session first (sound_session_start)", client) }
        let valid = SoundSession.tapTypeNames
        let types = (requested ?? valid).filter { valid.contains($0) }.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        guard types.count >= 2 else { return calError("need at least two of \(valid.joined(separator: ", "))", client) }
        let target = max(3, min(50, target ?? 15))
        tapCal = TapCalibration(types: types, target: target)
        sound.beginTapCalibration()
        // Calibration takes longer than a normal session: extend it to the maximum.
        soundTimer.begin(seconds: Self.maxSeconds, reason: soundTimer.reason ?? "request")
        report(.sound)
        tapCalProgress()
    }

    func cancelTapCalibration(reason: String = "cancelled") {
        guard tapCal != nil else { return }
        tapCal = nil
        sound.endTapCalibration()
        host?.broadcast(["type": "calibration", "phase": "taptype_cancelled", "reason": reason], stream: nil)
    }

    /// Every IMU tap candidate during tap-type calibration (onset time, Clock seconds).
    func tapCandidate(t: Double) {
        guard let cal = tapCal, cal.index < cal.types.count else { return }
        sound.captureOnset(t, label: cal.types[cal.index])
    }

    private func tapCalibrationSample(label: String, captured: Bool) {
        guard var cal = tapCal, cal.index < cal.types.count, cal.types[cal.index] == label else { return }
        if !captured { return tapCalProgress(missed: true) }
        cal.counts[label, default: 0] += 1
        if cal.counts[label, default: 0] >= cal.target { cal.index += 1 }
        tapCal = cal
        if cal.index >= cal.types.count { finishTapCalibration() } else { tapCalProgress() }
    }

    private func tapCalProgress(missed: Bool = false) {
        guard let cal = tapCal, cal.index < cal.types.count else { return }
        let type = cal.types[cal.index]
        var m: [String: Any] = ["type": "calibration", "phase": "taptype_capturing", "tapType": type,
                                "count": cal.counts[type] ?? 0, "target": cal.target, "types": cal.types]
        if missed { m["missed"] = true }     // the IMU saw a tap but the sound had no clear onset
        host?.broadcast(m, stream: nil)
    }

    private func finishTapCalibration() {
        guard let cal = tapCal else { return }
        tapCal = nil
        host?.broadcast(["type": "calibration", "phase": "taptype_training"], stream: nil)
        do {
            let r = try sound.trainTapTypes()
            Log.info("tap-type model trained: leave-one-out accuracy \(r.accuracy), saved to \(r.path)")
            host?.broadcast(["type": "calibration", "phase": "taptype_done", "accuracy": (r.accuracy * 1000).rounded() / 1000,
                             "counts": r.counts, "types": cal.types, "simulated": sound.simulate], stream: nil)
        } catch {
            host?.broadcast(["type": "calibration", "phase": "taptype_failed", "error": "\(error)"], stream: nil)
        }
        sound.endTapCalibration()
        report(.sound)
    }

    private func calError(_ message: String, _ client: WebSocketServer.Client) {
        host?.send(["type": "calibration", "phase": "taptype_failed", "error": message], to: client)
    }

    // MARK: Session output -> binding path

    fileprivate func soundGesture(_ g: SoundSession.Gesture) {
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

    fileprivate func airOutput(_ o: AirSession.Output) {
        guard let host, air.running else { return }
        switch o {
        case .gesture(let name, let t, let confidence, var extra):
            extra["source"] = "camera"
            host.deliverGesture(name: name, t: t, zone: "air", confidence: confidence, extra: extra)
        case .air(let msg, _):
            host.deliverAir(msg)
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

// MARK: - Test hooks (only reachable with --no-hardware-sessions)

extension SessionCoordinator {
    /// Stands in for the sound processor classifying the most recent held (or pending) IMU tap.
    func simulateTapType(_ type: String?) {
        guard sound.simulate, let onset = heldGestures.last?.t ?? heldTaps.last?.t else { return }
        tapTypeArrived(onset: onset, type: type)
        if type == "knuckle" {
            soundGesture(SoundSession.Gesture(name: "knock_knuckle", time: onset, confidence: 0.9, extra: [:]))
        }
    }

    /// Stands in for the camera: a pinch_hold phase with a delta, as AirSession would emit it.
    func simulateAir(phase: String, dx: Double, dy: Double) {
        guard air.simulate, air.running else { return }
        let t = Clock.now()
        var msg: [String: Any] = ["type": "air", "t": Clock.protocolMs(t), "gesture": "pinch_hold", "phase": phase,
                                  "hand": "right", "x": 0.5, "y": 0.5, "confidence": 0.9]
        if phase == "changed" { msg["dx"] = dx; msg["dy"] = dy }
        airOutput(.air(msg, t: t))
        if phase == "began" {
            airOutput(.gesture(name: "pinch_hold", t: t, confidence: 0.9, extra: ["hand": "right", "x": 0.5, "y": 0.5]))
        }
    }
}
