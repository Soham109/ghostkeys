// Round 3 research (docs/review/DETECTION_ROUND3.md): does a gravity-aligned feature frame make taps look the same on
// the desk and on the lap?
//
// Variant "aligned": before any detection, every IMU sample (accel and gyro) is rotated by the smallest rotation that
// takes the machine's current gravity direction onto the desk's (the direction of the 12 s desk rest recording, which
// the daemon's own live diagnostics from the calibration evening match to 0.1 degrees). Gravity here is a causal
// one-pole low-pass (0.5 s) of the accelerometer, as a live implementation would use. Every feature is then computed
// from the rotated signal, so all 33 features see the gravity-aligned frame, not just the vector ones.
//
// The calibrations store features, not signals, and no gravity. They were done on the desk, so their aligned frame is
// the sensor frame (rotation by 0 degrees). Only the lap recording (session1, raw IMU) changes. So:
//   A  lap taps scored by each desk calibration's model (cross-posture, the case that fails today)
//   B  desk calibration taps and typing negatives scored by a model trained on the lap taps (the other direction)
//   C  lap taps in-session (5 x 5 folds): the machine tilts 2 to 14 degrees between the lap phases
//   D  leave one session out over the four sessions (calib1, calib_bak, calib2, session1): train on the other three
//      pooled, test on the held-out one
//   E  how far lap taps sit from the desk models, in typical calibration distances (what makes the guard strict)
// Calibration-to-calibration cross-session numbers cannot change (all desk, rotation 0) and are not repeated.
//
// Usage: daemon/analysis/bench/round3/run.sh   (prints a table, writes results/2026-09-27-round3-frame.json)

import Foundation
import GhostkeysDetection

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }

let argv = CommandLine.arguments
let dataDir = argv.count > 1 ? argv[1] : "analysis/data"
let testsDir = argv.count > 2 ? argv[2] : "Tests/GhostkeysDetectionTests"
let outPath = argv.count > 3 ? argv[3] : nil
let settings = DetectionSettings()

let sets = ["calib1", "calib_bak", "calib2"].compactMap { loadCalibration("\(dataDir)/\($0)", name: $0) }
guard let s1 = loadGkrec("\(dataDir)/session1.gkrec"), let rest = loadRestRecording(testsDir: testsDir), sets.count == 3 else {
    log("missing data"); exit(2)
}

func unit(_ v: SIMD3<Double>) -> SIMD3<Double> { v / (v * v).sum().squareRoot() }
func angle(_ a: SIMD3<Double>, _ b: SIMD3<Double>) -> Double { ZoneModelSet.angleDegrees(a, b) }
let desk = unit(rest.a.reduce(SIMD3<Double>(0, 0, 0), +) / Double(rest.a.count))

/// Smallest rotation taking unit vector u onto unit vector r, applied to x (Rodrigues).
func rotate(_ x: SIMD3<Double>, from u: SIMD3<Double>, to r: SIMD3<Double>) -> SIMD3<Double> {
    let v = SIMD3(u.y * r.z - u.z * r.y, u.z * r.x - u.x * r.z, u.x * r.y - u.y * r.x)
    let c = (u * r).sum()
    guard c > -0.999 else { return x }
    let vx = SIMD3(v.y * x.z - v.z * x.y, v.z * x.x - v.x * x.z, v.x * x.y - v.y * x.x)
    let vvx = SIMD3(v.y * vx.z - v.z * vx.y, v.z * vx.x - v.x * vx.z, v.x * vx.y - v.y * vx.x)
    return x + vx + vvx / (1 + c)
}

/// Causal low-passed gravity direction per sample.
func gravityTrack(_ rec: Recording, tau: Double = 0.5) -> [SIMD3<Double>] {
    let alpha = 1 - exp(-1 / (tau * 797))
    var g = rec.a.first ?? SIMD3(0, 0, -1)
    return rec.a.map { a in g += alpha * (a - g); return unit(g) }
}

func aligned(_ rec: Recording, to ref: SIMD3<Double>) -> Recording {
    var r = rec
    let track = gravityTrack(rec)
    for i in rec.a.indices {
        r.a[i] = rotate(rec.a[i], from: track[i], to: ref)
        r.g[i] = rotate(rec.g[i], from: track[i], to: ref)
    }
    return r
}

struct Row: Codable { var key: String; var sensor: Double; var aligned: Double; var n: Int; var note: String }
var rows: [Row] = []
func add(_ key: String, _ s: Double, _ a: Double, n: Int, _ note: String = "") { rows.append(Row(key: key, sensor: s, aligned: a, n: n, note: note)) }

let variants: [(String, Recording)] = [("sensor", s1), ("aligned", aligned(s1, to: desk))]
let gts = variants.map { groundTruth($0.1, settings: settings) }
let lapZones = Set(gts[0].map(\.zone))

// Tilt of the lap taps.
let track = gravityTrack(s1)
var tiltByZone: [String: [Double]] = [:]
for g in gts[0] {
    guard let i = s1.t.firstIndex(where: { $0 >= g.t }) else { continue }
    tiltByZone[g.zone, default: []].append(angle(track[i], desk))
}
for (z, v) in tiltByZone.sorted(by: { $0.key < $1.key }) {
    log(String(format: "tilt from desk at %@ taps: median %.1f, range %.1f to %.1f degrees (%d taps)", z, pct(v, 0.5), v.min()!, v.max()!, v.count))
}

// Sanity check of the rotation: in the aligned stream, gravity at the lap taps must point where the desk's does.
let alignedTrack = gravityTrack(variants[1].1)
let residual = gts[0].compactMap { g in s1.t.firstIndex(where: { $0 >= g.t }).map { angle(alignedTrack[$0], desk) } }
log(String(format: "aligned stream: gravity at lap taps is %.2f degrees (max %.2f) from the desk's", pct(residual, 0.5), residual.max() ?? .nan))

// A: lap taps by desk models.
log("A: lap taps scored by the desk calibrations' models")
var aScores: [(ReplayScore, [Double])] = []
for (vi, v) in variants.enumerated() {
    var total = ReplayScore()
    var ratios: [Double] = []
    for set in sets {
        let m = train(set.samples)
        var s = ReplayScore()
        s.add(runEngine(v.1, model: m, settings: settings), rec: v.1, gt: gts[vi], scored: Set(gts[vi].indices))
        total.held += s.held; total.correct += s.correct; total.wrong += s.wrong
        total.handlingSeconds += s.handlingSeconds; total.handlingTaps += s.handlingTaps
        // E: distance of each lap tap from the desk model, in typical distances.
        let u = m.upgraded()
        for g in gts[vi] { if let f = g.features, let td = u.typicalDistance { ratios.append(u.classifyDetailed(f).distance / td) } }
    }
    aScores.append((total, ratios))
}
add("A.lapByDesk.recall", Double(aScores[0].0.correct) / Double(aScores[0].0.held), Double(aScores[1].0.correct) / Double(aScores[1].0.held), n: aScores[0].0.held, "lap taps x 3 desk models, right zone accepted")
add("A.lapByDesk.wrongZone", Double(aScores[0].0.wrong) / Double(aScores[0].0.held), Double(aScores[1].0.wrong) / Double(aScores[1].0.held), n: aScores[0].0.held)
add("A.lapByDesk.handlingTapsPerMin", Double(aScores[0].0.handlingTaps) / (aScores[0].0.handlingSeconds / 60), Double(aScores[1].0.handlingTaps) / (aScores[1].0.handlingSeconds / 60), n: 0, "false taps while handling the machine")
add("E.lapByDesk.distanceRatioMedian", pct(aScores[0].1, 0.5), pct(aScores[1].1, 0.5), n: aScores[0].1.count, "lap tap distance to nearest desk zone, typical calibration distances")
add("E.lapByDesk.within3", Double(aScores[0].1.filter { $0 <= 3 }.count) / Double(aScores[0].1.count), Double(aScores[1].1.filter { $0 <= 3 }.count) / Double(aScores[1].1.count), n: aScores[0].1.count, "share of lap taps within 3 typical distances (strict mode's limit)")

// B: desk taps by a lap model.
log("B: desk calibration taps scored by a lap model")
var bTallies: [Tally] = []
for (vi, _) in variants.enumerated() {
    let m = train(gts[vi].compactMap { g in g.features.map { LabeledSample(label: g.zone, features: $0) } })
    var tally = Tally()
    for set in sets { scoreStream(m, set.samples.filter { $0.label == ZoneModel.noneLabel || lapZones.contains($0.label) }, &tally, settings) }
    bTallies.append(tally)
}
add("B.deskByLap.recall", bTallies[0].recall, bTallies[1].recall, n: bTallies[0].zoneTaps)
add("B.deskByLap.wrongZone", bTallies[0].wrongRate, bTallies[1].wrongRate, n: bTallies[0].zoneTaps)
add("B.deskByLap.negAccepted", bTallies[0].negRate, bTallies[1].negRate, n: bTallies[0].negatives, "desk typing negatives accepted by the lap model")

// C: lap in-session.
log("C: lap in-session, 5 x 5 folds")
var cScores: [ReplayScore] = []
for (vi, v) in variants.enumerated() {
    let gt = gts[vi]
    var sc = ReplayScore()
    for rep in 0..<5 {
        let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: UInt64(2000 + rep))
        for f in 0..<5 {
            let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
            sc.add(runEngine(v.1, model: m, settings: settings), rec: v.1, gt: gt, scored: Set(gt.indices.filter { fold[$0] == f }))
        }
    }
    cScores.append(sc)
}
add("C.lapInSession.recall", Double(cScores[0].correct) / Double(cScores[0].held), Double(cScores[1].correct) / Double(cScores[1].held), n: cScores[0].held)
add("C.lapInSession.wrongZone", Double(cScores[0].wrong) / Double(cScores[0].held), Double(cScores[1].wrong) / Double(cScores[1].held), n: cScores[0].held)
add("C.lapInSession.handlingTapsPerMin", Double(cScores[0].handlingTaps) / (cScores[0].handlingSeconds / 60), Double(cScores[1].handlingTaps) / (cScores[1].handlingSeconds / 60), n: 0)

// D: leave one session out.
log("D: leave one session out")
for held in sets.map(\.name) + ["session1"] {
    var vals: [(Double, Double, Double, Int, Int)] = []   // recall, wrong, neg, nTaps, nNeg
    for (vi, v) in variants.enumerated() {
        if held == "session1" {
            let m = train(sets.flatMap(\.samples))
            var s = ReplayScore()
            s.add(runEngine(v.1, model: m, settings: settings), rec: v.1, gt: gts[vi], scored: Set(gts[vi].indices))
            vals.append((Double(s.correct) / Double(s.held), Double(s.wrong) / Double(s.held),
                         Double(s.handlingTaps) / (s.handlingSeconds / 60), s.held, 0))
        } else {
            let lap = gts[vi].compactMap { g in g.features.map { LabeledSample(label: g.zone, features: $0) } }
            let m = train(sets.filter { $0.name != held }.flatMap(\.samples) + lap)
            let test = sets.first { $0.name == held }!
            var tally = Tally()
            scoreStream(m, test.samples.filter { $0.label == ZoneModel.noneLabel || m.labels.contains($0.label) }, &tally, settings)
            vals.append((tally.recall, tally.wrongRate, tally.negRate, tally.zoneTaps, tally.negatives))
        }
    }
    add("D.loso.\(held).recall", vals[0].0, vals[1].0, n: vals[0].3)
    add("D.loso.\(held).wrongZone", vals[0].1, vals[1].1, n: vals[0].3)
    add(held == "session1" ? "D.loso.session1.handlingTapsPerMin" : "D.loso.\(held).negAccepted", vals[0].2, vals[1].2, n: vals[0].4)
}

// F: which features differ between the lap and the desk, per zone, in units of the desk's within-zone spread
// (mean over the three calibrations and the three shared zones). Says what a posture-invariant feature would need.
log("F: lap vs desk feature shift")
func meanStd(_ xs: [[Double]], _ j: Int) -> (Double, Double) {
    let v = xs.map { $0[j] }
    let m = v.reduce(0, +) / Double(max(v.count, 1))
    let sd = (v.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(max(v.count - 1, 1))).squareRoot()
    return (m, sd)
}
var shifts: [[Double]] = []   // [variant][feature]
for vi in variants.indices {
    var acc = [Double](repeating: 0, count: TapFeatures.count), n = 0
    for set in sets {
        for z in lapZones.sorted() {
            let d = set.samples.filter { $0.label == z }.map(\.features.values)
            let l = gts[vi].filter { $0.zone == z }.compactMap { $0.features?.values }
            guard d.count >= 5, l.count >= 5 else { continue }
            n += 1
            let all = sets.flatMap { $0.samples.filter { $0.label != ZoneModel.noneLabel } }.map(\.features.values)
            for j in 0..<TapFeatures.count {
                let (md, sd) = meanStd(d, j), (ml, _) = meanStd(l, j)
                // Same floor as the classifier's scale: 10% of the spread over every desk tap.
                acc[j] += abs(ml - md) / max(sd, 0.1 * meanStd(all, j).1, 1e-9)
            }
        }
    }
    shifts.append(acc.map { $0 / Double(max(n, 1)) })
}
for j in (0..<TapFeatures.count).sorted(by: { shifts[0][$0] > shifts[0][$1] }) {
    add("F.shift.\(TapFeatures.names[j])", shifts[0][j], shifts[1][j], n: 0, "|lap - desk| / desk within-zone sd, mean over zones x calibrations")
}
for z in lapZones.sorted() {
    let d = sets.flatMap { $0.samples.filter { $0.label == z } }.map { pow(10, $0.features.values[26]) }
    let l = gts[0].filter { $0.zone == z }.compactMap { $0.features.map { pow(10, $0.values[26]) } }
    add("F.peakMg.\(z)", pct(d, 0.5), pct(l, 0.5), n: l.count, "median peak (mg): 'sensor' column = desk calibrations, 'aligned' column = lap")
}

// G: could the taps themselves tell the posture? For every held-out tap, which model (desk or lap) puts it nearer its
// zones, in each model's own typical distances. Lap taps: 5 folds of session1 x each desk calibration. Desk taps: 5
// folds of each calibration against a model of all lap taps. Sensor frame.
log("G: nearest model by distance")
var lapNearer = 0, lapN = 0, deskNearer = 0, deskN = 0
var lapRatios: [Double] = [], deskRatios: [Double] = []
var lapPairs: [(desk: Double, lap: Double)] = []   // held-out lap taps: ratio to the desk model, to the out-of-fold lap model
let gt0 = gts[0]
let fullLap = train(gt0.compactMap { g in g.features.map { LabeledSample(label: g.zone, features: $0) } }).upgraded()
for set in sets {
    let deskModel = train(set.samples).upgraded()
    let fold = stratifiedFolds(gt0.map(\.zone), k: 5, seed: 2000)
    for f in 0..<5 {
        let lapModel = train(gt0.indices.filter { fold[$0] != f && gt0[$0].features != nil }.map { LabeledSample(label: gt0[$0].zone, features: gt0[$0].features!) }).upgraded()
        for i in gt0.indices where fold[i] == f {
            guard let x = gt0[i].features else { continue }
            let rl = lapModel.classifyDetailed(x).distance / lapModel.typicalDistance!
            let rd = deskModel.classifyDetailed(x).distance / deskModel.typicalDistance!
            lapN += 1; if rl < rd { lapNearer += 1 }; lapRatios.append(rl); lapPairs.append((rd, rl))
        }
    }
    let dfold = stratifiedFolds(set.labels, k: 5, seed: 1000)
    for f in 0..<5 {
        let m = train(set.samples.indices.filter { dfold[$0] != f }.map { set.samples[$0] }).upgraded()
        for i in set.samples.indices where dfold[i] == f && set.samples[i].label != ZoneModel.noneLabel {
            let x = set.samples[i].features
            let rd = m.classifyDetailed(x).distance / m.typicalDistance!
            let rl = fullLap.classifyDetailed(x).distance / fullLap.typicalDistance!
            deskN += 1; if rd < rl { deskNearer += 1 }; deskRatios.append(rd)
        }
    }
}
// G2: the same for desk taps from ANOTHER desk session (desk model from calibration A, taps from calibration B): is a
// different desk day still nearer the desk model than the lap model? (If not, taps identify the session, not the
// posture.)
var xNearer = 0, xN = 0
var xRatiosDesk: [Double] = [], xRatiosLap: [Double] = []
for a in sets {
    let m = train(a.samples).upgraded()
    for b in sets where b.name != a.name {
        for x in b.samples where x.label != ZoneModel.noneLabel && m.labels.contains(x.label) {
            let rd = m.classifyDetailed(x.features).distance / m.typicalDistance!
            let rl = fullLap.classifyDetailed(x.features).distance / fullLap.typicalDistance!
            xN += 1; if rd < rl { xNearer += 1 }; xRatiosDesk.append(rd); xRatiosLap.append(rl)
        }
    }
}
// G3: a strict version of the same idea: "the live model finds the tap far (over 6 typical distances) and the other
// posture's model finds it near (under 2)". How often lap taps meet it with the desk model live (a wanted switch), and
// how often another desk day's taps meet it the wrong way round with the desk model live (an unwanted switch to lap).
let wanted = lapPairs.filter { $0.desk > 6 && $0.lap < 2 }.count, wantedN = lapPairs.count
let unwanted = zip(xRatiosDesk, xRatiosLap).filter { $0.0 > 6 && $0.1 < 2 }.count
add("G3.lapTaps.wouldSwitchToLap", Double(wanted) / Double(max(wantedN, 1)), .nan, n: wantedN, "held-out lap taps: desk model over 6 typical distances, out-of-fold lap model under 2")
add("G3.otherDeskDay.wouldSwitchToLap", Double(unwanted) / Double(max(xN, 1)), .nan, n: xN, "desk taps of another day: desk model over 6, lap model under 2")
add("G2.otherDeskSession.deskModelNearer", Double(xNearer) / Double(xN), .nan, n: xN, "desk taps of another desk session nearer the desk model than the lap model")
add("G2.otherDeskSession.ratioMedian", pct(xRatiosDesk, 0.5), pct(xRatiosLap, 0.5), n: xN, "'sensor' column: to the other desk model, 'aligned' column: to the lap model")
add("G.lapTaps.lapModelNearer", Double(lapNearer) / Double(lapN), .nan, n: lapN, "held-out lap taps nearer the lap model than the desk model (typical distances)")
add("G.deskTaps.deskModelNearer", Double(deskNearer) / Double(deskN), .nan, n: deskN, "held-out desk taps nearer their desk model than the lap model")
add("G.ownModel.distanceRatioMedian", pct(lapRatios, 0.5), pct(deskRatios, 0.5), n: 0, "held-out taps to their own posture's model: 'sensor' column lap, 'aligned' column desk")

// H: noise floor, another candidate posture signal: the engine's adaptive noise floor (mg), sampled every 0.1 s.
func noiseFloors(_ rec: Recording) -> [Double] {
    let e = TapEngine(settings: settings)
    var out: [Double] = [], next = 1.0
    rec.forEach { s, ctx in _ = e.ingest(s, context: ctx); if s.t >= next { out.append(e.noiseFloor * 1000); next += 0.1 } }
    return out
}
let restNoise = noiseFloors(rest)
let lapNoise = noiseFloors(s1)
add("H.noiseFloorMg.median", pct(restNoise, 0.5), pct(lapNoise, 0.5), n: 0, "'sensor' column desk rest, 'aligned' column lap recording")
add("H.noiseFloorMg.p10", pct(restNoise, 0.1), pct(lapNoise, 0.1), n: 0)
add("H.noiseFloorMg.p90", pct(restNoise, 0.9), pct(lapNoise, 0.9), n: 0)

func fmt(_ v: Double) -> String { v.isNaN ? "n/a" : String(format: "%.3f", v) }
print("metric".padding(toLength: 38, withPad: " ", startingAt: 0) + "sensor".leftPad(10) + "aligned".leftPad(10) + "n".leftPad(6) + "  note")
for r in rows {
    print(r.key.padding(toLength: 38, withPad: " ", startingAt: 0) + fmt(r.sensor).leftPad(10) + fmt(r.aligned).leftPad(10) + "\(r.n)".leftPad(6) + "  " + r.note)
}
if let outPath {
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try? enc.encode(rows).write(to: URL(fileURLWithPath: outPath))
}

extension String {
    func leftPad(_ n: Int) -> String { count >= n ? self : String(repeating: " ", count: n - count) + self }
}
