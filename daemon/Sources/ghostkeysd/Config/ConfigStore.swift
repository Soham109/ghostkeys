import Foundation
import GhostkeysDetection

/// Everything the daemon writes lives under ~/Library/Application Support/Ghostkeys/ (PROTOCOL.md safety rules).
final class ConfigStore {
    let directory: URL
    var configURL: URL { directory.appendingPathComponent("config.json") }
    var modelDirectory: URL { directory.appendingPathComponent("model", isDirectory: true) }
    var modelURL: URL { modelDirectory.appendingPathComponent("zone-model.json") }
    var reportURL: URL { modelDirectory.appendingPathComponent("calibration-report.json") }
    var samplesURL: URL { modelDirectory.appendingPathComponent("samples.json") }

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        directory = base.appendingPathComponent("Ghostkeys", isDirectory: true)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    /// Loads config.json, creating it from defaults if missing. A corrupt file is kept aside, not overwritten.
    func loadConfig() -> Config {
        guard let data = try? Data(contentsOf: configURL) else {
            let c = Config.defaults
            do { try save(c) } catch { Log.error("could not write default config: \(error)") }
            return c
        }
        do {
            return try JSONDecoder().decode(Config.self, from: data)
        } catch {
            Log.error("config.json unreadable (\(error)); using defaults, original kept as config.json.bad")
            let bad = directory.appendingPathComponent("config.json.bad")
            try? FileManager.default.removeItem(at: bad)
            try? FileManager.default.copyItem(at: configURL, to: bad)
            return Config.defaults
        }
    }

    func save(_ config: Config) throws {
        try write(Self.encoder.encode(config), to: configURL)
    }

    func loadModel() -> ZoneModel? {
        guard let data = try? Data(contentsOf: modelURL) else { return nil }
        do { return try JSONDecoder().decode(ZoneModel.self, from: data) } catch {
            Log.error("model unreadable: \(error)")
            return nil
        }
    }

    func saveModel(_ model: ZoneModel, report: CalibrationReport) throws {
        try write(Self.encoder.encode(model), to: modelURL)
        try write(Self.encoder.encode(report), to: reportURL)
    }

    struct LabeledSample: Codable { var label: String; var features: TapFeatures }

    /// Keeps the raw labeled calibration samples so a later version can retrain without asking the user again.
    func saveSamples(_ samples: [LabeledSample]) throws {
        try write(JSONEncoder().encode(samples), to: samplesURL)
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Keep the previous version one step back (SAFETY_AUDIT item 13).
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path), url.lastPathComponent != "samples.json" {
            let bak = url.appendingPathExtension("bak")
            try? fm.removeItem(at: bak)
            try? fm.copyItem(at: url, to: bak)
        }
        try data.write(to: url, options: .atomic)
    }
}
