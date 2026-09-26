import Foundation
import AppKit
import ApplicationServices

/// Frontmost window and app operations. Window moves go through the Accessibility API.
/// Must be called on the main thread (NSScreen / NSWorkspace).
enum WindowActions {
    static let windowOps: Set<String> = ["left", "right", "top", "bottom", "maximize", "center", "next-display", "minimize", "fullscreen"]
    static let appOps: Set<String> = ["hide", "quit", "switch-next", "switch-previous"]

    // MARK: Window

    static func window(_ op: String) throws {
        guard windowOps.contains(op) else { throw ActionError("unknown window op: \(op)") }
        try EventPoster.requireTrust()
        guard let app = NSWorkspace.shared.frontmostApplication else { throw ActionError("no frontmost app") }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        var ref: CFTypeRef?
        guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &ref) == .success,
              let windowRef = ref, CFGetTypeID(windowRef) == AXUIElementGetTypeID() else {
            throw ActionError("the frontmost app has no focused window")
        }
        let window = windowRef as! AXUIElement

        switch op {
        case "minimize":
            try check(AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue), "minimize")
            return
        case "fullscreen":
            var cur: CFTypeRef?
            AXUIElementCopyAttributeValue(window, "AXFullScreen" as CFString, &cur)
            let isFull = (cur as? Bool) ?? false
            try check(AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, (!isFull) as CFBoolean), "fullscreen")
            return
        default: break
        }

        guard let frame = axFrame(window) else { throw ActionError("could not read the window frame") }
        let screens = NSScreen.screens
        guard let primary = screens.first else { throw ActionError("no screen") }
        // AX uses top-left origin relative to the primary screen; NSScreen uses bottom-left.
        func toAX(_ r: CGRect) -> CGRect {
            CGRect(x: r.minX, y: primary.frame.maxY - r.maxY, width: r.width, height: r.height)
        }
        let center = CGPoint(x: frame.midX, y: frame.midY)
        let current = screens.first { toAX($0.frame).contains(center) } ?? NSScreen.main ?? primary
        var target = current
        if op == "next-display" {
            guard screens.count > 1, let i = screens.firstIndex(of: current) else { return }
            target = screens[(i + 1) % screens.count]
        }
        let vis = toAX(target.visibleFrame)
        var newFrame: CGRect
        switch op {
        case "left": newFrame = CGRect(x: vis.minX, y: vis.minY, width: vis.width / 2, height: vis.height)
        case "right": newFrame = CGRect(x: vis.midX, y: vis.minY, width: vis.width / 2, height: vis.height)
        case "top": newFrame = CGRect(x: vis.minX, y: vis.minY, width: vis.width, height: vis.height / 2)
        case "bottom": newFrame = CGRect(x: vis.minX, y: vis.midY, width: vis.width, height: vis.height / 2)
        case "maximize": newFrame = vis
        case "center":
            let w = min(frame.width, vis.width), h = min(frame.height, vis.height)
            newFrame = CGRect(x: vis.midX - w / 2, y: vis.midY - h / 2, width: w, height: h)
        case "next-display":
            // Keep the window's relative position and size on the new screen.
            let from = toAX(current.visibleFrame)
            let rx = (frame.minX - from.minX) / max(from.width, 1), ry = (frame.minY - from.minY) / max(from.height, 1)
            let w = min(frame.width, vis.width), h = min(frame.height, vis.height)
            newFrame = CGRect(x: min(vis.minX + rx * vis.width, vis.maxX - w), y: min(vis.minY + ry * vis.height, vis.maxY - h),
                              width: w, height: h)
        default: return
        }
        // Position, size, position again: some apps clamp size to the screen the window is currently on.
        try setPosition(window, newFrame.origin)
        try setSize(window, newFrame.size)
        try setPosition(window, newFrame.origin)
    }

    private static func axFrame(_ w: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?, sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posRef, let sizeRef else { return nil }
        var p = CGPoint.zero, s = CGSize.zero
        AXValueGetValue(posRef as! AXValue, .cgPoint, &p)
        AXValueGetValue(sizeRef as! AXValue, .cgSize, &s)
        return CGRect(origin: p, size: s)
    }

    private static func setPosition(_ w: AXUIElement, _ p: CGPoint) throws {
        var p = p
        guard let v = AXValueCreate(.cgPoint, &p) else { return }
        try check(AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v), "move")
    }

    private static func setSize(_ w: AXUIElement, _ s: CGSize) throws {
        var s = s
        guard let v = AXValueCreate(.cgSize, &s) else { return }
        try check(AXUIElementSetAttributeValue(w, kAXSizeAttribute as CFString, v), "resize")
    }

    private static func check(_ err: AXError, _ what: String) throws {
        guard err == .success else { throw ActionError("could not \(what) the window (AX error \(err.rawValue))") }
    }

    // MARK: App

    static func app(_ op: String) throws {
        guard appOps.contains(op) else { throw ActionError("unknown app op: \(op)") }
        guard let front = NSWorkspace.shared.frontmostApplication else { throw ActionError("no frontmost app") }
        switch op {
        case "hide":
            guard front.hide() else { throw ActionError("could not hide \(front.localizedName ?? "app")") }
        case "quit":
            guard front.bundleIdentifier != "com.apple.finder" else { throw ActionError("refusing to quit Finder") }
            guard front.processIdentifier != getpid() else { throw ActionError("refusing to quit ghostkeysd") }
            guard front.terminate() else { throw ActionError("could not quit \(front.localizedName ?? "app")") }
        case "switch-next", "switch-previous":
            let order = appsFrontToBack()
            guard order.count > 1 else { throw ActionError("no other app to switch to") }
            // Like cmd-tab: next = the most recently used other app; previous = cycle backwards to the least recent.
            let target = op == "switch-next" ? order[1] : order[order.count - 1]
            if !target.activate(options: [.activateAllWindows]) {
                if let url = target.bundleURL {
                    _ = ProcessRunner.run("/usr/bin/open", [url.path], timeout: 5)
                } else {
                    throw ActionError("could not switch to \(target.localizedName ?? "app")")
                }
            }
        default: break
        }
    }

    /// Regular apps ordered by their frontmost on-screen window (window list is front to back).
    private static func appsFrontToBack() -> [NSRunningApplication] {
        let regular = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isHidden }
        let byPID = Dictionary(regular.map { ($0.processIdentifier, $0) }, uniquingKeysWith: { a, _ in a })
        var seen = Set<pid_t>()
        var result: [NSRunningApplication] = []
        if let front = NSWorkspace.shared.frontmostApplication, byPID[front.processIdentifier] != nil {
            result.append(front); seen.insert(front.processIdentifier)
        }
        let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for w in info {
            guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, (w[kCGWindowLayer as String] as? Int) == 0,
                  let app = byPID[pid], !seen.contains(pid) else { continue }
            seen.insert(pid); result.append(app)
        }
        return result
    }
}
