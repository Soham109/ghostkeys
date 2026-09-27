// Verification (VERIFY_07_DETECTION.md): per-zone true-accept rates with miss reasons, old saved models upgraded, guard engagement. See ../run.sh.
import Foundation
import GhostkeysDetection

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
let args = CommandLine.arguments
let dataDir = args[1], testsDir = args[2], dumpDir = args[3]
var settings = DetectionSettings()
let sets = ["calib1", "calib_bak", "calib2"].compactMap { loadCalibration("\(dataDir)/\($0)", name: $0) }
let s1 = loadGkrec("\(dataDir)/session1.gkrec")!
let rest = loadRestRecording(testsDir: testsDir)!
#if HAS_FAMILIARITY
let build = "head"
#else
let build = "prev"
#endif
func f3(_ x: Double) -> String { String(format: "%.3f", x) }

// Outcome of one zone tap: accepted right, wrong, or why not.
enum Why: String, CaseIterable { case ok, wrong, knnNone, reject, guardStrict, lowConf }
struct ZoneTally { var n = 0; var c: [Why: Int] = [:] }

func outcome(_ m: ZoneModel, _ r0: ZoneModel.Result, label: String, familiar: Bool) -> Why {
    let r = r0
    if r.zone == ZoneModel.noneLabel { return r.outOfDistribution ? .reject : .knnNone }
    if !familiar { return .guardStrict }
    if r.confidence < settings.minConfidence { return .lowConf }
    return r.zone == label ? .ok : .wrong
}

func stripOld(_ m: ZoneModel) -> ZoneModel {
    let d = try! JSONEncoder().encode(m)
    var o = try! JSONSerialization.jsonObject(with: d) as! [String: Any]
    o.removeValue(forKey: "logistic"); o.removeValue(forKey: "platt"); o.removeValue(forKey: "typicalDistance")
    return try! JSONDecoder().decode(ZoneModel.self, from: JSONSerialization.data(withJSONObject: o))
}

// E1: per-zone recall, in-session CV (10 reps) and cross, with miss reasons, through the live rule.
func perZone(_ title: String, _ evals: [(ZoneModel, [LabeledSample])], useGuard: Bool = true) {
    var z: [String: ZoneTally] = [:]
    var negAcc = 0, negN = 0
    for (m0, xs) in evals {
        #if HAS_FAMILIARITY
        let m = useGuard ? m0.upgraded() : m0
        var g = FamiliarityGuard()
        if !useGuard { g.unfamiliarRatio = .infinity }
        #else
        let m = m0
        #endif
        for x in xs.sorted(by: { $0.features.t < $1.features.t }) {
            let r = m.classifyDetailed(x.features)
            #if HAS_FAMILIARITY
            let fam = g.admit(r, model: m, t: x.features.t)
            #else
            let fam = true
            #endif
            if x.label == ZoneModel.noneLabel {
                negN += 1; if r.zone != ZoneModel.noneLabel && fam && r.confidence >= settings.minConfidence { negAcc += 1 }
                continue
            }
            var t = z[x.label] ?? ZoneTally(); t.n += 1; t.c[outcome(m, r, label: x.label, familiar: fam), default: 0] += 1; z[x.label] = t
        }
    }
    print("\n## \(title) [\(build)\(useGuard ? "" : ", guard off")]  negatives accepted \(negAcc)/\(negN)")
    print("zone            n     ok  wrong knnNone reject guard lowConf")
    var tot = ZoneTally()
    for k in z.keys.sorted() {
        let t = z[k]!; tot.n += t.n; for (w, c) in t.c { tot.c[w, default: 0] += c }
        print(k.padding(toLength: 14, withPad: " ", startingAt: 0) + String(format: "%4d  %5.3f %5.3f %5.3f  %5.3f %5.3f %5.3f", t.n,
              Double(t.c[.ok] ?? 0) / Double(t.n), Double(t.c[.wrong] ?? 0) / Double(t.n), Double(t.c[.knnNone] ?? 0) / Double(t.n),
              Double(t.c[.reject] ?? 0) / Double(t.n), Double(t.c[.guardStrict] ?? 0) / Double(t.n), Double(t.c[.lowConf] ?? 0) / Double(t.n)))
    }
    let t = tot
    print("ALL".padding(toLength: 14, withPad: " ", startingAt: 0) + String(format: "%4d  %5.3f %5.3f %5.3f  %5.3f %5.3f %5.3f", t.n,
          Double(t.c[.ok] ?? 0) / Double(t.n), Double(t.c[.wrong] ?? 0) / Double(t.n), Double(t.c[.knnNone] ?? 0) / Double(t.n),
          Double(t.c[.reject] ?? 0) / Double(t.n), Double(t.c[.guardStrict] ?? 0) / Double(t.n), Double(t.c[.lowConf] ?? 0) / Double(t.n)))
}

var cvEvals: [String: [(ZoneModel, [LabeledSample])]] = [:]
for set in sets {
    for rep in 0..<10 {
        let fold = stratifiedFolds(set.labels, k: 5, seed: UInt64(1000 + rep))
        for f in 0..<5 {
            let m = train(set.samples.indices.filter { fold[$0] != f }.map { set.samples[$0] })
            cvEvals[set.name, default: []].append((m, set.samples.indices.filter { fold[$0] == f }.map { set.samples[$0] }))
        }
    }
}
for set in sets { perZone("in-session CV \(set.name)", cvEvals[set.name]!) }
#if HAS_FAMILIARITY
for set in sets { perZone("in-session CV \(set.name)", cvEvals[set.name]!, useGuard: false) }
#endif
var crossEvals: [(ZoneModel, [LabeledSample])] = []
for a in sets { let m = train(a.samples); for b in sets where b.name != a.name {
    crossEvals.append((m, b.samples.filter { $0.label == ZoneModel.noneLabel || m.labels.contains($0.label) })) } }
perZone("cross-session (retrained)", crossEvals)
var savedEvals: [(ZoneModel, [LabeledSample])] = []
for a in sets { let m = a.savedModel!; for b in sets where b.name != a.name {
    savedEvals.append((m, b.samples.filter { $0.label == ZoneModel.noneLabel || m.labels.contains($0.label) })) } }
perZone("cross-session (saved models)", savedEvals)

// E2: what upgrading an old-style model (no ensemble, old reject rule) does to in-session held-out taps.
// prev writes the old-style fold models; head loads them and scores before (as saved) and after upgrade.
#if HAS_FAMILIARITY
for set in sets {
    var before: [(ZoneModel, [LabeledSample])] = [], after: [(ZoneModel, [LabeledSample])] = []
    for (i, (_, xs)) in cvEvals[set.name]!.enumerated() {
        guard let d = FileManager.default.contents(atPath: "\(dumpDir)/\(set.name)-\(i).json"),
              let m = try? JSONDecoder().decode(ZoneModel.self, from: d) else { continue }
        before.append((m, xs)); after.append((m, xs))
    }
    // "before": no upgrade, no guard (exactly how the old build ran a saved model).
    perZone("old-style model, in-session, NOT upgraded \(set.name)", before, useGuard: false)
    perZone("old-style model, in-session, upgraded + guard \(set.name)", after)
    let rd = before.map { $0.0.rejectDistance }, ru = after.map { $0.0.upgraded().rejectDistance }
    print("reject distance old rule median \(f3(Stats_median(rd)))  upgraded median \(f3(Stats_median(ru)))")
}
for set in sets { let m = set.savedModel!, u = m.upgraded()
    print("saved \(set.name): reject \(f3(m.rejectDistance)) -> \(f3(u.rejectDistance)), typical \(f3(u.typicalDistance ?? .nan))") }
#else
try? FileManager.default.createDirectory(atPath: dumpDir, withIntermediateDirectories: true)
for set in sets { for (i, (m, _)) in cvEvals[set.name]!.enumerated() {
    try! JSONEncoder().encode(stripOld(m)).write(to: URL(fileURLWithPath: "\(dumpDir)/\(set.name)-\(i).json")) } }
#endif
func Stats_median(_ x: [Double]) -> Double { let s = x.sorted(); return s.isEmpty ? .nan : s[s.count / 2] }

#if HAS_FAMILIARITY
// E3: distance ratios (distance / typical) of in-session taps vs in-session junk.
print("\n## distance ratio (distance / typicalDistance), in-session held-out")
for set in sets {
    var taps: [Double] = [], negs: [Double] = []
    for (m, xs) in cvEvals[set.name]! { let typ = m.typicalDistance!
        for x in xs { let r = m.classifyDetailed(x.features); (x.label == ZoneModel.noneLabel ? { negs.append(r.distance / typ) } : { taps.append(r.distance / typ) })() } }
    func q(_ a: [Double], _ p: Double) -> String { f3(pct(a, p)) }
    print("\(set.name): taps p50 \(q(taps, 0.5)) p90 \(q(taps, 0.9)) share>1.8 \(f3(Double(taps.filter { $0 > 1.8 }.count) / Double(taps.count)))   typing negatives p50 \(q(negs, 0.5)) share>1.8 \(f3(Double(negs.filter { $0 > 1.8 }.count) / Double(max(negs.count, 1))))")
}

// E4: junk-heavy in-session stream: J junk candidates (this session's own held-out typing negatives, i.e. spikes
// that got past the gates) before every held-out tap. What share of taps is lost to strict mode?
print("\n## in-session taps with J junk candidates before each tap (junk = same session's typing negatives)")
for set in sets {
    var line = "\(set.name):"
    for J in [0, 1, 2, 3] {
        var ok = 0, n = 0, strictTaps = 0
        for (m, xs) in cvEvals[set.name]! {
            let junk = xs.filter { $0.label == ZoneModel.noneLabel }
            let taps = xs.filter { $0.label != ZoneModel.noneLabel }
            guard !junk.isEmpty else { continue }
            var g = FamiliarityGuard(); var t = 0.0, ji = 0
            for x in taps {
                for _ in 0..<J { t += 5; _ = g.admit(m.classifyDetailed(junk[ji % junk.count].features), model: m, t: t); ji += 1 }
                t += 5
                if g.isUnfamiliar { strictTaps += 1 }
                let r = m.classifyDetailed(x.features)
                let fam = g.admit(r, model: m, t: t)
                n += 1; if fam && r.zone == x.label && r.confidence >= settings.minConfidence { ok += 1 }
            }
        }
        line += "  J=\(J): recall \(f3(Double(ok) / Double(n))) strict \(f3(Double(strictTaps) / Double(n)))"
    }
    print(line)
}
// Strict-mode recall: share of held-out taps that would pass strict mode (conf >= 0.9, ratio <= 3).
for set in sets {
    var n = 0, pass = 0, normal = 0
    for (m, xs) in cvEvals[set.name]! { for x in xs where x.label != ZoneModel.noneLabel {
        let r = m.classifyDetailed(x.features); n += 1
        if r.zone == x.label && r.confidence >= 0.8 { normal += 1 }
        if r.zone == x.label && r.confidence >= 0.9 && r.distance / m.typicalDistance! <= 3 { pass += 1 } } }
    print("\(set.name): recall normal \(f3(Double(normal) / Double(n)))  recall if strict \(f3(Double(pass) / Double(n)))")
}

// E5: session1 (lap) in-session, guard on vs off: held-out recall, handling taps, time in strict mode.
print("\n## session1 in-session: guard on vs off")
let gt = groundTruth(s1, settings: settings)
for guardOn in [true, false] {
    var held = 0, correct = 0, handling = 0, strictAtTap = 0, cands = 0, strictCands = 0
    for rep in 0..<5 {
        let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: UInt64(2000 + rep))
        for f in 0..<5 {
            let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
            let e = TapEngine(settings: settings); e.model = m; e.zonesNeedingMultiTap = multiTapZones
            if !guardOn { e.familiarity.unfamiliarRatio = .infinity }
            var taps: [TapEvent] = []
            var candStrict: [(Double, Bool)] = []
            s1.forEach { s, ctx in
                for ev in e.ingest(s, context: ctx) {
                    if case .tap(let tp) = ev { taps.append(tp) }
                    if case .candidate(let c) = ev { candStrict.append((c.t, e.isUnfamiliar)) }
                }
            }
            cands += candStrict.count; strictCands += candStrict.filter { $0.1 }.count
            for i in gt.indices where fold[i] == f {
                held += 1
                if taps.contains(where: { abs($0.t - gt[i].t) <= 0.08 && $0.zone == gt[i].zone }) { correct += 1 }
                if let c = candStrict.last(where: { $0.0 <= gt[i].t + 0.001 }), c.1 { strictAtTap += 1 }
            }
            handling += taps.filter { t in s1.handling!.contains { t.t >= $0.0 && t.t <= $0.1 } }.count
        }
    }
    print("guard \(guardOn ? "on " : "off"): recall \(f3(Double(correct) / Double(held))) (\(correct)/\(held)), handling taps \(handling) over 25 runs, candidates in strict mode \(strictCands)/\(cands)")
}
#endif

// E6: look-ahead sweep on the splice stream: key or pointer event D ms after the second tap.
print("\n## splice doubles: key D ms after the second tap (fires / total)")
do {
    let gt = groundTruth(s1, settings: settings)
    let grille = gt.indices.filter { gt[$0].zone == "left-grille" && gt[$0].features != nil }
    let allOnsets = s1.captures.flatMap(\.onsets).sorted()
    func next(_ i: Int) -> Double { allOnsets.first { $0 > gt[i].t + 0.05 } ?? .infinity }
    var line = ""
    for D in [-1.0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.6] {
        var fired = 0, total = 0
        for half in 0..<2 {
            let testTaps = grille.enumerated().filter { $0.offset % 2 == half }.map(\.element)
            let model = train(gt.indices.filter { gt[$0].features != nil && !testTaps.contains($0) }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
            let pairs = zip(testTaps, testTaps.dropFirst() + testTaps.prefix(1)).map { ($0, $1) }
            var r = composeStream(background: rest, seconds: 3 + 3 * Double(pairs.count) + 1)
            var starts: [Double] = [], seconds: [Double] = []
            for (k, (a, b)) in pairs.enumerated() {
                let t0 = 3 + 3 * Double(k)
                addTap(from: s1, onset: gt[a].features!.t, into: &r, at: t0, nextOnset: next(a))
                addTap(from: s1, onset: gt[b].features!.t, into: &r, at: t0 + 0.25, nextOnset: next(b))
                starts.append(t0); seconds.append(t0 + 0.25)
            }
            let keys = D < 0 ? [] : seconds.map { $0 + D }
            let run = runEngine(r, model: model, settings: settings, extraKeys: keys)
            let d = run.gestures.filter { $0.g.gesture == "double" && $0.g.zone == "left-grille" }
            fired += starts.filter { t0 in d.contains { $0.g.t >= t0 - 0.05 && $0.g.t <= t0 + 0.5 } }.count
            total += pairs.count
        }
        line += "  \(D < 0 ? "none" : "\(Int(D * 1000))ms"): \(fired)/\(total)"
    }
    print(line)
}
