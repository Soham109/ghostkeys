import Foundation
@testable import GhostkeysDetection
struct ZZSample: Decodable { var label: String; var features: TapFeatures }
func zzLoadSamples(_ path: String) -> [ZZSample] {
    try! JSONDecoder().decode([ZZSample].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
}
func zzEnv() -> [String: String] { ProcessInfo.processInfo.environment }
extension Trainer {
    static func fitModel(features: [[Double]], labels: [String]) -> ZoneModel { ZoneModel.fit(features: features, labels: labels) }
}

/// Session CSV export (ghostkeys-lab export --csv): IMU samples and labeled onsets.
func zzLoadIMU(_ path: String) -> [IMUSample] {
    let text = try! String(contentsOfFile: path, encoding: .utf8)
    var out: [IMUSample] = []
    for line in text.split(separator: "\n").dropFirst() {
        let c = line.split(separator: ",", omittingEmptySubsequences: false)
        let v = c.prefix(7).map { Double($0)! }
        out.append(IMUSample(t: v[0], a: [v[1], v[2], v[3]], g: [v[4], v[5], v[6]]))
    }
    return out
}
func zzLoadOnsets(_ path: String) -> [(t: Double, zone: String)] {
    let text = try! String(contentsOfFile: path, encoding: .utf8)
    return text.split(separator: "\n").dropFirst().map { l in
        let c = l.split(separator: ","); return (Double(c[0])!, String(c[2]))
    }
}
