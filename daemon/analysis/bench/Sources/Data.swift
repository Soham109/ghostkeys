// Loaders for the real data the benchmark replays. Everything here is read-only.
//
//   <data>/calib1, calib_bak, calib2     samples.json (+ zone-model.json) copied from the daemon's model folder
//   <data>/session1.gkrec                 lab recording, laptop on a lap, 3 zones (ghostkeys-lab record)
//   <data>/regress1/missed-*.gkrec        the daemon's two feedback_missed diagnostics
//   Tests/GhostkeysDetectionTests/RestRecording.swift   12 s of the machine resting on a desk (base64 in source)

import Foundation
import GhostkeysDetection

struct LabeledSample: Decodable {
    var label: String
    var features: TapFeatures
}

struct CalibrationSet {
    var name: String
    var samples: [LabeledSample]
    /// The model the daemon saved with these samples (as trained by the build of that day), if present.
    var savedModel: ZoneModel?

    var labels: [String] { samples.map(\.label) }
    var zones: [String] { Array(Set(labels).subtracting([ZoneModel.noneLabel])).sorted() }
}

func loadCalibration(_ dir: String, name: String) -> CalibrationSet? {
    let fm = FileManager.default
    let s = dir + "/samples.json"
    guard fm.fileExists(atPath: s), let data = fm.contents(atPath: s),
          let samples = try? JSONDecoder().decode([LabeledSample].self, from: data) else { return nil }
    var model: ZoneModel?
    if let m = fm.contents(atPath: dir + "/zone-model.json") { model = try? JSONDecoder().decode(ZoneModel.self, from: m) }
    return CalibrationSet(name: name, samples: samples, savedModel: model)
}

/// A capture segment of a lab recording: taps of one zone between start and end.
struct Segment: Decodable {
    var phase: String
    var zone: String?
    var start: Double
    var end: Double
    var onsets: [Double]
    var discarded: Bool?
}

struct Recording {
    var name: String
    var t: [Double] = []
    var a: [SIMD3<Double>] = []
    var g: [SIMD3<Double>] = []
    // Activity poll (about 100 Hz): seconds since the last key / pointer event at time actT.
    var actT: [Double] = []
    var sinceKey: [Double] = []
    var sinceMouse: [Double] = []
    var segments: [Segment] = []
    var notes: [String] = []
    /// Time ranges with no intended taps, where every accepted tap is false (nil: unknown).
    var handling: [(Double, Double)]?

    var duration: Double { (t.last ?? 0) - (t.first ?? 0) }
    var captures: [Segment] { segments.filter { $0.phase == "capture" && $0.discarded != true } }

    /// Replays the recording through `body` with the input context interpolated from the activity poll.
    /// `extraKeys` / `extraMouse` are synthetic key-down / pointer event times merged into the real activity.
    func forEach(extraKeys: [Double] = [], extraMouse: [Double] = [], _ body: (IMUSample, InputContext) -> Void) {
        var ai = -1, ki = -1, mi = -1
        for i in 0..<t.count {
            let ti = t[i]
            while ai + 1 < actT.count && actT[ai + 1] <= ti { ai += 1 }
            while ki + 1 < extraKeys.count && extraKeys[ki + 1] <= ti { ki += 1 }
            while mi + 1 < extraMouse.count && extraMouse[mi + 1] <= ti { mi += 1 }
            var sk = 99.0, sm = 99.0
            if ai >= 0 { let dt = ti - actT[ai]; sk = sinceKey[ai] + dt; sm = sinceMouse[ai] + dt }
            if ki >= 0 { sk = min(sk, ti - extraKeys[ki]) }
            if mi >= 0 { sm = min(sm, ti - extraMouse[mi]) }
            body(IMUSample(t: ti, a: a[i], g: g[i]), InputContext(secondsSinceKey: sk, secondsSinceMouse: sm))
        }
    }
}

func loadGkrec(_ path: String) -> Recording? {
    guard let data = FileManager.default.contents(atPath: path), data.count > 12,
          Array(data.prefix(5)) == Array("GKREC".utf8) else { return nil }
    let len = Int(data[8]) | Int(data[9]) << 8 | Int(data[10]) << 16 | Int(data[11]) << 24
    guard data.count >= 12 + len,
          let header = try? JSONSerialization.jsonObject(with: data.subdata(in: 12..<(12 + len))) as? [String: Any],
          let arrays = header["arrays"] as? [[String: Any]] else { return nil }
    var off = 12 + len
    var cols: [String: [Double]] = [:]
    for a in arrays {
        guard let n = a["count"] as? Int, let name = a["name"] as? String, off + 4 * n <= data.count else { return nil }
        cols[name] = data.subdata(in: off..<(off + 4 * n)).withUnsafeBytes { raw in
            raw.bindMemory(to: Float.self).map { Double($0) }
        }
        off += 4 * n
    }
    var r = Recording(name: (path as NSString).lastPathComponent)
    guard let t = cols["imu.t"], let ax = cols["imu.ax"], let ay = cols["imu.ay"], let az = cols["imu.az"],
          let gx = cols["imu.gx"], let gy = cols["imu.gy"], let gz = cols["imu.gz"] else { return nil }
    r.t = t
    r.a = (0..<t.count).map { SIMD3(ax[$0], ay[$0], az[$0]) }
    r.g = (0..<t.count).map { SIMD3(gx[$0], gy[$0], gz[$0]) }
    r.actT = cols["act.t"] ?? []
    r.sinceKey = cols["act.sinceKey"] ?? []
    r.sinceMouse = cols["act.sinceMouse"] ?? []
    if let segs = header["segments"], let d = try? JSONSerialization.data(withJSONObject: segs) {
        r.segments = (try? JSONDecoder().decode([Segment].self, from: d)) ?? []
    }
    r.notes = header["notes"] as? [String] ?? []
    if r.name == "session1.gkrec" { r.handling = session1Handling }
    return r
}

/// The 12 s desk rest recording compiled into the detection tests (6 little-endian Int32 per sample, / 65536).
func loadRestRecording(testsDir: String) -> Recording? {
    guard let text = try? String(contentsOfFile: testsDir + "/RestRecording.swift", encoding: .utf8) else { return nil }
    let parts = text.components(separatedBy: "\"\"\"")
    guard parts.count >= 3, let data = Data(base64Encoded: parts[1], options: .ignoreUnknownCharacters) else { return nil }
    var r = Recording(name: "rest (desk, 12 s)")
    data.withUnsafeBytes { raw in
        let p = raw.bindMemory(to: Int32.self)
        for i in 0..<(p.count / 6) {
            let v = (0..<6).map { Double(Int32(littleEndian: p[i * 6 + $0])) / 65536 }
            r.t.append(Double(i) / 797)
            r.a.append(SIMD3(v[0], v[1], v[2]))
            r.g.append(SIMD3(v[3], v[4], v[5]))
        }
    }
    return r
}

/// session1's stretches without intended taps, read off the recording (spike timeline, gravity, key and pointer
/// events; analysis/bench/README in the audit): 0 to 11 s settling, 15.3 to 17.2 s, 28 to 47.5 s repositioning
/// the machine on the lap (12 to 41 degree tilts) plus four keystrokes, 74 to 75.2 s. Left out on purpose:
/// 11.0 to 15.3 s holds a run of real, unlabelled practice taps (0.5 s apart, 170 to 250 mg), and 47.5 to 48.5 s
/// may hold a practice tap right before the right-palm phase.
let session1Handling: [(Double, Double)] = [(0.5, 11.0), (15.3, 17.2), (28.0, 47.5), (74.0, 75.2)]
