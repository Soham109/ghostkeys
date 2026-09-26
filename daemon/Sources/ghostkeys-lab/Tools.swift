// `info`, `export`, `live` and `synth`.

import Foundation
import GhostkeysDetection

// MARK: - info

func runInfo(_ args: Args) throws {
    guard let path = args.positional.first else { throw LabError("info needs a .gkrec file") }
    let rec = try Recording.read(from: path)
    let h = rec.header
    print("\(Terminal.bold)\(path)\(Terminal.reset)")
    print("  created      \(h.created)\(h.synthetic ? "  (synthetic)" : "")\(h.partial ? "  (partial: stopped early)" : "")")
    print("  device       \(h.deviceModel)")
    print("  duration     \(fmt(rec.duration, 1)) s")
    print("  IMU          \(rec.imuCount) samples, header rate \(fmt(h.imuHz, 1)) Hz, measured \(rec.imuCount > 1 ? fmt(Double(rec.imuCount - 1) / rec.duration, 1) : "-") Hz")
    if rec.imuCount > 1 {
        var gaps: [Double] = []
        gaps.reserveCapacity(rec.imuCount)
        for i in 1..<rec.imuCount { gaps.append(Double(rec.t[i] - rec.t[i - 1])) }
        print("  sample gap   p50 \(fmt(percentile(gaps, 50) * 1000, 3)) ms, max \(fmt(percentile(gaps, 100) * 1000, 2)) ms")
        let n = Double(rec.imuCount)
        let g = SIMD3(rec.ax.reduce(0) { $0 + Double($1) } / n, rec.ay.reduce(0) { $0 + Double($1) } / n, rec.az.reduce(0) { $0 + Double($1) } / n)
        print("  mean accel   [\(fmt(g.x, 4)), \(fmt(g.y, 4)), \(fmt(g.z, 4))] g  (|g| \(fmt(g.magnitude, 4)))")
    }
    print("  activity     \(rec.activityCount) polls")
    print("  zones        \(h.zones.joined(separator: ", ")); reps \(h.reps), tap interval \(fmt(h.tapIntervalSeconds, 2)) s")
    if !h.notes.isEmpty { print("  notes        \(h.notes.joined(separator: "; "))") }
    print("\n  " + pad("phase", 10) + pad("zone", 14) + pad("start", 9, left: true) + pad("dur", 8, left: true) +
          pad("onsets", 8, left: true) + pad("peak mg", 9, left: true) + pad("noise mg", 10, left: true) + "  ended")
    for s in h.segments {
        let (peak, noise) = segmentStats(rec, s)
        print("  " + pad(s.phase, 10) + pad(s.zone ?? "", 14) + pad(fmt(s.start, 1), 9, left: true) + pad(fmt(s.end - s.start, 1), 8, left: true) +
              pad("\(s.onsets.count)", 8, left: true) + pad(fmt(peak * 1000, 1), 9, left: true) + pad(fmt(noise * 1000, 2), 10, left: true) +
              "  \(s.endedBy ?? "")\(s.discarded ? " (discarded)" : "")")
    }
}

/// Peak deviation of the acceleration vector from the segment mean, and the median deviation (noise).
func segmentStats(_ rec: Recording, _ s: Segment) -> (Double, Double) {
    var vs: [SIMD3<Double>] = []
    for i in 0..<rec.imuCount where Double(rec.t[i]) >= s.start && Double(rec.t[i]) <= s.end {
        vs.append(SIMD3(Double(rec.ax[i]), Double(rec.ay[i]), Double(rec.az[i])))
    }
    guard !vs.isEmpty else { return (.nan, .nan) }
    let m = vs.reduce(SIMD3<Double>.zero, +) / Double(vs.count)
    let dev = vs.map { ($0 - m).magnitude }
    return (dev.max() ?? 0, percentile(dev, 50))
}

// MARK: - export

func runExport(_ args: Args) throws {
    guard let path = args.positional.first else { throw LabError("export needs a .gkrec file") }
    guard let dir = args.options["csv"] ?? args.options["out"] else { throw LabError("export needs --csv DIR") }
    let rec = try Recording.read(from: path)
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    func url(_ n: String) -> URL { URL(fileURLWithPath: dir).appendingPathComponent(n) }

    // Label each sample with its segment.
    let segs = rec.header.segments.filter { !$0.discarded }.sorted { $0.start < $1.start }
    var out = "t,ax,ay,az,gx,gy,gz,phase,zone\n"
    out.reserveCapacity(rec.imuCount * 90)
    var si = 0
    for i in 0..<rec.imuCount {
        let t = Double(rec.t[i])
        while si < segs.count && segs[si].end < t { si += 1 }
        let seg = si < segs.count && t >= segs[si].start ? segs[si] : nil
        out += "\(rec.t[i]),\(rec.ax[i]),\(rec.ay[i]),\(rec.az[i]),\(rec.gx[i]),\(rec.gy[i]),\(rec.gz[i]),\(seg?.phase ?? ""),\(seg?.zone ?? "")\n"
    }
    try out.write(to: url("imu.csv"), atomically: true, encoding: .utf8)

    var act = "t,since_key,since_mouse,flags\n"
    for i in 0..<rec.activityCount { act += "\(rec.actT[i]),\(rec.sinceKey[i]),\(rec.sinceMouse[i]),\(Int(rec.flags[i]))\n" }
    try act.write(to: url("activity.csv"), atomically: true, encoding: .utf8)

    var sg = "phase,zone,start,end,onsets,ended_by,discarded\n"
    var on = "t,phase,zone\n"
    for s in rec.header.segments {
        sg += "\(s.phase),\(s.zone ?? ""),\(s.start),\(s.end),\(s.onsets.count),\(s.endedBy ?? ""),\(s.discarded)\n"
        if !s.discarded { for o in s.onsets { on += "\(o),\(s.phase),\(s.zone ?? "")\n" } }
    }
    try sg.write(to: url("segments.csv"), atomically: true, encoding: .utf8)
    try on.write(to: url("onsets.csv"), atomically: true, encoding: .utf8)
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try enc.encode(rec.header).write(to: url("header.json"))
    print("wrote imu.csv (\(rec.imuCount) rows), activity.csv (\(rec.activityCount)), segments.csv, onsets.csv, header.json to \(dir)")
}

// MARK: - live

func runLive(_ args: Args) throws {
    let seconds = try args.double("seconds", 0)
    var settings = DetectionSettings()
    settings.sensitivity = try args.double("sensitivity", settings.sensitivity)
    var model: ZoneModel?
    if let m = args.options["model"] {
        model = try JSONDecoder().decode(ZoneModel.self, from: Data(contentsOf: URL(fileURLWithPath: m)))
        print("model: \(m), labels \(model!.labels)")
    }
    let showOnsets = !args.flags.contains("no-lab-onsets")

    Signals.install()
    let stream = IMUStream()
    try stream.start()
    for l in stream.openLog { print("  \(Terminal.dim)\(l)\(Terminal.reset)") }
    let engine = TapEngine(settings: settings)
    engine.model = model
    let onset = LabOnsetDetector()
    var t0: Double?
    var n = 0
    var act = Activity.read()
    var counts: [String: Int] = [:]
    let wallStart = LabClock.now()
    var lastStatus = wallStart
    print("streaming\(seconds > 0 ? " for \(fmt(seconds, 0)) s" : " (Ctrl+C to stop)"); t = seconds since start")

    while !Signals.stopRequested && (seconds <= 0 || LabClock.now() - wallStart < seconds) {
        let wall = LabClock.now()
        if wall - act.t >= 0.0095 { act = Activity.read() }
        for s in stream.drain() {
            if t0 == nil { t0 = s.t }
            n += 1
            let t = s.t - t0!
            let a = SIMD3(Double(s.a.x), Double(s.a.y), Double(s.a.z))
            let dt = max(0, s.t - act.t)
            let ctx = InputContext(secondsSinceKey: act.sinceKey + dt, secondsSinceMouse: act.sinceMouse + dt, modifiers: Activity.modifiers(act.flags))
            if showOnsets, let o = onset.ingest(t: t, a: a) {
                counts["lab-onset", default: 0] += 1
                print("\(pad(fmt(o, 3), 9, left: true))  \(Terminal.dim)lab onset (threshold \(fmt(onset.threshold * 1000, 1)) mg)\(Terminal.reset)")
            }
            for e in engine.ingest(IMUSample(t: t, a: a, g: SIMD3(Double(s.g.x), Double(s.g.y), Double(s.g.z))), context: ctx) {
                switch e {
                case .candidate(let f):
                    counts["candidate", default: 0] += 1
                    var line = "\(pad(fmt(f.t, 3), 9, left: true))  \(Terminal.cyan)candidate\(Terminal.reset) \(featureSummary(f))"
                    if let model {
                        let c = model.classify(f)
                        line += "  -> \(Terminal.bold)\(c.zone)\(Terminal.reset) conf \(fmt(c.confidence, 2)) at (\(fmt(c.x, 2)), \(fmt(c.y, 2)))"
                    }
                    print(line)
                case .tap(let tap):
                    counts["tap", default: 0] += 1
                    print("\(pad(fmt(tap.t, 3), 9, left: true))  \(Terminal.green)\(Terminal.bold)TAP \(tap.zone)\(Terminal.reset) conf \(fmt(tap.confidence, 2)) strength \(fmt(tap.strength, 2)) at (\(fmt(tap.x, 2)), \(fmt(tap.y, 2)))\(tap.modifiers.isEmpty ? "" : " +" + tap.modifiers.sorted().joined(separator: "+")) delay \(fmt((t - tap.t) * 1000, 1)) ms")
                case .rejected(let rt, let reason):
                    counts["rejected", default: 0] += 1
                    print("\(pad(fmt(rt, 3), 9, left: true))  \(Terminal.yellow)rejected\(Terminal.reset) \(reason.rawValue)")
                case .gesture(let g):
                    counts["gesture", default: 0] += 1
                    print("\(pad(fmt(g.t, 3), 9, left: true))  \(Terminal.magenta)\(Terminal.bold)GESTURE \(g.gesture)\(Terminal.reset) \(g.zones.joined(separator: ">")) conf \(fmt(g.confidence, 2))")
                }
            }
        }
        if wall - lastStatus >= 2 {
            lastStatus = wall
            let rate = Double(n) / max(wall - wallStart, 1e-3)
            print("\(Terminal.dim)  .. \(n) samples (\(fmt(rate, 0))/s, accel reports \(stream.accelCount), gyro reports \(stream.gyroCount)), noise floor \(fmt(onset.noiseFloor * 1000, 2)) mg, key \(fmt(min(act.sinceKey, 999), 1)) s ago, pad \(fmt(min(act.sinceMouse, 999), 1)) s ago\(Terminal.reset)")
        }
        usleep(5_000)
    }
    let elapsed = LabClock.now() - wallStart
    stream.stop()
    print("\nstopped after \(fmt(elapsed, 1)) s: \(n) samples (\(fmt(Double(n) / elapsed, 0)) Hz), accel reports \(stream.accelCount), gyro reports \(stream.gyroCount)")
    print("events: " + (counts.isEmpty ? "none" : counts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")))
    print("sensor driver settings restored")
}

func featureSummary(_ f: TapFeatures) -> String {
    let v = f.values
    let norm = v.reduce(0) { $0 + $1 * $1 }.squareRoot()
    let head = v.prefix(8).map { fmt($0, 3) }.joined(separator: " ")
    return "n=\(v.count) |f|=\(fmt(norm, 2)) [\(head)\(v.count > 8 ? " ..." : "")]"
}

// MARK: - synth

struct ZoneSignature {
    var dir: SIMD3<Double>
    var gyroDir: SIMD3<Double>
    var freq: Double
    var tau: Double
    var gyroGain: Double
}

func runSynth(_ args: Args) throws {
    guard let out = args.options["out"] else { throw LabError("synth needs --out FILE.gkrec") }
    let zones = (args.options["zones"] ?? "left-palm,right-palm,left-grille,right-grille,top-strip,left-edge,right-edge,lid")
        .split(separator: ",").map(String.init)
    let reps = try args.int("reps", 20)
    let negSeconds = try args.double("negatives", 45)
    let restSeconds = try args.double("rest", 20)
    let hz = try args.double("hz", 797)
    let noiseG = try args.double("noise", 0.0015)
    var rng = SplitMix(seed: UInt64(try args.int("seed", 7)))
    let dt = 1 / hz

    func unit() -> SIMD3<Double> {
        let v = SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian())
        return v / v.magnitude
    }
    var sigs: [String: ZoneSignature] = [:]
    for z in zones {
        sigs[z] = ZoneSignature(dir: unit(), gyroDir: unit(), freq: Double.random(in: 60...260, using: &rng),
                                tau: Double.random(in: 0.006...0.022, using: &rng), gyroGain: Double.random(in: 40...140, using: &rng))
    }

    struct Impulse { var t: Double; var amp: Double; var dir: SIMD3<Double>; var gyro: SIMD3<Double>; var freq: Double; var tau: Double }
    var impulses: [Impulse] = []
    var keyTimes: [Double] = []
    var mouseTimes: [Double] = []
    var segments: [Segment] = []

    var t = 1.0
    for z in zones {
        let s = sigs[z]!
        // "press ENTER" just before the segment
        t += 1.0
        keyTimes.append(t)
        impulses.append(Impulse(t: t + 0.004, amp: 0.012, dir: SIMD3(0.1, 0.2, 1) / SIMD3(0.1, 0.2, 1).magnitude, gyro: .zero, freq: 220, tau: 0.008))
        t += 1.2
        let start = t
        var onsets: [Double] = []
        t += 0.8
        for _ in 0..<reps {
            let amp = exp(Double.random(in: log(0.03)...log(0.12), using: &rng))
            var d = s.dir + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.08
            d /= d.magnitude
            let gy = (s.gyroDir + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.1) * s.gyroGain * amp
            impulses.append(Impulse(t: t, amp: amp, dir: d, gyro: gy, freq: s.freq * Double.random(in: 0.93...1.07, using: &rng),
                                    tau: s.tau * Double.random(in: 0.85...1.15, using: &rng)))
            onsets.append(t)
            t += 1.0 + rng.gaussian() * 0.12
        }
        t += 0.5
        segments.append(Segment(phase: "capture", zone: z, start: start, end: t, onsets: onsets, endedBy: "count"))
    }
    // Negatives: typing bursts, trackpad glides and clicks.
    t += 1.0
    keyTimes.append(t)
    let negStart = t + 0.2
    var tt = negStart
    let negEnd = negStart + negSeconds
    while tt < negEnd {
        let burstEnd = min(negEnd, tt + Double.random(in: 1.5...4, using: &rng))
        while tt < burstEnd {
            keyTimes.append(tt)
            let hard = Double.random(in: 0...1, using: &rng) < 0.08
            let amp = hard ? Double.random(in: 0.025...0.06, using: &rng) : Double.random(in: 0.004...0.02, using: &rng)
            var d = SIMD3(rng.gaussian() * 0.3, rng.gaussian() * 0.3, 1.0); d /= d.magnitude
            impulses.append(Impulse(t: tt + 0.004, amp: amp, dir: d, gyro: SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * amp * 30,
                                    freq: Double.random(in: 150...320, using: &rng), tau: Double.random(in: 0.004...0.01, using: &rng)))
            tt += max(0.05, 0.16 + rng.gaussian() * 0.06)
        }
        // trackpad for a while
        let padEnd = min(negEnd, tt + Double.random(in: 0.8...2.5, using: &rng))
        var mt = tt
        while mt < padEnd { mouseTimes.append(mt); mt += 1.0 / 60 }
        if Double.random(in: 0...1, using: &rng) < 0.6 {
            let ct = Double.random(in: tt...max(tt, padEnd - 0.01), using: &rng)
            impulses.append(Impulse(t: ct, amp: Double.random(in: 0.01...0.035, using: &rng), dir: SIMD3(0, 0.3, 0.95) / SIMD3(0, 0.3, 0.95).magnitude,
                                    gyro: SIMD3(0.5, 0, 0) * 2, freq: 180, tau: 0.007))
        }
        tt = padEnd
    }
    segments.append(Segment(phase: "negatives", zone: nil, start: negStart, end: negEnd, onsets: [], endedBy: "time"))
    t = negEnd + 1.0
    keyTimes.append(t)
    let restStart = t + 2.0
    let restEnd = restStart + restSeconds
    segments.append(Segment(phase: "rest", zone: nil, start: restStart, end: restEnd, onsets: [], endedBy: "time"))
    let total = restEnd + 0.5

    // Render.
    let header = RecordingHeader(created: isoNow(), synthetic: true, partial: false, deviceModel: "synthetic", imuHz: hz, zones: zones,
                                 reps: reps, tapIntervalSeconds: 1.0, segments: segments, arrays: [],
                                 notes: ["synthetic: damped sinusoid taps with a per-zone direction, frequency and decay; typing and trackpad impulses in negatives"])
    var rec = Recording(header: header)
    impulses.sort { $0.t < $1.t }
    let gravity = SIMD3(0.0, 0.0, -1.0)
    var active: [Impulse] = []
    var next = 0
    let n = Int(total / dt)
    let onset = LabOnsetDetector()
    var negOnsets: [Double] = []
    var restOnsets: [Double] = []
    for i in 0..<n {
        let ti = Double(i) * dt
        while next < impulses.count && impulses[next].t <= ti { active.append(impulses[next]); next += 1 }
        active.removeAll { ti - $0.t > $0.tau * 8 }
        var a = gravity + SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * noiseG
        var g = SIMD3(rng.gaussian(), rng.gaussian(), rng.gaussian()) * 0.05
        for im in active {
            let x = ti - im.t
            let env = exp(-x / im.tau)
            a += im.dir * (im.amp * env * sin(2 * .pi * im.freq * x))
            g += im.gyro * (env * cos(2 * .pi * im.freq * 0.5 * x))
        }
        rec.t.append(Float(ti))
        rec.ax.append(Float(a.x)); rec.ay.append(Float(a.y)); rec.az.append(Float(a.z))
        rec.gx.append(Float(g.x)); rec.gy.append(Float(g.y)); rec.gz.append(Float(g.z))
        if let o = onset.ingest(t: ti, a: a) {
            if o >= negStart && o <= negEnd { negOnsets.append(o) }
            if o >= restStart && o <= restEnd { restOnsets.append(o) }
        }
    }
    rec.header.segments[rec.header.segments.count - 2].onsets = negOnsets
    rec.header.segments[rec.header.segments.count - 1].onsets = restOnsets
    // Activity at 100 Hz.
    var ki = 0, mi = 0
    var lastKey = -100.0, lastMouse = -100.0
    var pt = 0.0
    while pt < total {
        while ki < keyTimes.count && keyTimes[ki] <= pt { lastKey = keyTimes[ki]; ki += 1 }
        while mi < mouseTimes.count && mouseTimes[mi] <= pt { lastMouse = mouseTimes[mi]; mi += 1 }
        rec.actT.append(Float(pt)); rec.sinceKey.append(Float(pt - lastKey)); rec.sinceMouse.append(Float(pt - lastMouse)); rec.flags.append(0)
        pt += 0.01
    }
    try rec.write(to: out)
    print("wrote \(out): \(fmt(total, 1)) s, \(rec.imuCount) samples at \(fmt(hz, 0)) Hz, \(zones.count) zones x \(reps) taps, \(keyTimes.count) keystrokes, negatives \(fmt(negSeconds, 0)) s, rest \(fmt(restSeconds, 0)) s")
}
