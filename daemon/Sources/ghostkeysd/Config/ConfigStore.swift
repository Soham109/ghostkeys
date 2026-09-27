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

    init(directory: URL = ConfigStore.baseDirectory) {
        self.directory = directory
    }

    // MARK: Where the daemon's files live

    /// `~/Library/Application Support/Ghostkeys` (shared with the Electron app's own profile, so the daemon keeps its
    /// files one level down, in `daemon/`).
    static var legacyDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("Ghostkeys", isDirectory: true)
    }

    static var defaultDirectory: URL { legacyDirectory.appendingPathComponent("daemon", isDirectory: true) }

    /// Set once at startup (before anything reads it) from `--config-dir`, then `GHOSTKEYS_CONFIG_DIR`, else the default.
    nonisolated(unsafe) static var baseDirectory: URL = defaultDirectory
    nonisolated(unsafe) static var isDefaultDirectory = true

    static func configure(override: String?) {
        let env = ProcessInfo.processInfo.environment["GHOSTKEYS_CONFIG_DIR"]
        if let path = override ?? (env?.isEmpty == false ? env : nil) {
            baseDirectory = URL(fileURLWithPath: (path as NSString).expandingTildeInPath, isDirectory: true).standardizedFileURL
            isDefaultDirectory = false
        }
        try? FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
    }

    /// Exactly the entries the daemon owns. Nothing else in the old shared directory is touched.
    static let ownedNames = ["config.json", "config.json.bak", "config.json.bad", "token", "approved.json",
                             "spu-originals.json", "daemon.lock", "model"]

    /// One-time move of the daemon's own files from `~/Library/Application Support/Ghostkeys/` into `daemon/`
    /// (only for the default location). Refuses to run while an older daemon still holds the old lock.
    /// Returns a summary, or nil if there was nothing to move.
    @discardableResult
    static func migrateLegacyFiles() -> String? {
        guard isDefaultDirectory else { return nil }
        let fm = FileManager.default
        let old = legacyDirectory
        let present = ownedNames.filter { fm.fileExists(atPath: old.appendingPathComponent($0).path) }
        guard !present.isEmpty else { return nil }

        // An older ghostkeysd (or lab tool) may still be running with the old lock: do not move files under it.
        let oldLock = old.appendingPathComponent("daemon.lock").path
        if fm.fileExists(atPath: oldLock) {
            let fd = open(oldLock, O_RDWR | O_CLOEXEC)
            if fd >= 0 {
                defer { close(fd) }
                if flock(fd, LOCK_EX | LOCK_NB) != 0 {
                    Log.error("an older ghostkeysd holds \(oldLock); stop it before starting this version")
                    exit(4)
                }
                flock(fd, LOCK_UN)
            }
        }
        var moved: [String] = []
        for name in present {
            let src = old.appendingPathComponent(name), dst = baseDirectory.appendingPathComponent(name)
            if name == "daemon.lock" || name == "token" {
                try? fm.removeItem(at: src)        // recreated every launch; nothing to keep
                continue
            }
            guard !fm.fileExists(atPath: dst.path) else {
                Log.info("migration: kept \(src.path) (\(name) already exists in \(baseDirectory.path))")
                continue
            }
            do { try fm.moveItem(at: src, to: dst); moved.append(name) } catch {
                Log.error("migration: could not move \(name): \(error)")
            }
        }
        guard !moved.isEmpty else { return nil }
        let summary = "moved \(moved.joined(separator: ", ")) from \(old.path) to \(baseDirectory.path)"
        Log.info(summary)
        return summary
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()

    /// Loads config.json, creating it from the family's defaults if missing. An existing file is never replaced by
    /// defaults; a corrupt one is kept aside as config.json.bad and the defaults are used in memory only.
    func loadConfig(family: String) -> Config {
        guard let data = try? Data(contentsOf: configURL) else {
            let c = Config.defaults(family: family)
            Log.info("created a new config for \(family) (\(c.zones.count) zones)")
            // A config created by this version needs none of the migrations for older ones.
            try? JSONEncoder().encode(Self.allMigrations).write(to: migrationsURL, options: .atomic)
            do { try save(c) } catch { Log.error("could not write default config: \(error)") }
            return c
        }
        do {
            var config = try JSONDecoder().decode(Config.self, from: data)
            migrate(&config)
            return config
        } catch {
            Log.error("config.json unreadable (\(error)); using defaults, original kept as config.json.bad")
            let bad = directory.appendingPathComponent("config.json.bad")
            try? FileManager.default.removeItem(at: bad)
            try? FileManager.default.copyItem(at: configURL, to: bad)
            return Config.defaults(family: family)
        }
    }

    // MARK: One-time migrations of existing configs (recorded in migrations.json so each runs once)

    var migrationsURL: URL { directory.appendingPathComponent("migrations.json") }

    static let allMigrations = ["learnFromUseDefaultOff"]

    private func migrate(_ config: inout Config) {
        var done = (try? JSONDecoder().decode([String].self, from: Data(contentsOf: migrationsURL))) ?? []
        // learnFromUse used to default to true, and configs saved since then carry that default, so a user's own
        // choice cannot be told apart from it. Turn it off once; an explicit "true" set after this sticks.
        if !done.contains("learnFromUseDefaultOff") {
            if config.settings.learnFromUse {
                config.settings.learnFromUse = false
                Log.info("settings.learnFromUse was on (the old default); turned it off. Turn it on again in settings if you want it.")
                do { try save(config) } catch { Log.error("could not save the migrated config: \(error)") }
            }
            done.append("learnFromUseDefaultOff")
            try? JSONEncoder().encode(done).write(to: migrationsURL, options: .atomic)
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

    /// One training sample. posture / strength / kind are recorded by calibration (older files lack them).
    struct LabeledSample: Codable {
        var label: String
        var features: TapFeatures
        var posture: String? = nil       // desk | lap | stand
        var strength: String? = nil      // soft | firm
        var kind: String? = nil          // single | double1 | double2 | negative | feedback | confirmed
    }

    /// Labeled samples saved by the last calibration or feedback (empty if none).
    func loadSamples() -> [LabeledSample] {
        guard let data = try? Data(contentsOf: samplesURL) else { return [] }
        return (try? JSONDecoder().decode([LabeledSample].self, from: data)) ?? []
    }

    var diagnosticsDirectory: URL { directory.appendingPathComponent("diagnostics", isDirectory: true) }

    /// Keeps the raw labeled calibration samples so a later version can retrain without asking the user again.
    func saveSamples(_ samples: [LabeledSample]) throws {
        try write(JSONEncoder().encode(samples), to: samplesURL)
    }

    private func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Keep the previous version one step back (SAFETY_AUDIT item 13).
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) {
            let bak = url.appendingPathExtension("bak")
            try? fm.removeItem(at: bak)
            try? fm.copyItem(at: url, to: bak)
        }
        try data.write(to: url, options: .atomic)
    }
}
