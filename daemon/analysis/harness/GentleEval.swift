import Testing
@testable import GhostkeysDetection

// Temporary evaluation: gentle taps (8 to 15 mg) on a quiet desk, old fixed floor vs adaptive floor.
// Background = the real 12 s rest recording, looped. Copy into Tests/GhostkeysDetectionTests to run.

private let restBG = restRecording()
private func background(seconds: Double) -> [IMUSample] {
    let n = Int(seconds * fs)
    return (0..<n).map { i in var s = restBG[i % restBG.count]; s.t = Double(i) / fs; return s }
}
/// Adds a synthetic event stream (built with noiseMg 0) onto a background.
private func mix(_ bg: [IMUSample], _ b: StreamBuilder) -> [IMUSample] {
    let syn = b.samples()
    return zip(bg, syn).map { r, s in
        IMUSample(t: r.t, a: r.a + (s.a - StreamBuilder.restGravity), g: r.g + (s.g - SIMD3(0.121, -0.092, -0.006)))
    }
}
/// Peak detection level (mg) of each event, measured on the event-only signal.
private func hpPeaks(_ b: StreamBuilder, at times: [Double]) -> [Double] {
    var d = OnsetDetector()
    var level: [Double] = []
    for (i, s) in b.samples().enumerated() {
        _ = d.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t, index: i); level.append(d.level)
    }
    return times.map { t in
        let i0 = Int(t * fs); return (level[max(0, i0 - 2)..<min(level.count, i0 + 60)].max() ?? 0) * 1000
    }
}
private func engine(legacy: Bool, model: ZoneModel? = nil, capture: Bool = false) -> TapEngine {
    let e = TapEngine(settings: DetectionSettings())
    e.onset.legacyThreshold = legacy
    e.model = model
    e.bypassInputGates = capture
    return e
}
private let zones: [ZoneSpec] = [.leftPalm, .rightPalm, .leftGrille, .rightGrille, .topStrip]

/// Gentle-tap stream: amplitudes chosen so the detection-level peak lands in 8...15 mg.
private var band: ClosedRange<Double> = 0.008...0.015
private func gentleStream(seconds: Double, zones zs: [ZoneSpec], every: Double, seed: UInt64)
    -> (samples: [IMUSample], truth: [(Double, String)], peaks: [Double]) {
    var b = StreamBuilder(seconds: seconds, seed: seed, noiseMg: 0)
    var rng = Rng(seed &+ 5)
    var truth: [(Double, String)] = []
    var t = 1.0, k = 0
    while t < seconds - 0.5 {
        let z = zs[k % zs.count]
        // Force pulse to detection-level peak is about 1.4x for these synthetic zones; aim 8..15 mg.
        truth.append((b.addTap(z, at: t, amp: rng.uniform(band.lowerBound, band.upperBound) / 1.4), z.name))
        t += every + rng.uniform(0, 0.2); k += 1
    }
    let peaks = hpPeaks(b, at: truth.map(\.0))
    return (mix(background(seconds: seconds), b), truth, peaks)
}

private func calibrate(legacy: Bool) -> (ZoneModel?, Int) {
    let t = Trainer()
    for (zi, z) in zones.enumerated() {
        let g = gentleStream(seconds: 16, zones: [z], every: 0.6, seed: 100 + UInt64(zi))
        let e = engine(legacy: legacy, capture: true)
        for f in run(e, g.samples).candidates where g.truth.contains(where: { abs($0.0 - f.t) < 0.02 }) { t.add(f, label: z.name) }
    }
    // Typing negatives, captured the way the daemon does (gates bypassed).
    var b = StreamBuilder(seconds: 16, seed: 77, noiseMg: 0)
    for k in 0..<60 { b.addKeystroke(at: 1 + Double(k) * 0.24) }
    let e = engine(legacy: legacy, capture: true)
    for f in run(e, mix(background(seconds: 16), b)).candidates { t.add(f, label: "none") }
    let captured = t.counts.filter { $0.key != "none" }.values.reduce(0, +)
    let zonesWithData = t.counts.filter { $0.key != "none" && $0.value >= 3 }.count
    guard zonesWithData >= 2 else { return (nil, captured) }
    let (m, report) = t.train()
    print("GE calibration report overall \(String(format: "%.2f", report.overall)) \(report.accuracy.mapValues { Int($0 * 100) })")
    return (m, captured)
}

/// Old vs new, for one tap-strength band: onset recall, calibration, live recall, false taps/min.
@Test func zzGentle() {
    for (bandName, b) in [("gentle 8-15 mg", 0.008...0.015), ("light 15-40 mg", 0.015...0.040)] {
        band = b
        for legacy in [true, false] {
            let name = "\(bandName), \(legacy ? "OLD" : "NEW")"
            let g = gentleStream(seconds: 60, zones: zones, every: 0.7, seed: 1)
            let ev = run(engine(legacy: legacy), g.samples)
            let hits = match(detected: ev.candidates.map(\.t), truth: g.truth.map(\.0)).hits
            let (model, captured) = calibrate(legacy: legacy)
            guard let model else {
                print("GE \(name): onset recall (no model) \(hits)/\(g.truth.count); calibration captured \(captured)/120: no usable model")
                continue
            }
            let live = run(engine(legacy: legacy, model: model), g.samples)
            let liveOnsets = match(detected: live.candidates.map(\.t), truth: g.truth.map(\.0)).hits
            let missed = g.truth.filter { tr in !live.candidates.contains { abs($0.t - tr.0) < 0.02 } }
            let why = missed.map { tr -> String in
                if let r = live.rejections.first(where: { abs($0.t - tr.0) < 0.03 }) { return "\(r.reason)" }
                let bgT = tr.0.truncatingRemainder(dividingBy: Double(restBG.count) / fs)
                return "none(bg \(String(format: "%.1f", bgT)))"
            }
            // Split by background: quiet stretches of the rest recording vs its disturbed ones.
            func quietBG(_ t: Double) -> Bool {
                let b = t.truncatingRemainder(dividingBy: Double(restBG.count) / fs)
                return (0.2...3.3).contains(b) || (6.5...8.9).contains(b) || (11.0...11.9).contains(b)
            }
            for (label, sel) in [("quiet", true), ("disturbed", false)] {
                let tr = g.truth.filter { quietBG($0.0) == sel }
                let on = tr.filter { x in live.candidates.contains { abs($0.t - x.0) < 0.02 } }.count
                let ok = tr.filter { x in live.taps.contains { abs($0.t - x.0) < 0.02 && $0.zone == x.1 } }.count
                print("GE \(name) [\(label) background]: onset recall \(on)/\(tr.count), zone-correct taps \(ok)/\(tr.count)")
            }
            print("GE \(name): missed onsets: \(Dictionary(grouping: why, by: { $0.hasPrefix("none") ? "no onset" : $0 }).mapValues(\.count)) \(why.filter { $0.hasPrefix("none") })")
            let correct = live.taps.filter { tap in g.truth.contains { abs($0.0 - tap.t) < 0.02 && $0.1 == tap.zone } }.count
            let rest = run(engine(legacy: legacy, model: model), background(seconds: 60))
            var tb = StreamBuilder(seconds: 60, seed: 5, noiseMg: 3)
            var keys = InputScript()
            var t = 0.5
            var rng = Rng(9)
            while t < 59.5 { tb.addKeystroke(at: t); keys.keys.append(t); t += rng.uniform(0.12, 0.35) }
            keys.delay = 0.01
            let typing = mix(background(seconds: 60), tb)
            let typed = run(engine(legacy: legacy, model: model), typing, input: keys)
            let blind = run(engine(legacy: legacy, model: model), typing)
            print("GE \(name): onset recall \(hits)/\(g.truth.count) (with learned floor \(liveOnsets)); calibration captured \(captured)/120, floor \(String(format: "%.1f", (model.onsetFloor ?? 0) * 1000)) mg; zone-correct taps \(correct)/\(g.truth.count), wrong or extra \(live.taps.count - correct); false taps/min: quiet desk \(rest.taps.count), typing \(typed.taps.count), typing with key events ignored \(blind.taps.count)")
        }
    }
}

@Test func zzScaledLab() {
    let base = "/Users/sohamaggarwal/Desktop/Projects/ghostkeys/daemon/analysis/data/session1/"
    let imu = zzLoadIMU(base + "imu.csv")
    let onsets = zzLoadOnsets(base + "onsets.csv")
    let lfs = 796.4
    // Templates: 100 ms before to 250 ms after each recorded tap, minus the mean of the first 60 ms.
    var templates: [(zone: String, a: [SIMD3<Double>], g: [SIMD3<Double>], peak: Double)] = []
    var d = OnsetDetector(); var lvl: [Double] = []
    for (i, s) in imu.enumerated() { _ = d.process(ax: s.a.x, ay: s.a.y, az: s.a.z, t: s.t, index: i); lvl.append(d.level) }
    for o in onsets {
        let i0 = Int(o.t * lfs) - Int(0.1 * lfs), i1 = Int(o.t * lfs) + Int(0.25 * lfs)
        guard i0 > 0, i1 < imu.count else { continue }
        let pre = imu[i0..<(i0 + Int(0.06 * lfs))]
        let ma = pre.map(\.a).reduce(SIMD3(0, 0, 0), +) / Double(pre.count)
        let mg = pre.map(\.g).reduce(SIMD3(0, 0, 0), +) / Double(pre.count)
        let peak = lvl[(Int(o.t * lfs) - 2)..<(Int(o.t * lfs) + 60)].max()! * 1000
        templates.append((o.zone, imu[i0..<i1].map { $0.a - ma }, imu[i0..<i1].map { $0.g - mg }, peak))
    }
    for (label, scale) in [("25-50% of recorded strength", { (_: Double, r: inout Rng) in r.uniform(0.25, 0.5) }),
                           ("scaled to 8-15 mg peaks", { (p: Double, r: inout Rng) in r.uniform(8, 15) / p })] {
        let bg = background(seconds: Double(templates.count) * 0.8 + 2)
        var mixed = bg
        var rng = Rng(3)
        var truth: [Double] = []
        for (k, tp) in templates.enumerated() {
            let f = scale(tp.peak, &rng)
            let start = Int((1 + Double(k) * 0.8) * fs)
            for j in 0..<tp.a.count where start + j < mixed.count {
                mixed[start + j].a += tp.a[j] * f
                mixed[start + j].g += tp.g[j] * f
            }
            truth.append(Double(start) / fs + 0.1)
        }
        for legacy in [true, false] {
            let ev = run(engine(legacy: legacy), mixed)
            let m = match(detected: ev.candidates.map(\.t), truth: truth, tolerance: 0.08)
            print("GL lab taps \(label), \(legacy ? "OLD" : "NEW"): onset recall \(m.hits)/\(truth.count), other candidates \(m.falsePositives), rejected \(ev.rejections.count)")
        }
    }
}
