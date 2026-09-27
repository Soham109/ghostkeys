// Helpers for PostureTests (Foundation lives here: test files that import Testing avoid it).

import Foundation
@testable import GhostkeysDetection

/// Encodes a value to JSON, removes the given top-level keys, and decodes it again: a file saved by an older build.
func withoutKeys<T: Codable>(_ v: T, _ keys: [String]) throws -> T {
    var obj = try JSONSerialization.jsonObject(with: JSONEncoder().encode(v)) as! [String: Any]
    for k in keys { obj.removeValue(forKey: k) }
    return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: obj))
}

/// Top-level keys of a value's JSON encoding.
func jsonKeys<T: Encodable>(_ v: T) throws -> Set<String> {
    Set((try JSONSerialization.jsonObject(with: JSONEncoder().encode(v)) as! [String: Any]).keys)
}

func decodeJSON<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

/// "Up" as the accelerometer reads it at rest (StreamBuilder.restGravity), rolled by `degrees` about the front-back axis.
func rolledGravity(_ degrees: Double) -> SIMD3<Double> {
    let r = degrees * .pi / 180
    let g = StreamBuilder.restGravity / (StreamBuilder.restGravity * StreamBuilder.restGravity).sum().squareRoot()
    // Rotation about the y axis (front-back), as StreamBuilder.addRoll does.
    return SIMD3(g.x * cos(r) + g.z * sin(r), g.y, -g.x * sin(r) + g.z * cos(r))
}

/// Synthetic feature vectors for three zones "a", "b", "c" (spread 1, centres 8 apart). `shift` moves every vector
/// along features 20...25, as a different posture would.
func postureBlobs(perZone: Int, seed: UInt64, shift: Double = 0, zones: [String] = ["a", "b", "c"],
                  gravity: SIMD3<Double>? = nil) -> [(TapFeatures, String)] {
    var rng = Rng(seed)
    var out: [(TapFeatures, String)] = []
    for (zi, name) in ["a", "b", "c"].enumerated() where zones.contains(name) {
        for _ in 0..<perZone {
            let v = (0..<TapFeatures.count).map { j in (j % 3 == zi && j < 18 ? 8.0 : 0.0) + (j >= 20 && j <= 25 ? shift : 0) + rng.gaussian() }
            out.append((TapFeatures(values: v, t: 0, gravity: gravity), name))
        }
    }
    return out
}

func trainBlobs(_ xs: [(TapFeatures, String)]) -> ZoneModel {
    let t = Trainer()
    for (f, l) in xs { t.add(f, label: l) }
    return t.train().0
}
