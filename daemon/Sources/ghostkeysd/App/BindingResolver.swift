import Foundation
import GhostkeysDetection

enum BindingResolver {
    /// Gestures that are not tied to a tap zone.
    static let zonelessGestures: Set<String> = ["lid_nudge", "cover", "cover_hold", "tilt_left", "tilt_right"]

    /// The enabled binding for this gesture: same gesture, same zone (both zones in order for `sequence`), exactly the
    /// same set of held modifiers, and an app that matches. A binding for the frontmost app wins over "*".
    static func resolve(_ g: GestureEvent, bindings: [Binding], app: String?) -> Binding? {
        let held = Set(g.modifiers.map { $0.lowercased() })
        let matches = bindings.filter { b in
            guard b.enabled, b.gesture == g.gesture else { return false }
            guard Set(b.modifiers.map { $0.lowercased() }) == held else { return false }
            guard b.app == "*" || (app != nil && b.app == app) else { return false }
            if g.gesture == "sequence" {
                return (b.zones ?? []) == g.zones
            }
            if zonelessGestures.contains(g.gesture) {
                return b.zone == nil || g.zone == nil || b.zone == g.zone
            }
            return b.zone != nil && b.zone == g.zone
        }
        return matches.first { $0.app != "*" } ?? matches.first
    }
}
