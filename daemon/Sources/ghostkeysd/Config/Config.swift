import Foundation
import GhostkeysDetection

struct ZoneRect: Codable, Equatable, Sendable {
    var x: Double, y: Double, w: Double, h: Double
}

struct Zone: Codable, Equatable, Sendable {
    var id: String
    var name: String
    var surface: String          // base, lid, edge-left, edge-right, front
    var rect: ZoneRect
    var color: String
}

struct Binding: Codable, Equatable, Sendable {
    var id: String
    var enabled: Bool
    var gesture: String
    var zone: String?
    var zones: [String]?
    var modifiers: [String]
    var app: String
    var action: JSONValue
    var label: String?

    init(id: String, enabled: Bool, gesture: String, zone: String?, zones: [String]? = nil, modifiers: [String] = [],
         app: String = "*", action: JSONValue, label: String?) {
        self.id = id; self.enabled = enabled; self.gesture = gesture; self.zone = zone; self.zones = zones
        self.modifiers = modifiers; self.app = app; self.action = action; self.label = label
    }

    // Lenient decoding: missing optional-ish fields get defaults instead of failing the whole config.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        gesture = try c.decode(String.self, forKey: .gesture)
        zone = try c.decodeIfPresent(String.self, forKey: .zone)
        zones = try c.decodeIfPresent([String].self, forKey: .zones)
        modifiers = try c.decodeIfPresent([String].self, forKey: .modifiers) ?? []
        app = try c.decodeIfPresent(String.self, forKey: .app) ?? "*"
        action = try c.decodeIfPresent(JSONValue.self, forKey: .action) ?? .object([:])
        label = try c.decodeIfPresent(String.self, forKey: .label)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(enabled, forKey: .enabled)
        try c.encode(gesture, forKey: .gesture)
        try c.encode(zone, forKey: .zone)        // explicit null, as in PROTOCOL.md
        try c.encode(zones, forKey: .zones)
        try c.encode(modifiers, forKey: .modifiers)
        try c.encode(app, forKey: .app)
        try c.encode(action, forKey: .action)
        try c.encode(label, forKey: .label)
    }

    private enum CodingKeys: String, CodingKey { case id, enabled, gesture, zone, zones, modifiers, app, action, label }
}

struct AppSettings: Codable, Equatable, Sendable {
    var sensitivity = 0.5
    var typingGateMs = 450.0
    var doubleWindowMs = 350.0
    var minConfidence = 0.8
    var hud = true
    var haptics = false

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        sensitivity = try c.decodeIfPresent(Double.self, forKey: .sensitivity) ?? d.sensitivity
        typingGateMs = try c.decodeIfPresent(Double.self, forKey: .typingGateMs) ?? d.typingGateMs
        doubleWindowMs = try c.decodeIfPresent(Double.self, forKey: .doubleWindowMs) ?? d.doubleWindowMs
        minConfidence = try c.decodeIfPresent(Double.self, forKey: .minConfidence) ?? d.minConfidence
        hud = try c.decodeIfPresent(Bool.self, forKey: .hud) ?? d.hud
        haptics = try c.decodeIfPresent(Bool.self, forKey: .haptics) ?? d.haptics
    }

    private enum CodingKeys: String, CodingKey { case sensitivity, typingGateMs, doubleWindowMs, minConfidence, hud, haptics }

    var detection: DetectionSettings {
        var s = DetectionSettings()
        s.sensitivity = min(1, max(0, sensitivity))
        s.typingGateMs = max(0, typingGateMs)
        s.doubleWindowMs = max(50, doubleWindowMs)
        s.minConfidence = min(1, max(0, minConfidence))
        return s
    }
}

struct Config: Codable, Equatable, Sendable {
    var version = 1
    var zones: [Zone]
    var bindings: [Binding]
    var settings: AppSettings

    init(version: Int = 1, zones: [Zone], bindings: [Binding], settings: AppSettings) {
        self.version = version; self.zones = zones; self.bindings = bindings; self.settings = settings
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        zones = try c.decodeIfPresent([Zone].self, forKey: .zones) ?? Config.defaultZones
        bindings = try c.decodeIfPresent([Binding].self, forKey: .bindings) ?? []
        settings = try c.decodeIfPresent(AppSettings.self, forKey: .settings) ?? AppSettings()
    }

    private enum CodingKeys: String, CodingKey { case version, zones, bindings, settings }

    /// Gestures that need the engine to wait for more taps before reporting a single tap.
    static let multiTapGestures: Set<String> = ["double", "triple", "rhythm"]

    /// Zones that have at least one enabled double / triple / rhythm / sequence binding (see GestureGrammar.swift).
    var zonesNeedingMultiTap: Set<String> {
        var s = Set<String>()
        for b in bindings where b.enabled {
            if Config.multiTapGestures.contains(b.gesture), let z = b.zone { s.insert(z) }
            if b.gesture == "sequence" { s.formUnion(b.zones ?? []) }
        }
        return s
    }

    // MARK: Defaults

    /// Default zones for a MacBook Pro (top view, x 0 = left edge of the base, y 0 = hinge, 1 = front lip).
    static let defaultZones: [Zone] = [
        Zone(id: "left-palm", name: "Left palm rest", surface: "base", rect: .init(x: 0.04, y: 0.62, w: 0.28, h: 0.34), color: "#3DDC97"),
        Zone(id: "right-palm", name: "Right palm rest", surface: "base", rect: .init(x: 0.68, y: 0.62, w: 0.28, h: 0.34), color: "#FFB547"),
        Zone(id: "left-grille", name: "Left grille", surface: "base", rect: .init(x: 0.02, y: 0.08, w: 0.1, h: 0.45), color: "#4FC3F7"),
        Zone(id: "right-grille", name: "Right grille", surface: "base", rect: .init(x: 0.88, y: 0.08, w: 0.1, h: 0.45), color: "#7C5CFF"),
        Zone(id: "top-strip", name: "Top strip", surface: "base", rect: .init(x: 0.14, y: 0.0, w: 0.72, h: 0.06), color: "#FF6B9A"),
        Zone(id: "left-edge", name: "Left edge", surface: "edge-left", rect: .init(x: 0.0, y: 0.1, w: 0.03, h: 0.8), color: "#9CCC65"),
        Zone(id: "right-edge", name: "Right edge", surface: "edge-right", rect: .init(x: 0.97, y: 0.1, w: 0.03, h: 0.8), color: "#FF8A65"),
        Zone(id: "lid", name: "Lid", surface: "lid", rect: .init(x: 0.1, y: 0.1, w: 0.8, h: 0.8), color: "#B0BEC5"),
    ]

    /// Only two harmless bindings are enabled by default.
    static let defaultBindings: [Binding] = [
        Binding(id: "b1", enabled: true, gesture: "double", zone: "right-grille", zones: nil,
                action: .object(["kind": .string("volume"), "step": .number(6)]), label: "Volume up"),
        Binding(id: "b2", enabled: true, gesture: "double", zone: "left-grille", zones: nil,
                action: .object(["kind": .string("volume"), "step": .number(-6)]), label: "Volume down"),
    ]

    static var defaults: Config { Config(zones: defaultZones, bindings: defaultBindings, settings: AppSettings()) }
}
