// Round 3 checks (docs/review/DETECTION_ROUND3.md): one model per posture (ZoneModelSet), picked by gravity.
//
// There is no recording with the same user in both postures and known posture labels, so the checks combine what
// exists: the three desk calibrations (features only, no gravity) and the lap recording session1 (raw IMU). For each
// desk calibration and each of 5 folds of the lap taps, a set is trained with ZoneModelSet.train from the desk samples
// (posture "desk") and 4/5 of the lap taps (posture "lap", gravity stamped by the engine), and installed on a
// TapEngine with `modelSet`. Then:
//   posture.<v>.s1.*     session1 replayed: which posture is live at each held-out lap tap, recall, switches, false
//                        taps while handling
//   posture.<v>.rest.*   the 12 s desk rest recording replayed with the same sets: is the desk model live
//   xpost.*              cross-posture recall without a set, for reference (one model for both postures)
// Variants:
//   known        desk samples carry the desk's gravity (the rest recording's direction), as a desk calibration made
//                by this build would; the set's default rules (gravity plus tap evidence)
//   gravityOnly  same, with tap evidence off (gravity alone decides)
//   legacy       desk samples carry no gravity (what the user's saved samples look like today); default rules
//   ownOnly      as known, but each posture's model learns only its own samples (no borrowed zones or negatives)
//   noNegPool    as known, zones borrowed but negatives not pooled across postures

import Foundation
import GhostkeysDetection

#if HAS_POSTURE

func unitVector(_ v: SIMD3<Double>) -> SIMD3<Double> { v / max((v * v).sum().squareRoot(), 1e-12) }

func suitePosture(_ s1: Recording, rest: Recording, sets: [CalibrationSet], settings: DetectionSettings, report: Report) {
    let gt = groundTruth(s1, settings: settings)
    let desk = unitVector(rest.a.reduce(SIMD3<Double>(0, 0, 0), +) / Double(max(rest.a.count, 1)))
    let lapZones = Set(gt.map(\.zone))

    for variant in ["known", "gravityOnly", "legacy", "ownOnly", "noNegPool"] {
        var held = 0, lapActive = 0, switches = 0, handlingTaps = 0
        var handlingSeconds = 0.0, seconds = 0.0
        var score = ReplayScore()
        var restTicks = 0, restDesk = 0, restSwitches = 0, restSeconds = 0.0
        var lapGravityAngles: [Double] = []
        for set in sets {
            let deskSamples = set.samples.map { s in
                ZoneModelSet.PostureSample(features: TapFeatures(values: s.features.values, t: s.features.t,
                                                                 gravity: variant == "legacy" ? nil : desk),
                                           label: s.label, posture: "desk")
            }
            let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: 2000)
            for f in 0..<5 {
                let lapTrain = gt.indices.filter { fold[$0] != f && gt[$0].features != nil }
                    .map { ZoneModelSet.PostureSample(features: gt[$0].features!, label: gt[$0].zone, posture: "lap") }
                var trained = ZoneModelSet.train(deskSamples + lapTrain, borrowZones: variant != "ownOnly",
                                                 poolNegatives: variant != "ownOnly" && variant != "noNegPool")
                trained.set.tapEvidence = variant != "gravityOnly"
                if let g = trained.set.models["lap"]?.calibrationGravity { lapGravityAngles.append(ZoneModelSet.angleDegrees(g, desk)) }

                // session1 with the set.
                let (run, timeline) = runWithSet(s1, set: trained.set, settings: settings)
                let heldIdx = Set(gt.indices.filter { fold[$0] == f })
                score.add(run, rec: s1, gt: gt, scored: heldIdx)
                for i in heldIdx {
                    held += 1
                    if posture(at: gt[i].t, timeline) == "lap" { lapActive += 1 }
                }
                switches += max(0, timeline.count - 1)
                if verbose { log("  \(variant) \(set.name) fold \(f): " + timeline.map { String(format: "%.1f s %@", $0.0, $0.1) }.joined(separator: ", ")) }
                seconds += s1.duration

                // Desk at rest with the same set.
                let (_, restTimeline) = runWithSet(rest, set: trained.set, settings: settings)
                restSwitches += max(0, restTimeline.count - 1)
                restSeconds += rest.duration
                var k = 0.0
                while k < rest.duration { restTicks += 1; if posture(at: k, restTimeline) == "desk" { restDesk += 1 }; k += 0.1 }
            }
        }
        handlingTaps = score.handlingTaps; handlingSeconds = score.handlingSeconds
        let p = "posture.\(variant)"
        report.add("\(p).s1.lapActiveAtTap", Double(lapActive) / Double(max(held, 1)), .up,
                   "held-out lap taps that arrive while the lap model is live (desk + lap set, picked by gravity)")
        report.add("\(p).s1.recall", Double(score.correct) / Double(max(score.held, 1)), .up,
                   "held-out lap taps accepted with the right zone through the set (lap model alone: s1.recall; desk alone: s1x.recall)")
        report.add("\(p).s1.wrongZone", Double(score.wrong) / Double(max(score.held, 1)), .down)
        report.add("\(p).s1.switchesPerMin", Double(switches) / max(seconds / 60, 1e-9), .down,
                   "posture switches after the first placement, per minute of the lap recording")
        report.add("\(p).s1.handlingTapsPerMin", Double(handlingTaps) / max(handlingSeconds / 60, 1e-9), .down)
        report.add("\(p).rest.deskActive", Double(restDesk) / Double(max(restTicks, 1)), .up,
                   "share of the desk rest recording with the desk model live")
        report.add("\(p).rest.switchesPerMin", Double(restSwitches) / max(restSeconds / 60, 1e-9), .down)
        if variant == "known" {
            report.add("posture.lapModelTiltDegrees", pct(lapGravityAngles, 0.5), .info,
                       "angle between the lap models' calibration gravity and the desk's (median over folds)")
        }
    }

    // Desk taps must not switch a desk + lap set to the lap model. Feature level (the calibrations have no signal): the
    // set's desk model is one calibration's, its lap model is trained on every lap tap, and the taps and typing
    // negatives of each OTHER calibration (another desk day) are observed in order, 2 s apart. After a wrong switch
    // the desk is selected again and counting goes on.
    let fullLap = train(gt.compactMap { g in g.features.map { LabeledSample(label: g.zone, features: $0) } })
    var observed = 0, wrongSwitches = 0
    for a in sets {
        var deskModel = train(a.samples)
        deskModel.calibrationGravity = desk
        var lapModel = fullLap
        if lapModel.calibrationGravity == nil { lapModel.calibrationGravity = unitVector(SIMD3(0.1, 0, -1)) }
        var set = ZoneModelSet(models: ["desk": deskModel, "lap": lapModel])
        set.update(gravity: desk, t: 0)
        var t = 0.0
        for b in sets where b.name != a.name {
            for x in b.samples {
                t += 2
                observed += 1
                if set.observe(x.features, t: t) { wrongSwitches += 1; set.select("desk") }
            }
        }
    }
    report.add("posture.deskTaps.wrongSwitchesPer100", 100 * Double(wrongSwitches) / Double(max(observed, 1)), .down,
               "desk taps and negatives of another desk day that switch a desk + lap set to lap, per 100 candidates (\(observed))")

    // Reference on the same folds: the lap taps' own model alone (no borrowed desk zones, always live).
    var lapOnly = ReplayScore()
    let fold = stratifiedFolds(gt.map(\.zone), k: 5, seed: 2000)
    for f in 0..<5 {
        let m = train(gt.indices.filter { fold[$0] != f && gt[$0].features != nil }.map { LabeledSample(label: gt[$0].zone, features: gt[$0].features!) })
        lapOnly.add(runEngine(s1, model: m, settings: settings), rec: s1, gt: gt, scored: Set(gt.indices.filter { fold[$0] == f }))
    }
    report.add("posture.ref.lapOnly.s1.recall", Double(lapOnly.correct) / Double(max(lapOnly.held, 1)), .up,
               "same folds, lap model alone (3 zones, nothing borrowed), for comparison with posture.*.s1.recall")

    // Cross-posture recall without a set, for reference: each desk model on lap taps is s1x.recall. The other
    // direction: a model trained on all lap taps, scored on the desk calibrations' taps of the same zones.
    let lapModel = fullLap
    var tally = Tally()
    for set in sets { scoreStream(lapModel, set.samples.filter { $0.label == ZoneModel.noneLabel || lapZones.contains($0.label) }, &tally, settings) }
    report.add("xpost.deskByLap.recall", tally.recall, .info, "desk calibration taps (lap zones) accepted with the right zone by a lap model")
    report.add("xpost.deskByLap.wrongZone", tally.wrongRate, .down)
    report.add("xpost.deskByLap.negAccepted", tally.negRate, .down, "desk typing negatives accepted by a lap model")
}

/// Replays `rec` through an engine that follows `set`. Returns the run and the posture timeline: (time, posture) at the
/// start and at every switch.
func runWithSet(_ rec: Recording, set: ZoneModelSet, settings: DetectionSettings) -> (EngineRun, [(Double, String)]) {
    let e = TapEngine(settings: settings)
    e.zonesNeedingMultiTap = multiTapZones
    e.modelSet = set
    var run = EngineRun()
    var timeline: [(Double, String)] = []
    var placedAt: Double?
    rec.forEach { s, ctx in
        for ev in e.ingest(s, context: ctx) {
            switch ev {
            case .candidate(let f): run.candidates.append(f)
            case .tap(let tap): run.taps.append((tap, s.t))
            case .gesture(let g): run.gestures.append((g, s.t))
            case .rejected(let t, let r): run.rejected.append((t, r))
            }
        }
        // The first placement happens on the first gravity tick (10 ms); count it as the start, not as a switch.
        if placedAt == nil { if e.modelSet?.isPlaced == true { placedAt = s.t; timeline.append((s.t, e.activePosture ?? "")) } }
        else if let p = e.activePosture, p != timeline.last?.1 { timeline.append((s.t, p)) }
    }
    return (run, timeline)
}

func posture(at t: Double, _ timeline: [(Double, String)]) -> String? {
    timeline.last { $0.0 <= t }?.1 ?? timeline.first?.1
}

#endif
