// `ghostkeys-lab replay`: feed a recording through GhostkeysDetection and score it.
//
// Ground truth: the tap onsets stored per capture segment (lab onset detector while recording, true times for synth).
// Training examples: TapEngine `.candidate` features matched to a ground-truth tap (within --match-ms), labeled with
// the segment's zone, plus candidates from the training part of the negatives phase labeled "none".
// Testing: a second TapEngine run with the trained model; each held-out ground-truth tap is matched to the accepted
// `.tap` event nearest in time (else to a `.rejected` event, else counted as missed).

import Foundation
import GhostkeysDetection

struct EngineRun {
    var candidates: [TapFeatures] = []
    var taps: [(event: TapEvent, emittedAt: Double)] = []
    var rejected: [(t: Double, reason: RejectReason, emittedAt: Double)] = []
    var gestures: [(event: GestureEvent, emittedAt: Double)] = []
    var ingestNs: [Double] = []
}

/// `capture: true` mirrors the daemon's calibration capture (input gates bypassed so keystrokes and clicks in the
/// negatives phase become "none" examples); `false` is normal operation.
func runEngine(_ rec: Recording, settings: DetectionSettings, model: ZoneModel?, capture: Bool) -> EngineRun {
    let engine = TapEngine(settings: settings)
    engine.model = model
    engine.bypassInputGates = capture
    var run = EngineRun()
    run.ingestNs.reserveCapacity(rec.imuCount)
    rec.forEachSample { _, s, ctx in
        let start = DispatchTime.now().uptimeNanoseconds
        let events = engine.ingest(s, context: ctx)
        run.ingestNs.append(Double(DispatchTime.now().uptimeNanoseconds - start))
        for e in events {
            switch e {
            case .candidate(let f): run.candidates.append(f)
            case .tap(let tap): run.taps.append((tap, s.t))
            case .rejected(let t, let reason): run.rejected.append((t, reason, s.t))
            case .gesture(let g): run.gestures.append((g, s.t))
            }
        }
    }
    return run
}

struct GTTap {
    var zone: String
    var t: Double
    var features: TapFeatures?
}

/// A time range where accepted taps are false triggers.
struct NegWindow { var phase: String; var start: Double; var end: Double }

struct FoldResult {
    var labels: [String]                       // zones + "none"
    var confusion: [[Int]]                     // rows: true zone, cols: labels
    var extras: [String: Int] = [:]            // accepted taps inside capture segments with no ground truth
    var falseTriggers: [String: Int] = [:]     // per phase ("negatives", "rest")
    var falseGestures: [String: Int] = [:]
    var negSeconds: [String: Double] = [:]
    var rejectReasons: [String: Int] = [:]     // for held-out taps that were rejected
    var negRejectReasons: [String: Int] = [:]  // rejections during negatives/rest test windows
    var emitLatency: [Double] = []             // emittedAt - tap.t   (seconds)
    var onsetLatency: [Double] = []            // emittedAt - ground-truth onset
    var trainerReport: CalibrationReport?
    var trainCounts: [String: Int] = [:]
}

func runReplay(_ args: Args) throws {
    guard let path = args.positional.first else { throw LabError("replay needs a .gkrec file") }
    let rec = try Recording.read(from: path)
    let holdout = try args.double("holdout", 0.25)
    let kfold = try args.int("kfold", 0)
    let seed = UInt64(try args.int("seed", 42))
    let matchWindow = try args.double("match-ms", 80) / 1000
    var settings = DetectionSettings()
    settings.sensitivity = try args.double("sensitivity", settings.sensitivity)
    if let v = args.options["min-confidence"] { settings.minConfidence = Double(v) ?? settings.minConfidence }
    if let v = args.options["typing-gate-ms"] { settings.typingGateMs = Double(v) ?? settings.typingGateMs }
    let useNegatives = !args.flags.contains("no-negatives")

    let zones = rec.header.zones
    let caps = rec.header.segments.filter { $0.phase == "capture" && !$0.discarded }
    print("\(Terminal.bold)replay\(Terminal.reset) \(path): \(fmt(rec.duration, 1)) s, \(rec.imuCount) samples @ \(fmt(rec.header.imuHz, 0)) Hz\(rec.header.synthetic ? " (synthetic)" : "")")
    print("settings: sensitivity \(settings.sensitivity), minConfidence \(settings.minConfidence), typingGateMs \(settings.typingGateMs); match window +/-\(Int(matchWindow * 1000)) ms")

    // Pass 1: candidates, no model, calibration-capture mode.
    let base = runEngine(rec, settings: settings, model: nil, capture: true)
    var gt: [GTTap] = []
    var used = Set<Int>()
    let candTimes = base.candidates.map { $0.t }
    for seg in caps {
        for o in seg.onsets {
            var best: Int?
            var bestD = matchWindow
            // candidates are time-ordered; a linear scan is fine at these sizes
            var lo = 0, hi = candTimes.count
            while lo < hi { let m = (lo + hi) / 2; if candTimes[m] < o - matchWindow { lo = m + 1 } else { hi = m } }
            var i = lo
            while i < candTimes.count && candTimes[i] <= o + matchWindow {
                let d = abs(candTimes[i] - o)
                if d <= bestD && !used.contains(i) { best = i; bestD = d }
                i += 1
            }
            if let b = best { used.insert(b) }
            gt.append(GTTap(zone: seg.zone ?? "?", t: o, features: best.map { base.candidates[$0] }))
        }
    }
    let unmatchedInCapture = base.candidates.enumerated().filter { i, c in
        !used.contains(i) && caps.contains { c.t >= $0.start && c.t <= $0.end }
    }.count
    let negSegs = rec.header.segments.filter { $0.phase == "negatives" && !$0.discarded }
    let restSegs = rec.header.segments.filter { $0.phase == "rest" && !$0.discarded }
    func count(_ times: [Double], in segs: [Segment]) -> Int { times.filter { t in segs.contains { t >= $0.start && t <= $0.end } }.count }

    print("\n\(Terminal.bold)Onset stage (TapEngine candidates, no model)\(Terminal.reset)")
    print("  " + pad("zone", 14) + pad("taps", 6, left: true) + pad("found", 7, left: true) + pad("recall", 8, left: true))
    for z in zones {
        let zs = gt.filter { $0.zone == z }
        guard !zs.isEmpty else { continue }
        let found = zs.filter { $0.features != nil }.count
        print("  " + pad(z, 14) + pad("\(zs.count)", 6, left: true) + pad("\(found)", 7, left: true) + pad(fmt(Double(found) / Double(zs.count), 2), 8, left: true))
    }
    print("  candidates total \(base.candidates.count); unmatched inside capture \(unmatchedInCapture); in negatives \(count(candTimes, in: negSegs)); in rest \(count(candTimes, in: restSegs))")
    if base.candidates.isEmpty {
        print("\(Terminal.yellow)  TapEngine produced no candidates: the detection library is still a stub, or its onset detector found nothing in this recording.\(Terminal.reset)")
    }
    if let f = base.candidates.first { print("  feature vector length \(f.values.count)") }

    // Split and evaluate.
    var rng = SplitMix(seed: seed)
    var byZone: [String: [Int]] = [:]
    for (i, g) in gt.enumerated() { byZone[g.zone, default: []].append(i) }
    for z in byZone.keys { byZone[z]!.shuffle(using: &rng) }

    let k = kfold >= 2 ? kfold : 1
    var folds: [FoldResult] = []
    for fold in 0..<k {
        var testIdx = Set<Int>()
        for (_, idx) in byZone {
            if k == 1 {
                let n = idx.count
                var nTest = Int((Double(n) * holdout).rounded())
                if n >= 2 { nTest = min(max(nTest, 1), n - 1) } else { nTest = 0 }
                testIdx.formUnion(idx.suffix(nTest))
            } else {
                for (j, i) in idx.enumerated() where j % k == fold { testIdx.insert(i) }
            }
        }
        // Negatives: the test window is one contiguous time block of each negatives segment.
        var negTrain: [(Double, Double)] = []
        var testWindows: [NegWindow] = []
        for s in negSegs {
            let d = s.end - s.start
            let (a, b): (Double, Double) = k == 1 ? (s.start + d * (1 - holdout), s.end)
                                                  : (s.start + d * Double(fold) / Double(k), s.start + d * Double(fold + 1) / Double(k))
            testWindows.append(NegWindow(phase: "negatives", start: a, end: b))
            if a > s.start { negTrain.append((s.start, a)) }
            if b < s.end { negTrain.append((b, s.end)) }
        }
        for s in restSegs { testWindows.append(NegWindow(phase: "rest", start: s.start, end: s.end)) }

        let trainer = Trainer()
        var trainCounts: [String: Int] = [:]
        for (i, g) in gt.enumerated() where !testIdx.contains(i) {
            if let f = g.features { trainer.add(f, label: g.zone); trainCounts[g.zone, default: 0] += 1 }
        }
        if useNegatives {
            for c in base.candidates where negTrain.contains(where: { c.t >= $0.0 && c.t <= $0.1 }) {
                trainer.add(c, label: "none"); trainCounts["none", default: 0] += 1
            }
        }
        let (model, report) = trainer.train()
        let run = runEngine(rec, settings: settings, model: model, capture: false)
        var r = score(rec: rec, gt: gt, testIdx: testIdx, run: run, zones: zones, caps: caps, windows: testWindows, matchWindow: matchWindow)
        r.trainerReport = report
        r.trainCounts = trainCounts
        if k == 1 {
            // keep the per-sample cost from the model run
            let ns = run.ingestNs
            printReport(r, title: "Holdout \(Int(holdout * 100))% (seed \(seed))", ingestNs: ns)
        }
        folds.append(r)
    }
    if k > 1 {
        var agg = folds[0]
        agg.trainerReport = nil   // per-fold self-reports are printed above
        for f in folds.dropFirst() {
            for i in agg.confusion.indices { for j in agg.confusion[i].indices { agg.confusion[i][j] += f.confusion[i][j] } }
            for (a, b) in f.extras { agg.extras[a, default: 0] += b }
            for (a, b) in f.falseTriggers { agg.falseTriggers[a, default: 0] += b }
            for (a, b) in f.falseGestures { agg.falseGestures[a, default: 0] += b }
            for (a, b) in f.negSeconds { agg.negSeconds[a, default: 0] += b }
            for (a, b) in f.rejectReasons { agg.rejectReasons[a, default: 0] += b }
            for (a, b) in f.negRejectReasons { agg.negRejectReasons[a, default: 0] += b }
            agg.emitLatency += f.emitLatency
            agg.onsetLatency += f.onsetLatency
        }
        print("\n(per-fold trainer self-reports: \(folds.map { fmt($0.trainerReport?.overall ?? .nan, 2) }.joined(separator: ", ")))")
        printReport(agg, title: "\(k)-fold cross-validation (seed \(seed)); rest is tested in every fold", ingestNs: nil)
    }

    if let out = args.options["save-model"] {
        let trainer = Trainer()
        for g in gt { if let f = g.features { trainer.add(f, label: g.zone) } }
        if useNegatives {
            for c in base.candidates where negSegs.contains(where: { c.t >= $0.start && c.t <= $0.end }) { trainer.add(c, label: "none") }
        }
        let (model, report) = trainer.train()
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(model).write(to: URL(fileURLWithPath: out))
        print("\nsaved model trained on all taps to \(out) (trainer self-report overall \(fmt(report.overall, 3)))")
    }
}

func score(rec: Recording, gt: [GTTap], testIdx: Set<Int>, run: EngineRun, zones: [String], caps: [Segment],
           windows: [NegWindow], matchWindow: Double) -> FoldResult {
    let labels = zones + ["none"]
    var r = FoldResult(labels: labels, confusion: Array(repeating: Array(repeating: 0, count: labels.count), count: zones.count))
    let tapTimes = run.taps.map { $0.event.t }
    var claimed = Set<Int>()

    func nearest(_ times: [Double], _ t: Double, exclude: Set<Int>) -> Int? {
        var best: Int?, bestD = matchWindow
        for (i, x) in times.enumerated() where abs(x - t) <= bestD && !exclude.contains(i) { best = i; bestD = abs(x - t) }
        return best
    }
    // Every ground-truth tap (held-out first) claims its nearest accepted tap, so taps near training examples are
    // not counted as extras.
    let order = gt.indices.sorted { testIdx.contains($0) && !testIdx.contains($1) }
    for i in order {
        let g = gt[i]
        let m = nearest(tapTimes, g.t, exclude: claimed)
        if let m { claimed.insert(m) }
        guard testIdx.contains(i), let row = zones.firstIndex(of: g.zone) else { continue }
        if let m {
            let tap = run.taps[m]
            let col = labels.firstIndex(of: tap.event.zone) ?? labels.count - 1
            r.confusion[row][col] += 1
            r.emitLatency.append(tap.emittedAt - tap.event.t)
            r.onsetLatency.append(tap.emittedAt - g.t)
        } else {
            r.confusion[row][labels.count - 1] += 1
            let rj = run.rejected.filter { abs($0.t - g.t) <= matchWindow }.min { abs($0.t - g.t) < abs($1.t - g.t) }
            r.rejectReasons[rj.map { $0.reason.rawValue } ?? "not_detected", default: 0] += 1
        }
    }
    for (i, tap) in run.taps.enumerated() where !claimed.contains(i) {
        if caps.contains(where: { tap.event.t >= $0.start && tap.event.t <= $0.end }) {
            r.extras[tap.event.zone, default: 0] += 1
        }
    }
    for w in windows {
        r.negSeconds[w.phase, default: 0] += w.end - w.start
        r.falseTriggers[w.phase, default: 0] += run.taps.filter { $0.event.t >= w.start && $0.event.t <= w.end }.count
        r.falseGestures[w.phase, default: 0] += run.gestures.filter { $0.event.t >= w.start && $0.event.t <= w.end }.count
        for rj in run.rejected where rj.t >= w.start && rj.t <= w.end { r.negRejectReasons["\(w.phase):\(rj.reason.rawValue)", default: 0] += 1 }
        // False triggers by predicted zone, for precision.
        for tap in run.taps where tap.event.t >= w.start && tap.event.t <= w.end {
            r.extras["neg:" + tap.event.zone, default: 0] += 1
        }
    }
    return r
}

func printReport(_ r: FoldResult, title: String, ingestNs: [Double]?) {
    let zones = Array(r.labels.dropLast())
    print("\n\(Terminal.bold)\(title)\(Terminal.reset)")
    if let rep = r.trainerReport {
        let counts = r.trainCounts.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ")
        print("  trained on: \(counts.isEmpty ? "nothing (no candidates matched)" : counts)")
        print("  trainer self-report: overall \(fmt(rep.overall, 3)), labels \(rep.labels)")
    }
    print("\n  per zone (precision counts extra taps in capture + false triggers in negatives/rest as false positives)")
    print("  " + pad("zone", 14) + pad("test", 6, left: true) + pad("TP", 5, left: true) + pad("FP", 5, left: true) +
          pad("prec", 7, left: true) + pad("recall", 8, left: true))
    var totalTP = 0, totalN = 0
    for (zi, z) in zones.enumerated() {
        let n = r.confusion[zi].reduce(0, +)
        let tp = r.confusion[zi][zi]
        let wrongIn = zones.indices.filter { $0 != zi }.reduce(0) { $0 + r.confusion[$1][zi] }
        let fp = wrongIn + (r.extras[z] ?? 0) + (r.extras["neg:" + z] ?? 0)
        totalTP += tp; totalN += n
        let prec = tp + fp > 0 ? Double(tp) / Double(tp + fp) : Double.nan
        let rec = n > 0 ? Double(tp) / Double(n) : Double.nan
        print("  " + pad(z, 14) + pad("\(n)", 6, left: true) + pad("\(tp)", 5, left: true) + pad("\(fp)", 5, left: true) +
              pad(fmt(prec, 2), 7, left: true) + pad(fmt(rec, 2), 8, left: true))
    }
    print("  overall accuracy on held-out taps: \(totalN > 0 ? fmt(Double(totalTP) / Double(totalN), 3) : "-") (\(totalTP)/\(totalN))")

    print("\n  confusion matrix (rows = true zone, cols = predicted; none = rejected or missed)")
    let short = r.labels.map { String($0.prefix(7)) }
    print("  " + pad("", 14) + short.map { pad($0, 8, left: true) }.joined())
    for (zi, z) in zones.enumerated() {
        print("  " + pad(z, 14) + r.confusion[zi].map { pad($0 == 0 ? "." : "\($0)", 8, left: true) }.joined())
    }
    if !r.rejectReasons.isEmpty {
        print("  held-out taps not accepted, by reason: " + r.rejectReasons.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))
    }
    let extrasCap = r.extras.filter { !$0.key.hasPrefix("neg:") && $0.value > 0 }
    if !extrasCap.isEmpty {
        print("  extra taps inside capture (no ground truth): " + extrasCap.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))
    }

    print("\n  false triggers (accepted taps where none should be)")
    for phase in ["negatives", "rest"] {
        guard let secs = r.negSeconds[phase], secs > 0 else { print("    \(phase): no \(phase) phase in this recording"); continue }
        let n = r.falseTriggers[phase] ?? 0
        let g = r.falseGestures[phase] ?? 0
        print("    \(pad(phase, 10)) \(n) taps in \(fmt(secs, 1)) s = \(fmt(Double(n) / secs * 60, 2)) per minute; gestures \(g) = \(fmt(Double(g) / secs * 60, 2)) per minute")
    }
    if !r.negRejectReasons.isEmpty {
        print("    rejections there (working as intended): " + r.negRejectReasons.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))
    }

    print("\n  latency (ms)                     n      p50     p90     p99     max")
    func line(_ name: String, _ xs: [Double], scale: Double) {
        print("    " + pad(name, 28) + pad("\(xs.count)", 5, left: true) + [50.0, 90, 99, 100].map { pad(fmt(percentile(xs, $0) * scale, 2), 8, left: true) }.joined())
    }
    line("emit - tap.t (engine delay)", r.emitLatency, scale: 1000)
    line("emit - true onset", r.onsetLatency, scale: 1000)
    if let ns = ingestNs, !ns.isEmpty {
        print("  ingest cost per sample (us): p50 \(fmt(percentile(ns, 50) / 1000, 2))  p99 \(fmt(percentile(ns, 99) / 1000, 2))  max \(fmt(percentile(ns, 100) / 1000, 1))  mean \(fmt(mean(ns) / 1000, 2))")
    }
}
