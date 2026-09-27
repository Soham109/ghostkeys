// Verification (VERIFY_07_DETECTION.md): lap tap widths, strict mode at real tap times, doubles in strict mode, numeric edge cases. See ../run.sh.
import Foundation
import GhostkeysDetection

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
let args = CommandLine.arguments
let dataDir = args[1], testsDir = args[2]
let settings = DetectionSettings()
let s1 = loadGkrec("\(dataDir)/session1.gkrec")!
let rest = loadRestRecording(testsDir: testsDir)!
func f3(_ x: Double) -> String { String(format: "%.3f", x) }
let gt = groundTruth(s1, settings: settings)

// A: pulse widths of real lap candidates (feature 25, ms): how often is the decision later than onset + 80 ms?
let widths = gt.compactMap { $0.features?.values[25] }
print("lap tap widths ms: p50 \(f3(pct(widths, 0.5))) p90 \(f3(pct(widths, 0.9))) share>80ms \(f3(Double(widths.filter { $0 > 80 }.count) / Double(widths.count)))")

// B: session1 in-session: is the guard strict when held-out taps arrive?
var held = 0, strictAt = 0
for rep in 0..<5 {
    let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: UInt64(2000 + rep))
    for f in 0..<5 {
        let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
        let e = TapEngine(settings: settings); e.model = m; e.zonesNeedingMultiTap = multiTapZones
        var states: [(Double, Bool)] = []
        s1.forEach { s, ctx in
            for ev in e.ingest(s, context: ctx) { if case .candidate(let c) = ev { states.append((c.t, e.isUnfamiliar)) } }
        }
        // State just before each held-out tap was classified (the previous candidate's resulting state).
        for i in gt.indices where fold[i] == f {
            held += 1
            if let c = states.last(where: { $0.0 < gt[i].t - 0.001 }), c.1 { strictAt += 1 }
        }
    }
}
print("session1 in-session: held-out taps arriving in strict mode \(strictAt)/\(held)")

// C: spliced doubles with the guard already strict (as after handling the machine or a run of junk).
let grille = gt.indices.filter { gt[$0].zone == "left-grille" && gt[$0].features != nil }
let allOnsets = s1.captures.flatMap(\.onsets).sorted()
func next(_ i: Int) -> Double { allOnsets.first { $0 > gt[i].t + 0.05 } ?? .infinity }
for forced in [false, true] {
    var fired = 0, total = 0
    for half in 0..<2 {
        let testTaps = grille.enumerated().filter { $0.offset % 2 == half }.map(\.element)
        let model = train(gt.indices.filter { gt[$0].features != nil && !testTaps.contains($0) }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
        let pairs = zip(testTaps, testTaps.dropFirst() + testTaps.prefix(1)).map { ($0, $1) }
        var r = composeStream(background: rest, seconds: 3 + 3 * Double(pairs.count) + 1)
        var starts: [Double] = []
        for (k, (a, b)) in pairs.enumerated() {
            let t0 = 3 + 3 * Double(k)
            addTap(from: s1, onset: gt[a].features!.t, into: &r, at: t0, nextOnset: next(a))
            addTap(from: s1, onset: gt[b].features!.t, into: &r, at: t0 + 0.25, nextOnset: next(b))
            starts.append(t0)
        }
        let e = TapEngine(settings: settings); e.model = model; e.zonesNeedingMultiTap = multiTapZones
        if forced { e.familiarity.unfamiliarRatio = -1 }   // strict as soon as 3 candidates are known
        var doubles: [Double] = []
        r.forEach { s, ctx in for ev in e.ingest(s, context: ctx) { if case .gesture(let g) = ev, g.gesture == "double" { doubles.append(g.t) } } }
        fired += starts.filter { t0 in doubles.contains { $0 >= t0 - 0.05 && $0 <= t0 + 0.5 } }.count
        total += pairs.count
    }
    print("spliced doubles, guard \(forced ? "forced strict" : "normal"): \(fired)/\(total)")
}

// D: numeric edge cases.
let nf = gt.first { $0.features != nil }!.features!
let empty = Trainer().train().0
print("empty model: typical \(String(describing: empty.typicalDistance)) reject \(empty.rejectDistance) upgraded same: \(empty.upgraded().rejectDistance == empty.rejectDistance)")
do {
    let e = TapEngine(settings: settings); e.model = empty
    var g = FamiliarityGuard(); let r = empty.classifyDetailed(nf); print("empty classify: \(r.zone) d=\(r.distance) admit=\(g.admit(r, model: empty, t: 0))")
}
let t1 = Trainer(); for x in gt where x.zone == "left-grille" && x.features != nil { t1.add(x.features!, label: x.zone) }
let one = t1.train().0
let r1 = one.classifyDetailed(nf)
print("one-zone model: labels \(one.labels) typical \(String(describing: one.typicalDistance)) reject \(f3(one.rejectDistance)) -> classify \(r1.zone) conf \(f3(r1.confidence)) d \(f3(r1.distance))")
var nanF = nf; nanF.values[3] = .nan
let full = train(gt.compactMap { $0.features == nil ? nil : LabeledSample(label: $0.zone, features: $0.features!) })
let rn = full.classifyDetailed(nanF)
var gN = FamiliarityGuard()
print("NaN feature: zone \(rn.zone) conf \(rn.confidence) d \(rn.distance) admit \(gN.admit(rn, model: full, t: 0))")
var infF = nf; infF.values[3] = .infinity
let ri = full.classifyDetailed(infF); print("inf feature: zone \(ri.zone) conf \(ri.confidence) d \(ri.distance)")
// typicalDistance 0 or negative, and NaN
var z0 = full; z0.typicalDistance = 0; var g0 = FamiliarityGuard(); print("typical 0 admit: \(g0.admit(full.classifyDetailed(nf), model: z0, t: 0))")
var zn = full; zn.typicalDistance = .nan; var gn = FamiliarityGuard()
for k in 0..<5 { _ = gn.admit(full.classifyDetailed(nf), model: zn, t: Double(k)) }
print("typical NaN: medianRatio \(String(describing: gn.medianRatio)) unfamiliar \(gn.isUnfamiliar)")
// old model with few samples per zone (< 3) -> upgrade skipped?
let t2 = Trainer(); var cnt: [String: Int] = [:]
for x in gt where x.features != nil { if cnt[x.zone, default: 0] < 2 { t2.add(x.features!, label: x.zone); cnt[x.zone, default: 0] += 1 } }
var tiny = t2.train().0; tiny.typicalDistance = nil
print("tiny model (2 per zone): upgraded typical \(String(describing: tiny.upgraded().typicalDistance)) reject \(tiny.rejectDistance)")
// Engine with a model reassigned repeatedly: does the upgrade loop or reset the guard every time?
var oldM = full; oldM.typicalDistance = nil; oldM.rejectDistance = 1e6
let e2 = TapEngine(settings: settings); e2.model = oldM; let u1 = e2.model!.rejectDistance; e2.model = oldM
print("reassign old model: reject \(f3(u1)) then \(f3(e2.model!.rejectDistance)), typical \(f3(e2.model!.typicalDistance!))")
