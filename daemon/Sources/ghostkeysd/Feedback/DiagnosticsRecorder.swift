import Foundation
import GhostkeysDetection

/// Rolling in-memory record of the last 10 s: raw IMU samples with their key/mouse context, and what the detector
/// did (candidates, taps, rejections). Never written to disk unless the app asks (`diagnostics_export`,
/// `feedback_missed`). Used only on the daemon's core queue.
final class DiagnosticsRecorder {
    struct Sample {
        var t: Double
        var a: SIMD3<Double>, g: SIMD3<Double>
        var sinceKey: Double, sinceMouse: Double
        var flags: UInt32
    }

    struct Event {
        var t: Double
        var text: String
    }

    static let seconds = 10.0
    private var ring: [Sample]
    private var head = 0          // next write index
    private var filled = 0
    private var events: [Event] = []

    init(capacity: Int = 9_000) {          // 10 s at ~800 Hz, with headroom
        ring = Array(repeating: Sample(t: 0, a: .zero, g: .zero, sinceKey: 99, sinceMouse: 99, flags: 0), count: capacity)
    }

    func record(_ s: IMUSample, sinceKey: Double, sinceMouse: Double, modifiers: Set<String>) {
        ring[head] = Sample(t: s.t, a: s.a, g: s.g, sinceKey: sinceKey, sinceMouse: sinceMouse, flags: Self.flags(modifiers))
        head = (head + 1) % ring.count
        filled = min(filled + 1, ring.count)
    }

    func note(_ t: Double, _ text: String) {
        events.append(Event(t: t, text: text))
        if let first = events.first, t - first.t > Self.seconds { events.removeAll { t - $0.t > Self.seconds } }
    }

    /// Samples of the last `seconds`, oldest first.
    func samples(lastSeconds seconds: Double = DiagnosticsRecorder.seconds) -> [Sample] {
        guard filled > 0 else { return [] }
        let start = (head - filled + ring.count) % ring.count
        var out: [Sample] = []
        out.reserveCapacity(filled)
        for i in 0..<filled { out.append(ring[(start + i) % ring.count]) }
        guard let last = out.last?.t else { return [] }
        return out.filter { last - $0.t <= seconds }
    }

    /// Test hook (simulated sessions only): adds a tap-like transient to the buffered samples `ago` seconds back,
    /// so the offline analysis has something to find without anyone touching the laptop.
    func injectSyntheticTap(ago: Double = 0.5) {
        guard filled > 0 else { return }
        let lastT = ring[(head - 1 + ring.count) % ring.count].t
        let onset = lastT - ago
        for i in 0..<filled {
            let idx = (head - 1 - i + ring.count) % ring.count
            let dt = ring[idx].t - onset
            guard dt >= 0, dt < 0.06 else { continue }
            // Decaying 180 Hz ring, 0.25 g peak on z and a little on x, plus a small gyro kick.
            let v = 0.25 * exp(-dt / 0.008) * sin(2 * .pi * 180 * dt)
            ring[idx].a += SIMD3(0.3 * v, 0.1 * v, v)
            ring[idx].g += SIMD3(20 * v, -10 * v, 5 * v)
        }
    }

    // MARK: Offline analysis

    struct Found {
        var t: Double
        var features: TapFeatures
        var zone: String
        var confidence: Double
    }

    /// Re-runs detection on the buffered samples with the input gates bypassed and returns the candidates in the last
    /// `window` seconds (the whole 10 s buffer is replayed first so the adaptive noise floor has settled).
    func offlineCandidates(settings: DetectionSettings, model: ZoneModel?, window: Double) -> [Found] {
        let all = samples()
        guard let lastT = all.last?.t else { return [] }
        let engine = TapEngine(settings: settings)
        engine.bypassInputGates = true
        engine.tiltEnabled = false
        var found: [Found] = []
        for s in all {
            let ctx = InputContext(secondsSinceKey: s.sinceKey, secondsSinceMouse: s.sinceMouse, lidAngle: nil, paused: false)
            for e in engine.ingest(IMUSample(t: s.t, a: s.a, g: s.g), context: ctx) {
                guard case .candidate(let f) = e, lastT - f.t <= window else { continue }
                let r = model?.classify(f) ?? (zone: "none", confidence: 0, x: 0.5, y: 0.5)
                found.append(Found(t: f.t, features: f, zone: r.zone, confidence: r.confidence))
            }
        }
        return found
    }

    // MARK: Export (ghostkeys-lab .gkrec format, see ghostkeys-lab/Recording.swift)

    /// Writes the last `seconds` to `url` in the lab's .gkrec format, so `ghostkeys-lab replay` can re-run it.
    /// `segments` label parts of it (for a missed tap: one "capture" segment with the zone and the found onset).
    func export(to url: URL, seconds: Double, deviceModel: String, zones: [String],
                segments: [GkrecSegment] = [], notes extra: [String] = []) throws -> Int {
        let s = samples(lastSeconds: seconds)
        guard let t0 = s.first?.t else { throw ActionError("no sensor data buffered yet") }
        var imu: [[Float]] = Array(repeating: [], count: 7)
        var act: [[Float]] = Array(repeating: [], count: 4)
        var lastAct = -1.0
        for x in s {
            let rt = Float(x.t - t0)
            imu[0].append(rt)
            imu[1].append(Float(x.a.x)); imu[2].append(Float(x.a.y)); imu[3].append(Float(x.a.z))
            imu[4].append(Float(x.g.x)); imu[5].append(Float(x.g.y)); imu[6].append(Float(x.g.z))
            // The lab polls activity at 100 Hz; keep the same rate.
            if x.t - lastAct >= 0.01 {
                lastAct = x.t
                act[0].append(rt)
                act[1].append(Float(min(x.sinceKey, 1e7))); act[2].append(Float(min(x.sinceMouse, 1e7)))
                act[3].append(Float(x.flags))
            }
        }
        let names = ["imu.t", "imu.ax", "imu.ay", "imu.az", "imu.gx", "imu.gy", "imu.gz",
                     "act.t", "act.sinceKey", "act.sinceMouse", "act.flags"]
        let columns = imu + act
        let rel = segments.map { seg in
            GkrecSegment(phase: seg.phase, zone: seg.zone, start: max(0, seg.start - t0), end: max(0, seg.end - t0),
                         onsets: seg.onsets.map { $0 - t0 }, discarded: false, endedBy: seg.endedBy)
        }
        let eventNotes = events.filter { $0.t >= t0 }.map { String(format: "t=%.4f ", $0.t - t0) + $0.text }
        let duration = (s.last?.t ?? t0) - t0
        let header = GkrecHeader(created: ISO8601DateFormatter().string(from: Date()), synthetic: false, partial: false,
                                 deviceModel: deviceModel, imuHz: duration > 0 ? Double(s.count - 1) / duration : 0,
                                 zones: zones, reps: 0, tapIntervalSeconds: 0, segments: rel,
                                 arrays: zip(names, columns).map { GkrecArray(name: $0, count: $1.count) },
                                 notes: ["exported by ghostkeysd diagnostics"] + extra + eventNotes)
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let json = try enc.encode(header)
        var data = Data(Array("GKREC".utf8) + [0, 0, 1])
        var len = UInt32(json.count).littleEndian
        withUnsafeBytes(of: &len) { data.append(contentsOf: $0) }
        data.append(json)
        for col in columns { col.withUnsafeBufferPointer { data.append(Data(buffer: $0)) } }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: .atomic)
        return s.count
    }

    /// Keeps the newest `keep` files in a diagnostics folder.
    static func prune(_ dir: URL, keep: Int = 50) {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.contentModificationDateKey])
            .filter({ $0.pathExtension == "gkrec" }), files.count > keep else { return }
        let sorted = files.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a > b
        }
        for f in sorted.dropFirst(keep) { try? fm.removeItem(at: f) }
    }

    static func flags(_ m: Set<String>) -> UInt32 {
        var f: UInt32 = 0
        if m.contains("shift") { f |= 0x20000 }
        if m.contains("control") { f |= 0x40000 }
        if m.contains("option") { f |= 0x80000 }
        if m.contains("command") { f |= 0x100000 }
        if m.contains("fn") { f |= 0x800000 }
        return f
    }
}

// Mirrors of ghostkeys-lab's RecordingHeader / Segment / ArrayInfo. Every key is always written, because the lab's
// synthesized decoder requires keys even for properties that have a default value.
struct GkrecSegment: Codable {
    var phase: String
    var zone: String?
    var start: Double
    var end: Double
    var onsets: [Double]
    var discarded: Bool
    var endedBy: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(phase, forKey: .phase); try c.encode(zone, forKey: .zone)
        try c.encode(start, forKey: .start); try c.encode(end, forKey: .end); try c.encode(onsets, forKey: .onsets)
        try c.encode(discarded, forKey: .discarded); try c.encode(endedBy, forKey: .endedBy)
    }
}

struct GkrecArray: Codable { var name: String; var count: Int }

struct GkrecHeader: Codable {
    var format = "gkrec"
    var version = 1
    var created: String
    var synthetic: Bool
    var partial: Bool
    var deviceModel: String
    var imuHz: Double
    var zones: [String]
    var reps: Int
    var tapIntervalSeconds: Double
    var segments: [GkrecSegment]
    var arrays: [GkrecArray]
    var notes: [String]
}
