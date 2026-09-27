// Benchmark suites. Every suite uses only the public API of GhostkeysDetection, exactly as the daemon does:
// Trainer to train, TapEngine to detect, ZoneModel.classifyDetailed + minConfidence to decide.

import Foundation
import GhostkeysDetection

// MARK: Metrics

enum Better: String, Codable { case up, down, info }

struct Metric: Codable {
    var key: String
    var value: Double
    var better: Better
    var note: String
}

final class Report {
    private(set) var metrics: [Metric] = []
    func add(_ key: String, _ value: Double, _ better: Better, _ note: String = "") {
        metrics.append(Metric(key: key, value: value, better: better, note: note))
    }
}

/// Deterministic generator for fold assignment (independent of the library's internal one).
struct BenchRNG: RandomNumberGenerator {
    var state: UInt64
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Stratified k-fold assignment; labels with fewer than `minPerLabel` items get fold -1 (always trained on).
func stratifiedFolds(_ labels: [String], k: Int, seed: UInt64, minPerLabel: Int = 5) -> [Int] {
    var rng = BenchRNG(state: seed)
    var fold = [Int](repeating: -1, count: labels.count)
    for l in Set(labels).sorted() {
        var idx = labels.indices.filter { labels[$0] == l }
        guard idx.count >= minPerLabel else { continue }
        idx.shuffle(using: &rng)
        for (r, i) in idx.enumerated() { fold[i] = r % k }
    }
    return fold
}

func train(_ samples: [LabeledSample]) -> ZoneModel {
    let t = Trainer()
    for s in samples { t.add(s.features, label: s.label) }
    return t.train().0
}

let verbose = ProcessInfo.processInfo.environment["BENCH_VERBOSE"] != nil
let multiTapZones: Set<String> = ["left-grille", "right-grille"]

// MARK: Feature-level suites (calibration sets)

struct Tally {
    var zoneTaps = 0, correct = 0, wrong = 0, weakCorrect = 0, negatives = 0, negAccepted = 0
    var perZone: [String: (n: Int, strong: Int, weak: Int)] = [:]

    mutating func score(_ r: ZoneModel.Result, _ s: LabeledSample, _ settings: DetectionSettings) {
        let accepted = r.zone != ZoneModel.noneLabel && r.confidence >= settings.minConfidence
        if s.label == ZoneModel.noneLabel {
            negatives += 1
            if accepted { negAccepted += 1 }
            return
        }
        zoneTaps += 1
        var z = perZone[s.label] ?? (0, 0, 0)
        z.n += 1
        if accepted { if r.zone == s.label { correct += 1; z.strong += 1 } else { wrong += 1 } }
        if r.zone == s.label && r.confidence >= min(settings.followUpConfidence, settings.minConfidence) { weakCorrect += 1; z.weak += 1 }
        perZone[s.label] = z
    }

    var recall: Double { zoneTaps > 0 ? Double(correct) / Double(zoneTaps) : .nan }
    var wrongRate: Double { zoneTaps > 0 ? Double(wrong) / Double(zoneTaps) : .nan }
    var negRate: Double { negatives > 0 ? Double(negAccepted) / Double(negatives) : .nan }
    /// Estimated double-tap success in the multi-tap zones: first tap strong, second at least weak (same zone).
    var grilleDouble: Double {
        let zs = perZone.filter { multiTapZones.contains($0.key) && $0.value.n > 0 }
        guard !zs.isEmpty else { return .nan }
        return zs.values.map { Double($0.strong) / Double($0.n) * Double($0.weak) / Double($0.n) }.reduce(0, +) / Double(zs.count)
    }
}

/// The live decision for a stream of candidates from one model: classify, then (in builds that have it) the
/// familiarity guard, which needs the candidates in time order.
struct Decider {
    let model: ZoneModel
    #if HAS_FAMILIARITY
    var guard_ = FamiliarityGuard()
    #endif
    init(_ m: ZoneModel) {
        #if HAS_FAMILIARITY
        model = m.upgraded()
        #else
        model = m
        #endif
    }
    mutating func decide(_ f: TapFeatures) -> ZoneModel.Result {
        var r = model.classifyDetailed(f)
        #if HAS_FAMILIARITY
        if !guard_.admit(r, model: model, t: f.t) { r.zone = ZoneModel.noneLabel }
        #endif
        return r
    }
}

func scoreStream(_ m: ZoneModel, _ xs: [LabeledSample], _ tally: inout Tally, _ settings: DetectionSettings) {
    var d = Decider(m)
    for x in xs.sorted(by: { $0.features.t < $1.features.t }) { tally.score(d.decide(x.features), x, settings) }
}

/// Repeated stratified 5-fold cross-validation inside one calibration (the number the calibration report shows,
/// but through the live decision rule).
func suiteCV(_ sets: [CalibrationSet], settings: DetectionSettings, reps: Int, report: Report) {
    for set in sets {
        var tally = Tally()
        for rep in 0..<reps {
            let fold = stratifiedFolds(set.labels, k: 5, seed: UInt64(1000 + rep))
            for f in 0..<5 {
                let m = train(set.samples.indices.filter { fold[$0] != f }.map { set.samples[$0] })
                scoreStream(m, set.samples.indices.filter { fold[$0] == f }.map { set.samples[$0] }, &tally, settings)
            }
        }
        let p = "cv.\(set.name)"
        report.add("\(p).recall", tally.recall, .up, "zone taps accepted with the right zone")
        report.add("\(p).wrongZone", tally.wrongRate, .down, "zone taps accepted as another zone")
        report.add("\(p).negAccepted", tally.negRate, .down, "typing/click negatives accepted as a tap (before the typing gate)")
        report.add("\(p).grilleDouble", tally.grilleDouble, .up, "estimated grille double-tap success")
    }
}

/// Train on one calibration, test on another session's taps and negatives: what happens when the conditions of
/// use differ from the calibration (posture, surface, tap strength). The right behaviour there is to reject.
func suiteCross(_ sets: [CalibrationSet], settings: DetectionSettings, saved: Bool = false, report: Report) {
    var totalCand = 0, totalFalse = 0, totalTaps = 0, totalCorrect = 0
    let prefix = saved ? "xsaved" : "cross"
    for a in sets {
        guard let m = saved ? a.savedModel : train(a.samples) else { continue }
        for b in sets where b.name != a.name {
            var tally = Tally()
            scoreStream(m, b.samples.filter { $0.label == ZoneModel.noneLabel || m.labels.contains($0.label) }, &tally, settings)
            if saved { totalCand += tally.zoneTaps + tally.negatives; totalFalse += tally.wrong + tally.negAccepted
                       totalTaps += tally.zoneTaps; totalCorrect += tally.correct; continue }
            let p = "\(prefix).\(a.name)>\(b.name)"
            report.add("\(p).wrongZone", tally.wrongRate, .down)
            report.add("\(p).negAccepted", tally.negRate, .down)
            report.add("\(p).recall", tally.recall, .info)
            totalCand += tally.zoneTaps + tally.negatives
            totalFalse += tally.wrong + tally.negAccepted
            totalTaps += tally.zoneTaps
            totalCorrect += tally.correct
        }
    }
    report.add("\(prefix).all.falseAccept", Double(totalFalse) / Double(max(totalCand, 1)), .down,
               saved ? "same, with the model files the daemon saved (the live model is calib2's)"
                     : "wrong-zone taps + accepted negatives, per candidate, over all train/test session pairs")
    report.add("\(prefix).all.recall", Double(totalCorrect) / Double(max(totalTaps, 1)), .info,
               "right-zone accepts across sessions (a bonus, not the goal)")
}

// MARK: Raw replays

struct EngineRun {
    var candidates: [TapFeatures] = []
    var taps: [(tap: TapEvent, at: Double)] = []
    var gestures: [(g: GestureEvent, at: Double)] = []
    var rejected: [(t: Double, reason: RejectReason)] = []
}

func runEngine(_ rec: Recording, model: ZoneModel?, settings: DetectionSettings, capture: Bool = false,
               extraKeys: [Double] = [], extraMouse: [Double] = []) -> EngineRun {
    let e = TapEngine(settings: settings)
    e.model = model
    e.bypassInputGates = capture
    e.zonesNeedingMultiTap = multiTapZones
    var run = EngineRun()
    rec.forEach(extraKeys: extraKeys, extraMouse: extraMouse) { s, ctx in
        for ev in e.ingest(s, context: ctx) {
            switch ev {
            case .candidate(let f): run.candidates.append(f)
            case .tap(let tap): run.taps.append((tap, s.t))
            case .gesture(let g): run.gestures.append((g, s.t))
            case .rejected(let t, let r): run.rejected.append((t, r))
            }
        }
    }
    return run
}

struct GT { var zone: String; var t: Double; var features: TapFeatures? }

/// Ground truth of a lab recording: the recorded onsets of each capture segment, matched to engine candidates
/// (capture mode, no model) within 80 ms.
func groundTruth(_ rec: Recording, settings: DetectionSettings) -> [GT] {
    let base = runEngine(rec, model: nil, settings: settings, capture: true)
    var used = Set<Int>()
    var gt: [GT] = []
    for seg in rec.captures {
        for o in seg.onsets {
            var best: Int?, bestD = 0.08
            for (i, c) in base.candidates.enumerated() where !used.contains(i) && abs(c.t - o) <= bestD { best = i; bestD = abs(c.t - o) }
            if let b = best { used.insert(b) }
            gt.append(GT(zone: seg.zone ?? "?", t: o, features: best.map { base.candidates[$0] }))
        }
    }
    return gt
}

struct ReplayScore {
    var held = 0, correct = 0, wrong = 0
    var handlingSeconds = 0.0, handlingTaps = 0, handlingGestures = 0
    var latencies: [Double] = []

    mutating func add(_ run: EngineRun, rec: Recording, gt: [GT], scored: Set<Int>) {
        for i in scored {
            held += 1
            if let hit = run.taps.first(where: { abs($0.tap.t - gt[i].t) <= 0.08 }) {
                if hit.tap.zone == gt[i].zone { correct += 1; latencies.append(hit.at - hit.tap.t) } else { wrong += 1 }
            }
        }
        // Handling windows: stretches with no intended taps (see handlingWindows). Without them, fall back to
        // "outside every capture segment".
        let caps = rec.captures
        func inHandling(_ t: Double) -> Bool {
            if let w = rec.handling { return w.contains { t >= $0.0 && t <= $0.1 } }
            return !caps.contains { t >= $0.start - 0.2 && t <= $0.end + 0.2 }
        }
        if let w = rec.handling { handlingSeconds += w.reduce(0) { $0 + ($1.1 - $1.0) } }
        else { handlingSeconds += rec.duration - caps.reduce(0) { $0 + ($1.end - $1.start + 0.4) } }
        let stray = run.taps.filter { inHandling($0.tap.t) }
        handlingTaps += stray.count
        if verbose {
            for x in stray {
                let f = run.candidates.first { abs($0.t - x.tap.t) < 1e-6 }
                let peak = f.map { pow(10, $0.values[26]) } ?? .nan, width = f?.values[25] ?? .nan
                log(String(format: "  handling tap t=%.2f %@ conf %.2f peak %.0f mg width %.0f ms", x.tap.t, x.tap.zone, x.tap.confidence, peak, width))
            }
        }
        handlingGestures += run.gestures.filter { inHandling($0.g.t) && $0.g.zone != nil }.count
    }
}

func pct(_ xs: [Double], _ q: Double) -> Double {
    guard !xs.isEmpty else { return .nan }
    let s = xs.sorted()
    return s[min(s.count - 1, Int((q * Double(s.count - 1)).rounded()))]
}

/// session1 (lap): train on 4/5 of its taps, replay the whole recording through the live engine, score the held-out
/// taps and count taps fired while the machine was being handled between phases.
func suiteSession1(_ rec: Recording, settings: DetectionSettings, reps: Int, report: Report) {
    let gt = groundTruth(rec, settings: settings)
    let found = gt.filter { $0.features != nil }.count
    report.add("s1.onsetRecall", Double(found) / Double(max(gt.count, 1)), .up, "labelled taps the onset detector finds")
    var plain = ReplayScore()
    for rep in 0..<reps {
        let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: UInt64(2000 + rep))
        for f in 0..<5 {
            let trainSet = gt.indices.filter { fold[$0] != f && gt[$0].features != nil }
                .map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) }
            let m = train(trainSet)
            let held = Set(gt.indices.filter { fold[$0] == f })
            plain.add(runEngine(rec, model: m, settings: settings), rec: rec, gt: gt, scored: held)
        }
    }
    let n = Double(max(plain.held, 1))
    report.add("s1.recall", Double(plain.correct) / n, .up, "held-out lap taps accepted with the right zone")
    report.add("s1.wrongZone", Double(plain.wrong) / n, .down)
    report.add("s1.handlingTapsPerMin", Double(plain.handlingTaps) / max(plain.handlingSeconds / 60, 1e-9), .down,
               "taps fired while the laptop was being handled/repositioned on the lap")
    report.add("s1.handlingGesturesPerMin", Double(plain.handlingGestures) / max(plain.handlingSeconds / 60, 1e-9), .down)
    report.add("s1.tapLatencyMsP50", 1000 * pct(plain.latencies, 0.5), .down, "onset to tap event")
    report.add("s1.tapLatencyMsP90", 1000 * pct(plain.latencies, 0.9), .down)
}

/// session1 replayed with models from the user's other calibrations (different day, posture): what the user
/// experiences when the conditions differ from the calibration. `saved` uses the model files as the daemon saved
/// them; otherwise each is retrained from its samples by this build.
func suiteSession1Cross(_ rec: Recording, sets: [CalibrationSet], settings: DetectionSettings, saved: Bool, report: Report) {
    let gt = groundTruth(rec, settings: settings)
    var total = ReplayScore()
    for set in sets {
        guard let m = saved ? set.savedModel : train(set.samples) else { continue }
        var s = ReplayScore()
        s.add(runEngine(rec, model: m, settings: settings), rec: rec, gt: gt, scored: Set(gt.indices))
        total.held += s.held; total.correct += s.correct; total.wrong += s.wrong
        total.handlingSeconds += s.handlingSeconds; total.handlingTaps += s.handlingTaps; total.handlingGestures += s.handlingGestures
    }
    let p = saved ? "s1x.saved" : "s1x"
    let n = Double(max(total.held, 1))
    report.add("\(p).wrongZone", Double(total.wrong) / n, .down, "lap taps accepted as the wrong zone by other sessions' models")
    report.add("\(p).recall", Double(total.correct) / n, .info)
    report.add("\(p).handlingTapsPerMin", Double(total.handlingTaps) / max(total.handlingSeconds / 60, 1e-9), .down)
}

/// Desk at rest (12 s) and the two feedback_missed diagnostics, with every calibration's model.
func suiteRest(_ rest: Recording?, diags: [Recording], sets: [CalibrationSet], settings: DetectionSettings, report: Report) {
    let models = sets.map { train($0.samples) }
    if let rest {
        var taps = 0, gestures = 0
        for m in models {
            let r = runEngine(rest, model: m, settings: settings)
            taps += r.taps.count; gestures += r.gestures.filter { $0.g.zone != nil }.count
        }
        let minutes = rest.duration / 60 * Double(models.count)
        report.add("rest.tapsPerMin", Double(taps) / minutes, .down, "desk at rest; one real ~30 mg disturbance at 3.9 s")
        report.add("rest.gesturesPerMin", Double(gestures) / minutes, .down)
    }
    var dTaps = 0, dSeconds = 0.0
    for d in diags {
        for m in models { dTaps += runEngine(d, model: m, settings: settings).taps.count; dSeconds += d.duration }
    }
    if dSeconds > 0 {
        report.add("diag.tapsPerMin", Double(dTaps) / (dSeconds / 60), .info,
                   "two 3 s 'missed right-grille' reports: one holds no tap, the other a tap buried in trackpad use")
    }
}

// MARK: Spliced doubles (real taps, composed timing)

/// There is no real double-tap recording, so doubles are composed from real single taps: pairs of session1's
/// left-grille taps (the user's bound zone type) are added, 250 ms apart, onto the real desk rest recording
/// (looped back and forth so the loop has no jumps). Two folds: the model is trained on half the taps and
/// tested on doubles made of the other half. Three variants of the same stream:
///   plain       nothing else happens: the double should fire
///   keyAfter    a key goes down 150 ms after the second tap (hands arriving at the keyboard): should not fire
///   mouseAfter  pointer activity 100 ms after the second tap (hand going to the trackpad): should not fire
func suiteSplice(_ s1: Recording, rest: Recording, settings: DetectionSettings, doubleGap: Double = 0.25, report: Report) {
    let gt = groundTruth(s1, settings: settings)
    let grille = gt.indices.filter { gt[$0].zone == "left-grille" && gt[$0].features != nil }
    let allOnsets = s1.captures.flatMap(\.onsets).sorted()
    func next(_ i: Int) -> Double { allOnsets.first { $0 > gt[i].t + 0.05 } ?? .infinity }
    var fired = ["plain": 0, "keyAfter": 0, "mouseAfter": 0], total = 0, stray = 0
    for half in 0..<2 {
        let testTaps = grille.enumerated().filter { $0.offset % 2 == half }.map(\.element)
        let trainSet = gt.indices.filter { gt[$0].features != nil && !testTaps.contains($0) }
            .map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) }
        let model = train(trainSet)
        // Pairs (a, b) of test taps; each double at 3 s spacing after 3 s of warm-up.
        let pairs = zip(testTaps, testTaps.dropFirst() + testTaps.prefix(1)).map { ($0, $1) }
        let spacing = 3.0, lead = 3.0
        let stream = composeStream(background: rest, seconds: lead + spacing * Double(pairs.count) + 1)
        var r = stream
        var secondTaps: [Double] = [], doubleStarts: [Double] = []
        for (k, (a, b)) in pairs.enumerated() {
            let t0 = lead + spacing * Double(k)
            // Each window stops before its own next real tap; the first tap's ringing does run on under the second.
            addTap(from: s1, onset: gt[a].features!.t, into: &r, at: t0, nextOnset: next(a))
            addTap(from: s1, onset: gt[b].features!.t, into: &r, at: t0 + doubleGap, nextOnset: next(b))
            doubleStarts.append(t0); secondTaps.append(t0 + doubleGap)
        }
        total += pairs.count
        for (variant, keys, mouse) in [("plain", [Double](), [Double]()),
                                       ("keyAfter", secondTaps.map { $0 + 0.15 }, []),
                                       ("mouseAfter", [], secondTaps.map { $0 + 0.10 })] {
            let run = runEngine(r, model: model, settings: settings, extraKeys: keys, extraMouse: mouse)
            let doubles = run.gestures.filter { $0.g.gesture == "double" && $0.g.zone == "left-grille" }
            fired[variant]! += doubleStarts.filter { t0 in doubles.contains { $0.g.t >= t0 - 0.05 && $0.g.t <= t0 + 0.5 } }.count
            if variant == "plain" {
                stray += run.gestures.filter { g in g.g.zone != nil && !doubleStarts.contains { g.g.t >= $0 - 0.05 && g.g.t <= $0 + 0.5 } }.count
            }
        }
    }
    let n = Double(max(total, 1))
    report.add("splice.double.success", Double(fired["plain"]!) / n, .up, "real grille taps composed into doubles (250 ms apart) that fire")
    report.add("splice.double.keyAfter150", Double(fired["keyAfter"]!) / n, .down, "same doubles followed by a key press 150 ms later that still fire")
    report.add("splice.double.mouseAfter100", Double(fired["mouseAfter"]!) / n, .down, "same doubles followed by pointer activity 100 ms later that still fire")
    report.add("splice.strayGestures", Double(stray), .down, "gestures anywhere else in the composed streams")
}

/// The rest recording played forwards, backwards, forwards... (no jump at the joins), `seconds` long.
func composeStream(background: Recording, seconds: Double) -> Recording {
    var r = Recording(name: "composed")
    let n = background.t.count, fs = 797.0
    let total = Int(seconds * fs)
    r.t.reserveCapacity(total); r.a.reserveCapacity(total); r.g.reserveCapacity(total)
    for i in 0..<total {
        let cycle = i / n, k = i % n
        let j = cycle % 2 == 0 ? k : n - 1 - k
        r.t.append(Double(i) / fs); r.a.append(background.a[j]); r.g.append(background.g[j])
    }
    return r
}

/// Adds the dynamic part of a real tap: from 30 ms before its onset (faded in over 20 ms) to 500 ms after, or to
/// 30 ms before the recording's next tap if that comes sooner (faded out over the last 50 ms), minus the mean of
/// the 100 ms before the lead-in, so the tap starts at `t0`.
func addTap(from s: Recording, onset: Double, into r: inout Recording, at t0: Double, nextOnset: Double = .infinity) {
    let fs = 797.0
    guard let iOn = s.t.firstIndex(where: { $0 >= onset }) else { return }
    let tail = min(0.5, nextOnset - onset - 0.03)
    guard tail > 0.1 else { return }
    let lead = Int(0.03 * fs), fadeIn = Int(0.02 * fs), len = lead + Int(tail * fs), fade = Int(0.05 * fs), pre = 80
    let i0 = iOn - lead
    guard i0 - pre >= 0, i0 + len < s.t.count else { return }
    var ba = SIMD3<Double>(0, 0, 0), bg = SIMD3<Double>(0, 0, 0)
    for k in (i0 - pre)..<i0 { ba += s.a[k]; bg += s.g[k] }
    ba /= Double(pre); bg /= Double(pre)
    let dst = Int(((t0 - 0.03) * fs).rounded())
    for k in 0..<len where dst + k < r.a.count && dst + k >= 0 {
        var w = 1.0
        if k < fadeIn { w = 0.5 * (1 - cos(Double.pi * Double(k) / Double(fadeIn))) }
        if k >= len - fade { w = 0.5 * (1 + cos(Double.pi * Double(k - (len - fade)) / Double(fade))) }
        r.a[dst + k] += (s.a[i0 + k] - ba) * w
        r.g[dst + k] += (s.g[i0 + k] - bg) * w
    }
}

// MARK: Robustness to where the onset triggers

/// A model is trained on session1 taps as captured at the default settings, then the recording is replayed with
/// the onset threshold moved (sensitivity 0.2: floor 25 mg; 0.8: floor 10 mg) and with the whole recording scaled
/// to 0.6x (softer taps than calibrated). Live, the threshold moves by itself with noise (k x noise on a lap or with
/// music) and users tap softer than when calibrating, so features must not depend on where the pulse crossed it.
func suiteRobustness(_ rec: Recording, settings: DetectionSettings, report: Report) {
    let gt = groundTruth(rec, settings: settings)
    // Scale only the dynamic part: keep gravity (100 ms moving mean), shrink the rest.
    var scaled = rec
    let win = 80
    var mean = SIMD3<Double>(0, 0, 0)
    var acc: [SIMD3<Double>] = []
    acc.reserveCapacity(rec.a.count)
    for i in rec.a.indices {
        mean += rec.a[i]
        if i >= win { mean -= rec.a[i - win] }
        acc.append(mean / Double(min(i + 1, win)))
    }
    for i in rec.a.indices { scaled.a[i] = acc[i] + (rec.a[i] - acc[i]) * 0.6 }
    scaled.g = rec.g.map { $0 * 0.6 }
    var s02 = settings; s02.sensitivity = 0.2
    var s08 = settings; s08.sensitivity = 0.8
    for (name, r, s) in [("sens0.2", rec, s02), ("sens0.8", rec, s08), ("soft0.6x", scaled, settings)] {
        var score = ReplayScore()
        let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: 3000)
        for f in 0..<5 {
            let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }
                .map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
            score.add(runEngine(r, model: m, settings: s), rec: r, gt: gt, scored: Set(gt.indices.filter { fold[$0] == f }))
        }
        report.add("robust.\(name).recall", Double(score.correct) / Double(max(score.held, 1)), .up,
                   "lap taps recognised when the onset triggers elsewhere than in calibration")
        report.add("robust.\(name).wrongZone", Double(score.wrong) / Double(max(score.held, 1)), .down)
    }
}
