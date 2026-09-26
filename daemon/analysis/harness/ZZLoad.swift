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
