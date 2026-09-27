// Round 2 checks (docs/review/DETECTION_ROUND2.md): the costs VERIFY_07 found, guarded like every other metric.
//
//   upg.*      in-session recall of models saved by older builds (no ensemble, old reject rule) after
//              ZoneModel.upgraded(), per zone, through the live decision (guard included). The user's live model is
//              such a model (calib2's). Needs the old-style fold models in <data>/oldstyle-folds/ (see below).
//   guard.*    how often the familiarity guard is strict when real taps arrive: on the lap recording with its own
//              model, and on each calibration when typing spikes that got past the gates come before every tap.
//   splice.strict.*   composed grille doubles with the guard already strict.
//
// Old-style fold models: 10 x 5 stratified folds per calibration (the same seeds as cv.*), trained by the library as
// it was before the 27 Sep 2026 precision commit (f9645cd) and stripped of the fields it did not save. They are
// written by daemon/analysis/bench/verify07/run.sh into daemon/.build-bench/verify07/dump/; copy that folder to
// daemon/analysis/data/oldstyle-folds/. Without it the upg.* metrics are skipped.

import Foundation
import GhostkeysDetection

#if HAS_FAMILIARITY

/// Loads `<dir>/<set>-<i>.json` fold models (i = rep * 5 + fold) and pairs them with their held-out samples.
func oldStyleFolds(_ set: CalibrationSet, dir: String, reps: Int = 10) -> [(ZoneModel, [LabeledSample])]? {
    var out: [(ZoneModel, [LabeledSample])] = []
    for rep in 0..<reps {
        let fold = stratifiedFolds(set.labels, k: 5, seed: UInt64(1000 + rep))
        for f in 0..<5 {
            guard let d = FileManager.default.contents(atPath: "\(dir)/\(set.name)-\(rep * 5 + f).json"),
                  let m = try? JSONDecoder().decode(ZoneModel.self, from: d) else { return nil }
            out.append((m, set.samples.indices.filter { fold[$0] == f }.map { set.samples[$0] }))
        }
    }
    return out
}

/// upg.*: old-style models, as the daemon runs them today (upgraded on load, guard on), scored in-session.
/// `asSaved` is the same models before the upgrade and without the guard (how the old build ran them): info only.
func suiteUpgradedOld(_ sets: [CalibrationSet], dataDir: String, settings: DetectionSettings, report: Report) {
    let dir = "\(dataDir)/oldstyle-folds"
    for set in sets {
        guard let folds = oldStyleFolds(set, dir: dir) else {
            log("upg: no old-style fold models for \(set.name) in \(dir) (see GuardSuites.swift); skipped")
            continue
        }
        var upgraded = Tally(), saved = Tally()
        for (m, xs) in folds {
            scoreStream(m, xs, &upgraded, settings)                       // Decider upgrades and guards
            for x in xs { saved.score(m.classifyDetailed(x.features), x, settings) }
        }
        let p = "upg.\(set.name)"
        report.add("\(p).recall", upgraded.recall, .up, "old-style model after upgraded(), in-session held-out taps")
        report.add("\(p).asSaved.recall", saved.recall, .info, "same models as saved (no upgrade, no guard)")
        report.add("\(p).wrongZone", upgraded.wrongRate, .down)
        report.add("\(p).negAccepted", upgraded.negRate, .down, "typing negatives accepted (as saved: \(String(format: "%.3f", saved.negRate)))")
        // Guard engagement with these models when J of the session's typing spikes (spikes that got past the gates)
        // come before every tap: the live model is confident about more typing spikes than a fresh one.
        for J in [1, 2] {
            report.add("\(p).junk\(J).strictAtTap", junkStrictShare(folds.map { ($0.0.upgraded(), $0.1) }, junkPerTap: J), .down,
                       "taps arriving strict with \(J) typing spike(s) before each, upgraded old-style model")
        }
        // Per zone only for the live model's calibration: the other two are summarised above.
        if set.name == "calib2" {
            for z in upgraded.perZone.keys.sorted() {
                let u = upgraded.perZone[z]!
                report.add("\(p).zone.\(z)", Double(u.strong) / Double(max(u.n, 1)), .up,
                           "per zone; as saved \(String(format: "%.3f", Double(saved.perZone[z]?.strong ?? 0) / Double(max(saved.perZone[z]?.n ?? 1, 1))))")
            }
        }
    }
}

/// Share of held-out taps that arrive while the guard is strict, when `junkPerTap` of the fold's own typing negatives
/// are classified (5 s apart) before every tap.
func junkStrictShare(_ folds: [(ZoneModel, [LabeledSample])], junkPerTap J: Int) -> Double {
    var n = 0, strict = 0
    for (m, xs) in folds {
        let junk = xs.filter { $0.label == ZoneModel.noneLabel }
        guard !junk.isEmpty else { continue }
        var g = FamiliarityGuard(); var t = 0.0, ji = 0
        for x in xs where x.label != ZoneModel.noneLabel {
            for _ in 0..<J { t += 5; _ = g.admit(m.classifyDetailed(junk[ji % junk.count].features), model: m, t: t); ji += 1 }
            t += 5
            if g.isUnfamiliar { strict += 1 }
            _ = g.admit(m.classifyDetailed(x.features), model: m, t: t)
            n += 1
        }
    }
    return Double(strict) / Double(max(n, 1))
}

/// guard.s1.strictAtTap: share of held-out lap taps that arrive while the guard is strict (state after the last
/// candidate before the tap), lap recording with its own model, 5 x 5 folds.
/// guard.junkN.<set>.strictAtTap: calibration taps with N of the session's own typing spikes before each (spikes
/// that got past the gates), in-session models.
func suiteGuardEngagement(_ rec: Recording, sets: [CalibrationSet], settings: DetectionSettings, report: Report) {
    let gt = groundTruth(rec, settings: settings)
    var held = 0, strictAt = 0, cands = 0, strictCands = 0
    for rep in 0..<5 {
        let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: UInt64(2000 + rep))
        for f in 0..<5 {
            let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }
                .map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
            let e = TapEngine(settings: settings); e.model = m; e.zonesNeedingMultiTap = multiTapZones
            var states: [(Double, Bool)] = []
            rec.forEach { s, ctx in
                for ev in e.ingest(s, context: ctx) { if case .candidate(let c) = ev { states.append((c.t, e.isUnfamiliar)) } }
            }
            cands += states.count; strictCands += states.filter(\.1).count
            for i in gt.indices where fold[i] == f {
                held += 1
                if let c = states.last(where: { $0.0 < gt[i].t - 0.001 }), c.1 { strictAt += 1 }
            }
        }
    }
    report.add("guard.s1.strictAtTap", Double(strictAt) / Double(max(held, 1)), .down,
               "held-out lap taps that arrive while the guard is strict (own model)")
    report.add("guard.s1.strictCandidates", Double(strictCands) / Double(max(cands, 1)), .info,
               "all lap candidates (handling included) seen while strict")

    for set in sets {
        for J in [1, 2] {
            var n = 0, strict = 0, ok = 0
            for rep in 0..<10 {
                let fold = stratifiedFolds(set.labels, k: 5, seed: UInt64(1000 + rep))
                for f in 0..<5 {
                    let m = train(set.samples.indices.filter { fold[$0] != f }.map { set.samples[$0] })
                    let xs = set.samples.indices.filter { fold[$0] == f }.map { set.samples[$0] }
                    let junk = xs.filter { $0.label == ZoneModel.noneLabel }
                    guard !junk.isEmpty else { continue }
                    var g = FamiliarityGuard(); var t = 0.0, ji = 0
                    for x in xs where x.label != ZoneModel.noneLabel {
                        for _ in 0..<J { t += 5; _ = g.admit(m.classifyDetailed(junk[ji % junk.count].features), model: m, t: t); ji += 1 }
                        t += 5
                        if g.isUnfamiliar { strict += 1 }
                        let r = m.classifyDetailed(x.features)
                        let fam = g.admit(r, model: m, t: t)
                        n += 1
                        if fam && r.zone == x.label && r.confidence >= settings.minConfidence { ok += 1 }
                    }
                }
            }
            report.add("guard.junk\(J).\(set.name).strictAtTap", Double(strict) / Double(max(n, 1)), .down,
                       "taps arriving strict with \(J) typing spike(s) before each")
            report.add("guard.junk\(J).\(set.name).recall", Double(ok) / Double(max(n, 1)), .up)
        }
    }
}

/// splice.strict.double.success: the composed doubles of suiteSplice with the guard already strict when the stream
/// starts (as after handling the machine or a run of odd candidates). Strict mode is forced by a negative
/// threshold, primed with three of the model's own training taps so it is strict from the first double.
func suiteSpliceStrict(_ s1: Recording, rest: Recording, settings: DetectionSettings, report: Report) {
    let gt = groundTruth(s1, settings: settings)
    let grille = gt.indices.filter { gt[$0].zone == "left-grille" && gt[$0].features != nil }
    let allOnsets = s1.captures.flatMap(\.onsets).sorted()
    func next(_ i: Int) -> Double { allOnsets.first { $0 > gt[i].t + 0.05 } ?? .infinity }
    var fired = 0, total = 0
    for half in 0..<2 {
        let testTaps = grille.enumerated().filter { $0.offset % 2 == half }.map(\.element)
        let trainSet = gt.indices.filter { gt[$0].features != nil && !testTaps.contains($0) }
            .map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) }
        let model = train(trainSet)
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
        e.familiarity.unfamiliarRatio = -1
        let live = e.model!
        for x in trainSet.prefix(3) { _ = e.familiarity.admit(live.classifyDetailed(x.features), model: live, t: 0) }
        var doubles: [Double] = []
        var strictAtStart = true
        r.forEach { s, ctx in
            if s.t < 0.01 { strictAtStart = strictAtStart && e.isUnfamiliar }
            for ev in e.ingest(s, context: ctx) { if case .gesture(let g) = ev, g.gesture == "double" { doubles.append(g.t) } }
        }
        if !strictAtStart { log("splice.strict: guard was not strict at the start") }
        fired += starts.filter { t0 in doubles.contains { $0 >= t0 - 0.05 && $0 <= t0 + 0.5 } }.count
        total += pairs.count
    }
    report.add("splice.strict.double.success", Double(fired) / Double(max(total, 1)), .up,
               "composed grille doubles that fire with the guard forced strict")
}

#endif
