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
    /// Disabled zones are left out of the zone model (their taps are not classified) and never fire bindings.
    var enabled: Bool = true

    init(id: String, name: String, surface: String, rect: ZoneRect, color: String, enabled: Bool = true) {
        self.id = id; self.name = name; self.surface = surface; self.rect = rect; self.color = color; self.enabled = enabled
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id
        surface = try c.decodeIfPresent(String.self, forKey: .surface) ?? "base"
        rect = try c.decode(ZoneRect.self, forKey: .rect)
        color = try c.decodeIfPresent(String.self, forKey: .color) ?? "#888888"
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
    }
    private enum CodingKeys: String, CodingKey { case id, name, surface, rect, color, enabled }
}

/// Knob mode for a `pinch_hold` binding: while the pinch is held, the action fires once per `stepPx` of travel along
/// `axis` (camera pixels at 640x480). Positive travel is right (x) or up (y); travel the other way runs `inverse` if set.
struct KnobSpec: Codable, Equatable, Sendable {
    var axis: String          // "x" or "y"
    var stepPx: Double
    var inverse: JSONValue?

    /// Step as a fraction of the camera frame (landmark coordinates are 0...1).
    var stepFraction: Double { max(1, stepPx) / (axis == "y" ? 480 : 640) }
}

/// Slider mode for continuous sonar gestures (`hover_level`, `finger_slide`): the action fires once per `stepMm` of
/// hand (or finger) travel. `relative`: every step of movement counts, like a knob (up = `action`, down = `inverse`).
/// `absolute`: the output follows the position since the gesture began, so moving back to the start undoes the
/// steps, and a gesture that ends cancelled (typing, interference) is undone.
struct SliderSpec: Codable, Equatable, Sendable {
    var mode: String          // "absolute" | "relative"
    var stepMm: Double
    var inverse: JSONValue?
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
    var knob: KnobSpec?
    var slider: SliderSpec?

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
        knob = try c.decodeIfPresent(KnobSpec.self, forKey: .knob)
        slider = try c.decodeIfPresent(SliderSpec.self, forKey: .slider)
        if let s = slider, !["absolute", "relative"].contains(s.mode) || !s.stepMm.isFinite || s.stepMm < 1 {
            throw DecodingError.dataCorruptedError(forKey: .slider, in: c, debugDescription: "slider needs mode absolute|relative and stepMm >= 1")
        }
        if let k = knob, !["x", "y"].contains(k.axis) || !k.stepPx.isFinite || k.stepPx <= 0 {
            throw DecodingError.dataCorruptedError(forKey: .knob, in: c, debugDescription: "knob needs axis x|y and stepPx > 0")
        }
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
        try c.encodeIfPresent(knob, forKey: .knob)
        try c.encodeIfPresent(slider, forKey: .slider)
    }

    private enum CodingKeys: String, CodingKey { case id, enabled, gesture, zone, zones, modifiers, app, action, label, knob, slider }
}

/// Optional sound mode (GhostkeysAcoustics). Off by default; the mic opens only in short sessions.
struct SoundSettings: Codable, Equatable, Sendable {
    var enabled = false
    var sessionSeconds = 30.0
    /// Bundle ids where a session starts by itself when the app comes to the front (needs a sound binding too).
    var autoApps: [String] = []

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        sessionSeconds = try c.decodeIfPresent(Double.self, forKey: .sessionSeconds) ?? 30
        autoApps = try c.decodeIfPresent([String].self, forKey: .autoApps) ?? []
    }
    private enum CodingKeys: String, CodingKey { case enabled, sessionSeconds, autoApps }
}

/// Optional stereo sonar (GhostkeysAcoustics SonarField): two inaudible tones on the built-in speakers plus the mic.
/// Off by default; the tones never play unless this is enabled.
struct SonarSettings: Codable, Equatable, Sendable {
    var enabled = false
    var sessionSeconds = 30.0
    var autoApps: [String] = []

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        sessionSeconds = try c.decodeIfPresent(Double.self, forKey: .sessionSeconds) ?? 30
        autoApps = try c.decodeIfPresent([String].self, forKey: .autoApps) ?? []
    }
    private enum CodingKeys: String, CodingKey { case enabled, sessionSeconds, autoApps }
}

/// Optional camera add-on (GhostkeysVision). Off by default; the camera runs only in short sessions.
struct CameraSettings: Codable, Equatable, Sendable {
    var enabled = false
    var sessionSeconds = 30.0
    var autoApps: [String] = []
    /// Experimental Desk View mode (fingertips on the deck). Only used when true.
    var deskMode = false

    init() {}
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        sessionSeconds = try c.decodeIfPresent(Double.self, forKey: .sessionSeconds) ?? 30
        autoApps = try c.decodeIfPresent([String].self, forKey: .autoApps) ?? []
        deskMode = try c.decodeIfPresent(Bool.self, forKey: .deskMode) ?? false
    }
    private enum CodingKeys: String, CodingKey { case enabled, sessionSeconds, autoApps, deskMode }
}

struct AppSettings: Codable, Equatable, Sendable {
    var sensitivity = 0.5
    var typingGateMs = 450.0
    var doubleWindowMs = 350.0
    var minConfidence = 0.8
    /// A tap at this confidence may complete a double / triple in the same zone (see DetectionSettings).
    var followUpConfidence = 0.5
    /// Lets much lighter taps through where the room is quiet (see DetectionSettings.lightTouch).
    var lightTouch = false
    var hud = true
    var haptics = false
    var sound = SoundSettings()
    var camera = CameraSettings()
    var sonar = SonarSettings()

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppSettings()
        sensitivity = try c.decodeIfPresent(Double.self, forKey: .sensitivity) ?? d.sensitivity
        typingGateMs = try c.decodeIfPresent(Double.self, forKey: .typingGateMs) ?? d.typingGateMs
        doubleWindowMs = try c.decodeIfPresent(Double.self, forKey: .doubleWindowMs) ?? d.doubleWindowMs
        minConfidence = try c.decodeIfPresent(Double.self, forKey: .minConfidence) ?? d.minConfidence
        followUpConfidence = try c.decodeIfPresent(Double.self, forKey: .followUpConfidence) ?? d.followUpConfidence
        lightTouch = try c.decodeIfPresent(Bool.self, forKey: .lightTouch) ?? d.lightTouch
        hud = try c.decodeIfPresent(Bool.self, forKey: .hud) ?? d.hud
        haptics = try c.decodeIfPresent(Bool.self, forKey: .haptics) ?? d.haptics
        sound = try c.decodeIfPresent(SoundSettings.self, forKey: .sound) ?? SoundSettings()
        camera = try c.decodeIfPresent(CameraSettings.self, forKey: .camera) ?? CameraSettings()
        sonar = try c.decodeIfPresent(SonarSettings.self, forKey: .sonar) ?? SonarSettings()
    }

    private enum CodingKeys: String, CodingKey { case sensitivity, typingGateMs, doubleWindowMs, minConfidence, followUpConfidence, lightTouch, hud, haptics, sound, camera, sonar }

    var detection: DetectionSettings {
        var s = DetectionSettings()
        s.sensitivity = min(1, max(0, sensitivity))
        s.typingGateMs = max(0, typingGateMs)
        s.doubleWindowMs = max(50, doubleWindowMs)
        s.minConfidence = min(1, max(0, minConfidence))
        s.followUpConfidence = min(s.minConfidence, max(0, followUpConfidence))
        s.lightTouch = lightTouch
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

    static let soundGestures: Set<String> = ["knock_knuckle", "rub", "rub_left", "rub_right", "wave_toward", "wave_away", "wave_sweep"]
    static let waveGestures: Set<String> = ["wave_toward", "wave_away", "wave_sweep"]
    /// SonarField gestures (discrete ones, plus the continuous hover_level / finger_slide that `slider` bindings use).
    static let sonarGestures: Set<String> = ["push", "pull", "sweep_left", "sweep_right", "finger_slide_left",
                                             "finger_slide_right", "finger_slide_up", "finger_slide_down",
                                             "hover_level", "finger_slide"]
    static let cameraGestures: Set<String> = ["air_tap", "pinch_hold", "pinch_drag_left", "pinch_drag_right", "pinch_drag_up",
                                              "pinch_drag_down", "palm_swipe_left", "palm_swipe_right", "circle_cw", "circle_ccw"]

    /// Enabled bindings whose gesture is in `gestures` and that apply to `app` (or to every app).
    func hasBinding(for gestures: Set<String>, app: String? = nil) -> Bool {
        bindings.contains { $0.enabled && gestures.contains($0.gesture) && ($0.app == "*" || app == nil || $0.app == app) }
    }

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

    /// Default zones for a family, from the app's zone-defaults.json (see ZoneDefaults). Falls back to the built-in
    /// MacBook Pro layout below only if the embedded JSON could not be read.
    static func defaultZones(family: String) -> [Zone] {
        ZoneDefaults.zones(for: family) ?? builtInZones
    }

    /// Default zones when the family is not known yet (decoding a config without zones).
    static var defaultZones: [Zone] { defaultZones(family: ZoneDefaults.fallbackFamily) }

    /// Last-resort layout (top view, x 0 = left edge of the base, y 0 = hinge, 1 = front lip).
    static let builtInZones: [Zone] = [
        Zone(id: "left-palm", name: "Left palm rest", surface: "base", rect: .init(x: 0.04, y: 0.62, w: 0.28, h: 0.34), color: "#3DDC97"),
        Zone(id: "right-palm", name: "Right palm rest", surface: "base", rect: .init(x: 0.68, y: 0.62, w: 0.28, h: 0.34), color: "#FFB547"),
        Zone(id: "left-grille", name: "Left grille", surface: "base", rect: .init(x: 0.02, y: 0.08, w: 0.1, h: 0.45), color: "#4FC3F7"),
        Zone(id: "right-grille", name: "Right grille", surface: "base", rect: .init(x: 0.88, y: 0.08, w: 0.1, h: 0.45), color: "#7C5CFF"),
        Zone(id: "top-strip", name: "Top strip", surface: "base", rect: .init(x: 0.14, y: 0.0, w: 0.72, h: 0.06), color: "#FF6B9A"),
        Zone(id: "left-edge", name: "Left edge", surface: "edge-left", rect: .init(x: 0.0, y: 0.1, w: 0.03, h: 0.8), color: "#9CCC65"),
        Zone(id: "right-edge", name: "Right edge", surface: "edge-right", rect: .init(x: 0.97, y: 0.1, w: 0.03, h: 0.8), color: "#FF8A65"),
        Zone(id: "lid", name: "Lid", surface: "lid", rect: .init(x: 0.1, y: 0.1, w: 0.8, h: 0.8), color: "#B0BEC5"),
    ]

    /// Only two harmless bindings are enabled by default: double tap to change the volume, on the speaker grilles
    /// where the family has them (MacBook Pro), else on the side edges (MacBook Air), like the app's defaults.
    static func defaultBindings(zones: [Zone]) -> [Binding] {
        let ids = Set(zones.map(\.id))
        let right = ids.contains("right-grille") ? "right-grille" : "right-edge"
        let left = ids.contains("left-grille") ? "left-grille" : "left-edge"
        return [
            Binding(id: "b1", enabled: true, gesture: "double", zone: right, zones: nil,
                    action: .object(["kind": .string("volume"), "step": .number(6)]), label: "Volume up"),
            Binding(id: "b2", enabled: true, gesture: "double", zone: left, zones: nil,
                    action: .object(["kind": .string("volume"), "step": .number(-6)]), label: "Volume down"),
        ].filter { ids.contains($0.zone ?? "") }
    }

    /// A new config for the detected family. Only used when there is no config.json yet.
    static func defaults(family: String) -> Config {
        let zones = defaultZones(family: family)
        return Config(zones: zones, bindings: defaultBindings(zones: zones), settings: AppSettings())
    }

    /// Zone centres on the deck plane for ZoneModel, from each zone's rect and surface.
    var zoneCenters: [String: [Double]] {
        Dictionary(zones.map { ($0.id, ZoneDefaults.deckCenter($0)) }, uniquingKeysWith: { a, _ in a })
    }
}
