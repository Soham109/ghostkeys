import Foundation
import CryptoKit

/// Canonical default zones per MacBook family, shared with the app.
/// Source of truth: app/src/shared/zone-defaults.json, embedded by daemon/scripts/gen-zone-defaults.sh as
/// ZoneDefaults.generated.swift. Used only when creating a NEW config; an existing config.json is never rewritten.
enum ZoneDefaults {
    private struct File: Decodable {
        struct Family: Decodable { let zones: [Zone] }
        let families: [String: Family]
    }

    static let fallbackFamily = "macbook-pro-14"

    /// Family id -> zones, parsed once from the embedded JSON. Empty only if the embedded JSON is broken.
    static let families: [String: [Zone]] = {
        do {
            let f = try JSONDecoder().decode(File.self, from: Data(ZoneDefaultsSource.json.utf8))
            return f.families.mapValues(\.zones)
        } catch {
            Log.error("embedded zone defaults are unreadable (\(error)); using built-in zones")
            return [:]
        }
    }()

    /// Zones for a detected family (`other` and unknown families get the 14-inch MacBook Pro layout, like the app).
    static func zones(for family: String) -> [Zone]? {
        families[family] ?? families[fallbackFamily]
    }

    /// Centre of a zone on the deck plane, as ZoneModel expects it (x 0 = left edge, 1 = right edge; y 0 = hinge,
    /// 1 = front lip). Each surface has its own rect convention (see the JSON's "coordinates"):
    /// base uses its rect; edges use only y/h and sit at x 0 or 1; the front lip uses only x/w and sits at y 1;
    /// the lid is behind the hinge, so it maps to y 0 at its horizontal centre.
    static func deckCenter(_ z: Zone) -> [Double] {
        let cx = z.rect.x + z.rect.w / 2, cy = z.rect.y + z.rect.h / 2
        switch z.surface {
        case "edge-left": return [0, cy]
        case "edge-right": return [1, cy]
        case "front": return [cx, 1]
        case "lid": return [cx, 0]
        default: return [cx, cy]
        }
    }

    /// In a dev checkout, warn if the app's JSON changed since the daemon embedded it.
    static func warnIfStale() {
        let exe = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        // daemon/.build*/debug/ghostkeysd -> repo root is three levels up from the binary's directory.
        let json = exe.deletingLastPathComponent().appendingPathComponent("../../../app/src/shared/zone-defaults.json").standardizedFileURL
        guard let data = try? Data(contentsOf: json) else { return }
        let sum = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        if sum != ZoneDefaultsSource.sha256 {
            Log.info("app/src/shared/zone-defaults.json changed since it was embedded; run daemon/scripts/gen-zone-defaults.sh and rebuild")
        }
    }
}
