// `ghostkeys-lab record`: guided capture of labeled taps, negatives (typing / trackpad) and rest.

import Foundation

let zoneHints: [String: String] = [
    "left-palm": "the palm rest LEFT of the trackpad",
    "right-palm": "the palm rest RIGHT of the trackpad",
    "left-grille": "the LEFT speaker grille, beside the keyboard",
    "right-grille": "the RIGHT speaker grille, beside the keyboard",
    "top-strip": "the strip ABOVE the function keys, below the hinge",
    "left-edge": "the thin LEFT side edge of the base",
    "right-edge": "the thin RIGHT side edge of the base",
    "lid": "the BACK of the display lid",
]

/// Owns the sensor stream, the recording being built and the live onset counter.
final class Session {
    let stream = IMUStream()
    var rec: Recording
    var t0: Double?
    let onset = LabOnsetDetector()
    private var lastPoll = 0.0

    init(rec: Recording) { self.rec = rec }

    /// Session-relative now (same clock as sample timestamps).
    var now: Double { LabClock.now() - (t0 ?? LabClock.now()) }

    /// Drains new samples into the recording, polls activity at <= 100 Hz, returns onsets found (session time).
    @discardableResult
    func pump() -> [Double] {
        var onsets: [Double] = []
        for s in stream.drain() {
            if t0 == nil { t0 = s.t }
            rec.append(s, t0: t0!)
            if let o = onset.ingest(t: s.t - t0!, a: SIMD3(Double(s.a.x), Double(s.a.y), Double(s.a.z))) { onsets.append(o) }
        }
        let wall = LabClock.now()
        if let t0, wall - lastPoll >= 0.0095 {
            lastPoll = wall
            rec.append(Activity.read(), t0: t0)
        }
        return onsets
    }

    func tick() { usleep(10_000) }
}

func runRecord(_ args: Args) throws {
    let zones = (args.options["zones"] ?? "left-palm,right-palm,left-grille,right-grille,top-strip,left-edge,right-edge,lid")
        .split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    let reps = try args.int("reps", 20)
    let interval = try args.double("interval", 1.0)
    let negSeconds = try args.double("negatives", 45)
    let restSeconds = try args.double("rest", 20)
    guard let out = args.options["out"] else { throw LabError("record needs --out FILE.gkrec") }
    guard !zones.isEmpty, reps > 0 else { throw LabError("need at least one zone and --reps > 0") }

    let header = RecordingHeader(created: isoNow(), synthetic: false, partial: false, deviceModel: deviceModel(), imuHz: 0,
                                 zones: zones, reps: reps, tapIntervalSeconds: interval, segments: [], arrays: [])
    let S = Session(rec: Recording(header: header))
    Signals.install()
    try S.stream.start()

    // Warm up and verify the stream.
    let warm = LabClock.now()
    while LabClock.now() - warm < 1.5 { S.pump(); S.tick() }
    guard S.rec.imuCount > 100 else {
        S.stream.stop()
        throw LabError("the motion sensor delivered only \(S.rec.imuCount) samples in 1.5 s; is this an Apple silicon MacBook?")
    }
    let hz = Double(S.rec.imuCount - 1) / S.rec.duration

    Terminal.rawMode()
    defer { Terminal.restore() }
    Terminal.banner(["GHOSTKEYS LAB: recording session",
                     "\(zones.count) zones x \(reps) taps, then \(Int(negSeconds)) s typing, then \(Int(restSeconds)) s hands off",
                     "sensor streaming at \(Int(hz)) Hz, noise floor \(fmt(S.onset.noiseFloor * 1000, 2)) mg"], color: Terminal.magenta)
    print("Keys: \(Terminal.bold)ENTER\(Terminal.reset) start / finish a zone early   \(Terminal.bold)r\(Terminal.reset) redo zone   \(Terminal.bold)q\(Terminal.reset) save and quit")
    print("Keep the laptop on a table, lid open, and tap with a fingertip, not a nail.")

    var quit = false

    /// Waits for ENTER (or q). Returns false if the user quit.
    func waitForEnter(_ prompt: String) -> Bool {
        print("\n\(Terminal.yellow)\(prompt)\(Terminal.reset)")
        while true {
            S.pump()
            if Signals.stopRequested { return false }
            if let k = Terminal.readKey() {
                if k == 10 || k == 13 || k == 32 { return true }
                if k == UInt8(ascii: "q") { return false }
            }
            S.tick()
        }
    }

    /// Lets the key-press vibration die away, showing a short countdown.
    func settle(_ seconds: Double, _ label: String) {
        let start = LabClock.now()
        while LabClock.now() - start < seconds {
            let left = seconds - (LabClock.now() - start)
            print("\(Terminal.clearLine)\(Terminal.dim)\(label) in \(fmt(left, 1)) s ...\(Terminal.reset)", terminator: "")
            fflush(stdout)
            S.pump(); S.tick()
        }
        print(Terminal.clearLine, terminator: "")
    }

    zoneLoop: for (zi, zone) in zones.enumerated() {
        while true {
            Terminal.banner(["ZONE \(zi + 1) OF \(zones.count)",
                             "Tap \(zone.uppercased().replacingOccurrences(of: "-", with: " ")) \(reps) times, one every \(interval == 1 ? "second" : "\(fmt(interval, 1)) s")",
                             "where: \(zoneHints[zone] ?? zone)"])
            guard waitForEnter("Put your hand in place, then press ENTER. (q = save and quit)") else { quit = true; break zoneLoop }
            settle(1.2, "Start tapping")
            let segStart = S.now
            var onsets: [Double] = []
            var endedBy = "timeout"
            var endTime: Double?
            var discarded = false
            let maxDuration = Double(reps) * interval * 2 + 10
            let wallStart = LabClock.now()
            while true {
                onsets += S.pump()
                let elapsed = LabClock.now() - wallStart
                let beat = Int(elapsed / interval)
                let pulse = (elapsed - Double(beat) * interval) < 0.15 ? "\(Terminal.green)\(Terminal.bold)  TAP  \(Terminal.reset)" : "       "
                let n = onsets.count
                let barW = 30
                let filled = min(barW, n * barW / max(reps, 1))
                let bar = String(repeating: "#", count: filled) + String(repeating: ".", count: barW - filled)
                let color = n >= reps ? Terminal.green : Terminal.cyan
                print("\(Terminal.clearLine)\(pulse) \(color)\(Terminal.bold)detected \(pad(String(n), 3, left: true)) / \(reps)\(Terminal.reset)  [\(bar)]  \(Terminal.dim)\(fmt(elapsed, 0)) s   ENTER=done r=redo\(Terminal.reset)",
                      terminator: "")
                fflush(stdout)
                if n >= reps, let last = onsets.last, S.now - last > 1.2 { endedBy = "count"; break }
                if elapsed > maxDuration { endedBy = "timeout"; break }
                if Signals.stopRequested { endedBy = "interrupt"; quit = true; break }
                if let k = Terminal.readKey() {
                    if k == 10 || k == 13 || k == 32 { endedBy = "key"; endTime = S.now - 0.3; break }
                    if k == UInt8(ascii: "r") { discarded = true; endedBy = "key"; break }
                    if k == UInt8(ascii: "q") { endedBy = "key"; endTime = S.now - 0.3; quit = true; break }
                }
                S.tick()
            }
            let segEnd = endTime ?? S.now
            onsets = onsets.filter { $0 <= segEnd }
            S.rec.header.segments.append(Segment(phase: "capture", zone: zone, start: segStart, end: segEnd, onsets: onsets,
                                                 discarded: discarded, endedBy: endedBy))
            print()
            if discarded { print("\(Terminal.yellow)discarded, let's redo \(zone)\(Terminal.reset)"); continue }
            let note = onsets.count < reps ? "\(Terminal.yellow)only \(onsets.count) of \(reps) detected (tap a bit firmer next time)\(Terminal.reset)" : "\(Terminal.green)done: \(onsets.count) taps\(Terminal.reset)"
            print(note)
            if quit { break zoneLoop }
            break
        }
    }

    func timedPhase(_ phase: String, seconds: Double, title: [String], countdown: Double) {
        Terminal.banner(title, color: phase == "rest" ? Terminal.green : Terminal.yellow)
        guard waitForEnter("Press ENTER to begin. (q = save and quit)") else { quit = true; return }
        if countdown > 0 { settle(countdown, "Starting") }
        let segStart = S.now
        let wallStart = LabClock.now()
        var onsets: [Double] = []
        var endedBy = "time"
        while LabClock.now() - wallStart < seconds {
            onsets += S.pump()
            let left = seconds - (LabClock.now() - wallStart)
            let act = S.rec.activityCount > 0 ? (S.rec.sinceKey.last!, S.rec.sinceMouse.last!) : (99, 99)
            let k = act.0 < 0.3 ? "\(Terminal.green)KEY\(Terminal.reset)" : "\(Terminal.dim)key\(Terminal.reset)"
            let m = act.1 < 0.3 ? "\(Terminal.green)PAD\(Terminal.reset)" : "\(Terminal.dim)pad\(Terminal.reset)"
            print("\(Terminal.clearLine)  \(Terminal.bold)\(pad(fmt(left, 0), 3, left: true)) s left\(Terminal.reset)   \(k) \(m)   spikes: \(onsets.count)", terminator: "")
            fflush(stdout)
            if Signals.stopRequested { endedBy = "interrupt"; quit = true; break }
            if phase == "rest", let key = Terminal.readKey(), key == UInt8(ascii: "q") { endedBy = "key"; quit = true; break }
            if phase != "rest" { _ = Terminal.readKey() }   // swallow typed keys during negatives
            S.tick()
        }
        S.rec.header.segments.append(Segment(phase: phase, zone: nil, start: segStart, end: S.now, onsets: onsets, endedBy: endedBy))
        print()
    }

    if !quit {
        timedPhase("negatives", seconds: negSeconds,
                   title: ["NEGATIVES: \(Int(negSeconds)) s",
                           "TYPE and use the TRACKPAD normally",
                           "(type anything; keys are not recorded, only their timing)"], countdown: 0)
    }
    if !quit {
        timedPhase("rest", seconds: restSeconds,
                   title: ["REST: \(Int(restSeconds)) s", "HANDS OFF the laptop", "do not touch the table either"], countdown: 2)
    }
    // Flush the tail.
    S.pump()
    S.stream.stop()
    S.rec.header.imuHz = S.rec.imuCount > 1 ? Double(S.rec.imuCount - 1) / S.rec.duration : 0
    S.rec.header.partial = quit
    try S.rec.write(to: out)
    Terminal.restore()
    let caps = S.rec.header.segments.filter { $0.phase == "capture" && !$0.discarded }
    print("\n\(Terminal.bold)saved \(out)\(Terminal.reset): \(fmt(S.rec.duration, 1)) s, \(S.rec.imuCount) samples at \(fmt(S.rec.header.imuHz, 0)) Hz, \(caps.count) zone(s), \(caps.reduce(0) { $0 + $1.onsets.count }) taps\(quit ? " (partial)" : "")")
    print("sensor settings restored. Next: ghostkeys-lab replay \(out)")
}
