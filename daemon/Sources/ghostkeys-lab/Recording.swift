// The .gkrec file format.
//
//   bytes 0..7   magic "GKREC\0\0\u{1}"
//   bytes 8..11  UInt32 little-endian: length H of the header
//   next H bytes UTF-8 JSON header (RecordingHeader)
//   then, in the order listed in header.arrays, `count` little-endian Float32 values per array.
//
// All times are seconds relative to the session start (the first IMU sample), so Float32 keeps ~60 us resolution
// for sessions up to ~17 minutes.

import Foundation
import GhostkeysDetection

struct Segment: Codable {
    var phase: String          // "capture" | "negatives" | "rest"
    var zone: String?          // capture only
    var start: Double
    var end: Double
    var onsets: [Double]       // tap onsets found by the lab's onset detector (or the true times for synth)
    var discarded: Bool = false
    var endedBy: String?       // "count" | "timeout" | "key" | "time" | "interrupt"
}

struct ArrayInfo: Codable {
    var name: String
    var count: Int
}

struct RecordingHeader: Codable {
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
    var segments: [Segment]
    var arrays: [ArrayInfo]
    var notes: [String] = []
}

struct Recording {
    var header: RecordingHeader
    // IMU columns (same length)
    var t: [Float] = [], ax: [Float] = [], ay: [Float] = [], az: [Float] = []
    var gx: [Float] = [], gy: [Float] = [], gz: [Float] = []
    // Activity columns (100 Hz poll)
    var actT: [Float] = [], sinceKey: [Float] = [], sinceMouse: [Float] = [], flags: [Float] = []

    static let magic: [UInt8] = Array("GKREC".utf8) + [0, 0, 1]

    var imuCount: Int { t.count }
    var activityCount: Int { actT.count }
    var duration: Double { Double(t.last ?? 0) }

    private var columns: [(String, [Float])] {
        [("imu.t", t), ("imu.ax", ax), ("imu.ay", ay), ("imu.az", az), ("imu.gx", gx), ("imu.gy", gy), ("imu.gz", gz),
         ("act.t", actT), ("act.sinceKey", sinceKey), ("act.sinceMouse", sinceMouse), ("act.flags", flags)]
    }

    func write(to path: String) throws {
        var h = header
        h.arrays = columns.map { ArrayInfo(name: $0.0, count: $0.1.count) }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        let json = try enc.encode(h)
        var data = Data(Self.magic)
        var len = UInt32(json.count).littleEndian
        withUnsafeBytes(of: &len) { data.append(contentsOf: $0) }
        data.append(json)
        for (_, col) in columns {
            col.withUnsafeBufferPointer { buf in
                // Apple silicon is little-endian; Float32 bit patterns are written as-is.
                data.append(UnsafeBufferPointer(start: UnsafeRawPointer(buf.baseAddress!).assumingMemoryBound(to: UInt8.self),
                                                count: buf.count * 4))
            }
        }
        try data.write(to: URL(fileURLWithPath: path))
    }

    static func read(from path: String) throws -> Recording {
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard data.count >= 12, Array(data.prefix(8)) == magic else { throw LabError("\(path): not a .gkrec file") }
        let len = Int(data[8]) | Int(data[9]) << 8 | Int(data[10]) << 16 | Int(data[11]) << 24
        guard data.count >= 12 + len else { throw LabError("\(path): truncated header") }
        let header = try JSONDecoder().decode(RecordingHeader.self, from: data.subdata(in: 12..<(12 + len)))
        var rec = Recording(header: header)
        var off = 12 + len
        var cols: [String: [Float]] = [:]
        for a in header.arrays {
            let bytes = a.count * 4
            guard off + bytes <= data.count else { throw LabError("\(path): truncated array \(a.name)") }
            var arr = [Float](repeating: 0, count: a.count)
            arr.withUnsafeMutableBytes { dst in
                data.copyBytes(to: dst.bindMemory(to: UInt8.self), from: off..<(off + bytes))
            }
            cols[a.name] = arr
            off += bytes
        }
        rec.t = cols["imu.t"] ?? []; rec.ax = cols["imu.ax"] ?? []; rec.ay = cols["imu.ay"] ?? []; rec.az = cols["imu.az"] ?? []
        rec.gx = cols["imu.gx"] ?? []; rec.gy = cols["imu.gy"] ?? []; rec.gz = cols["imu.gz"] ?? []
        rec.actT = cols["act.t"] ?? []; rec.sinceKey = cols["act.sinceKey"] ?? []
        rec.sinceMouse = cols["act.sinceMouse"] ?? []; rec.flags = cols["act.flags"] ?? []
        let n = rec.t.count
        guard [rec.ax, rec.ay, rec.az, rec.gx, rec.gy, rec.gz].allSatisfy({ $0.count == n }) else {
            throw LabError("\(path): IMU arrays have different lengths")
        }
        return rec
    }

    mutating func append(_ s: RawSample, t0: Double) {
        t.append(Float(s.t - t0))
        ax.append(s.a.x); ay.append(s.a.y); az.append(s.a.z)
        gx.append(s.g.x); gy.append(s.g.y); gz.append(s.g.z)
    }

    mutating func append(_ r: ActivityReading, t0: Double) {
        actT.append(Float(r.t - t0))
        sinceKey.append(Float(min(r.sinceKey, 1e7)))
        sinceMouse.append(Float(min(r.sinceMouse, 1e7)))
        flags.append(Float(r.flags))
    }

    /// Iterates IMU samples with the input context interpolated from the activity poll
    /// (seconds-since values grow linearly between polls).
    func forEachSample(_ body: (Int, IMUSample, InputContext) -> Void) {
        var ai = -1
        for i in 0..<t.count {
            let ti = Double(t[i])
            while ai + 1 < actT.count && Double(actT[ai + 1]) <= ti { ai += 1 }
            var ctx = InputContext()
            if ai >= 0 {
                let dt = ti - Double(actT[ai])
                ctx = InputContext(secondsSinceKey: Double(sinceKey[ai]) + dt, secondsSinceMouse: Double(sinceMouse[ai]) + dt,
                                   modifiers: Activity.modifiers(UInt32(flags[ai])))
            }
            body(i, IMUSample(t: ti, a: SIMD3(Double(ax[i]), Double(ay[i]), Double(az[i])),
                                  g: SIMD3(Double(gx[i]), Double(gy[i]), Double(gz[i]))), ctx)
        }
    }

    /// Segment containing time t (non-discarded only).
    func segment(at time: Double) -> Segment? {
        header.segments.first { !$0.discarded && time >= $0.start && time <= $0.end }
    }
}


func deviceModel() -> String {
    var size = 0
    sysctlbyname("hw.model", nil, &size, nil, 0)
    guard size > 0 else { return "unknown" }
    var buf = [CChar](repeating: 0, count: size)
    sysctlbyname("hw.model", &buf, &size, nil, 0)
    return String(cString: buf)
}

func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
