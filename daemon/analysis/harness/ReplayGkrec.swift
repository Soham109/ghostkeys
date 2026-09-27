// Replays a .gkrec through TapEngine with a saved model + config. Usage:
//   Replay <rec.gkrec> <zone-model.json> <config.json> [--lighttouch 0|1]
import Foundation
import GhostkeysDetection

let args = CommandLine.arguments
let rec = try! Data(contentsOf: URL(fileURLWithPath: args[1]))
let hlen = Int(rec.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 8, as: UInt32.self) })
let header = try! JSONSerialization.jsonObject(with: rec.subdata(in: 12..<(12 + hlen))) as! [String: Any]
var off = 12 + hlen
var cols: [String: [Float]] = [:]
for a in header["arrays"] as! [[String: Any]] {
    let n = a["count"] as! Int
    cols[a["name"] as! String] = rec.subdata(in: off..<(off + 4 * n)).withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    off += 4 * n
}
var model = try! JSONDecoder().decode(ZoneModel.self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
let config = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: args[3]))) as! [String: Any]
let settingsJSON = try! JSONSerialization.data(withJSONObject: config["settings"]!)
var settings = try! JSONDecoder().decode(DetectionSettings.self, from: settingsJSON)
ReplayHooks.configure(&settings, args)
let engine = TapEngine(settings: settings)
engine.model = model
var multi = Set<String>()
for b in config["bindings"] as! [[String: Any]] where ["double", "triple", "rhythm", "sequence"].contains(b["gesture"] as! String) {
    if let z = b["zone"] as? String { multi.insert(z) }
}
engine.zonesNeedingMultiTap = multi
let t = cols["imu.t"]!, at = cols["act.t"]!, sk = cols["act.sinceKey"]!, sm = cols["act.sinceMouse"]!
var j = 0
for i in 0..<t.count {
    let ti = Double(t[i])
    while j + 1 < at.count && Double(at[j + 1]) <= ti { j += 1 }
    let dt = at.isEmpty ? 0 : max(0, ti - Double(at[j]))
    let ctx = InputContext(secondsSinceKey: at.isEmpty ? 99 : Double(sk[j]) + dt, secondsSinceMouse: at.isEmpty ? 99 : Double(sm[j]) + dt)
    let s = IMUSample(t: ti, a: SIMD3(Double(cols["imu.ax"]![i]), Double(cols["imu.ay"]![i]), Double(cols["imu.az"]![i])),
                      g: SIMD3(Double(cols["imu.gx"]![i]), Double(cols["imu.gy"]![i]), Double(cols["imu.gz"]![i])))
    for e in engine.ingest(s, context: ctx) {
        switch e {
        case .candidate(let f):
            let r = model.classify(f)
            print(String(format: "%.3f candidate peak %.1f mg width %.0f ms -> %@ %.2f  (thr %.1f mg, key %.2fs ago, mouse %.2fs ago)", f.t, pow(10, f.values[26]), f.values[25], r.zone, r.confidence, engine.onsetThreshold * 1000, ctx.secondsSinceKey, ctx.secondsSinceMouse))
        case .rejected(let tt, let why): print(String(format: "%.3f rejected %@", tt, "\(why)"))
        case .tap(let tp): print(String(format: "%.3f TAP %@ %.2f", tp.t, tp.zone, tp.confidence))
        case .gesture(let g): print(String(format: "%.3f GESTURE %@ %@", g.t, g.gesture, g.zone ?? "-"))
        }
    }
}
