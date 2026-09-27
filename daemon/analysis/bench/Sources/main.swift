// Ghostkeys detection benchmark on the user's real data. See ../run.sh for usage.

import Foundation
import GhostkeysDetection

var args = Array(CommandLine.arguments.dropFirst())
func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}
let dataDir = option("data") ?? "data"
let testsDir = option("tests") ?? "Tests/GhostkeysDetectionTests"
let reps = Int(option("reps") ?? "10") ?? 10
let outPath = option("out")
let comparePath = option("compare")
let label = option("label") ?? "this build"

var settings = DetectionSettings()
if let json = option("settings") {
    // Tolerant decoding: unknown keys are ignored, missing keys keep their defaults.
    guard let s = try? JSONDecoder().decode(DetectionSettings.self, from: Data(json.utf8)) else {
        FileHandle.standardError.write("bad --settings JSON\n".data(using: .utf8)!); exit(2)
    }
    settings = s
}

let sets = ["calib1", "calib_bak", "calib2"].compactMap { loadCalibration("\(dataDir)/\($0)", name: $0) }
let session1 = loadGkrec("\(dataDir)/session1.gkrec")
// feedback_missed / diagnostics_export recordings, deduplicated by file name.
var diagPaths: [String: String] = [:]
for dir in ["regress1", "diagnostics"] {
    for f in (try? FileManager.default.contentsOfDirectory(atPath: "\(dataDir)/\(dir)")) ?? [] where f.hasSuffix(".gkrec") {
        diagPaths[f] = diagPaths[f] ?? "\(dataDir)/\(dir)/\(f)"
    }
}
let diags = diagPaths.keys.sorted().compactMap { loadGkrec(diagPaths[$0]!) }
let rest = loadRestRecording(testsDir: testsDir)

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
log("data: \(sets.map { "\($0.name) (\($0.samples.count))" }.joined(separator: ", ")); session1 \(session1 != nil ? "yes" : "MISSING"); diagnostics \(diags.count); rest \(rest != nil ? "yes" : "MISSING")")
if sets.isEmpty || session1 == nil { log("missing data: run fetch-data.sh first (see run.sh)"); exit(2) }

let report = Report()
let clock = Date()
log("cv..."); suiteCV(sets, settings: settings, reps: reps, report: report)
log("cross-session..."); suiteCross(sets, settings: settings, report: report)
suiteCross(sets, settings: settings, saved: true, report: report)
if let s1 = session1 {
    log("session1..."); suiteSession1(s1, settings: settings, reps: max(1, reps / 2), report: report)
    log("session1 x other calibrations..."); suiteSession1Cross(s1, sets: sets, settings: settings, saved: false, report: report)
    suiteSession1Cross(s1, sets: sets, settings: settings, saved: true, report: report)
}
if let s1 = session1 { log("robustness..."); suiteRobustness(s1, settings: settings, report: report) }
if let s1 = session1, let rest { log("spliced doubles..."); suiteSplice(s1, rest: rest, settings: settings, report: report) }
log("rest + diagnostics..."); suiteRest(rest, diags: diags, sets: sets, settings: settings, report: report)
log(String(format: "done in %.1f s", Date().timeIntervalSince(clock)))

// MARK: Output

struct Saved: Codable { var label: String; var metrics: [Metric] }
if let outPath {
    let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    try? enc.encode(Saved(label: label, metrics: report.metrics)).write(to: URL(fileURLWithPath: outPath))
}

func fmt(_ v: Double) -> String { v.isNaN ? "n/a" : String(format: "%.3f", v) }
func pad(_ s: String, _ n: Int, left: Bool = false) -> String {
    s.count >= n ? s : (left ? String(repeating: " ", count: n - s.count) + s : s + String(repeating: " ", count: n - s.count))
}

var before: [String: Double] = [:]
var beforeLabel = ""
if let comparePath, let d = FileManager.default.contents(atPath: comparePath), let b = try? JSONDecoder().decode(Saved.self, from: d) {
    beforeLabel = b.label
    for m in b.metrics { before[m.key] = m.value }
}

var wins = 0, losses = 0
var lossKeys: [String] = []
print(pad("metric", 36) + (before.isEmpty ? "" : pad(beforeLabel, 12, left: true)) + pad(label, 12, left: true) + (before.isEmpty ? "" : "  verdict") + "   better")
for m in report.metrics {
    var line = pad(m.key, 36)
    var verdict = ""
    if !before.isEmpty {
        let b = before[m.key] ?? .nan
        line += pad(fmt(b), 12, left: true)
        if !b.isNaN && !m.value.isNaN && m.better != .info {
            let d = m.value - b
            let tol = 0.0005
            if abs(d) <= tol { verdict = "  =" }
            else if (d > 0) == (m.better == .up) { verdict = "  WIN"; wins += 1 }
            else { verdict = "  LOSS"; losses += 1; lossKeys.append(m.key) }
        }
    }
    line += pad(fmt(m.value), 12, left: true) + pad(verdict, 9) + "   " + (m.better == .info ? "info" : (m.better == .up ? "higher" : "lower"))
    print(line)
}
if !before.isEmpty {
    print("\n\(wins) better, \(losses) worse" + (lossKeys.isEmpty ? "" : ": " + lossKeys.joined(separator: ", ")))
}
