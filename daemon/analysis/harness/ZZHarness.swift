import Testing
@testable import GhostkeysDetection

/// Temporary: cross-validated live-path simulation on real calibration samples.
@Test func zzLivePath() {
    let env = zzEnv()
    var s = zzLoadSamples(env["ZZ_SAMPLES"] ?? "/Users/sohamaggarwal/Desktop/Projects/ghostkeys/daemon/analysis/data/calib1/samples.json")
    let drop = Set((env["ZZ_DROP"] ?? "").split(separator: ",").map(String.init))
    s = s.filter { !drop.contains($0.label) }
    let reps = Int(env["ZZ_REPS"] ?? "10")!
    print("ZZ rep\tlabel\tpred\tconf\tdist\treject\tood")
    for rep in 0..<reps {
        var rng = SplitMix64(seed: UInt64(rep + 1))
        var fold = [Int](repeating: 0, count: s.count)
        for l in Set(s.map(\.label)).sorted() {
            var idx = s.indices.filter { s[$0].label == l }
            idx.shuffle(using: &rng)
            for (r, i) in idx.enumerated() { fold[i] = r % 5 }
        }
        for f in 0..<5 {
            let tr = s.indices.filter { fold[$0] != f }
            let m = ZoneModel.fit(features: tr.map { s[$0].features.values }, labels: tr.map { s[$0].label }, options: env["ZZ_AUG"] == "1" ? .init(augment: [1.4, 2.0]) : .init())
            for i in s.indices where fold[i] == f {
                let r = m.classifyDetailed(s[i].features)
                print("ZZ \(rep)\t\(s[i].label)\t\(r.zone)\t\(r.confidence)\t\(r.distance)\t\(m.rejectDistance)\t\(r.outOfDistribution)")
            }
        }
    }
}

@Test func zzRecommend() {
    let s = zzLoadSamples("/Users/sohamaggarwal/Desktop/Projects/ghostkeys/daemon/analysis/data/calib1/samples.json")
    let t = Trainer()
    for x in s { t.add(x.features, label: x.label) }
    let (_, report) = t.train()
    print("ZR report", report.accuracy.sorted { $0.key < $1.key }.map { "\($0.key)=\(String(format: "%.2f", $0.value))" }.joined(separator: " "), "overall", report.overall)
    let r1 = recommendedZones(report)
    print("ZR from-report keep", r1.keep, "drop", r1.drop, "merge", r1.merge)
    let r2 = t.recommendedZones()
    print("ZR iterative keep", r2.keep, "drop", r2.drop.keys.sorted(), "expected", r2.expectedAccuracy.sorted { $0.key < $1.key }.map { "\($0.key)=\(String(format: "%.2f", $0.value))" })
}
