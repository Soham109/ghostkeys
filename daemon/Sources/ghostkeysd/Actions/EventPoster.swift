import Foundation
import AppKit
import CoreGraphics
import ApplicationServices

/// Synthesized keyboard, media-key and text events. All of these need the Accessibility permission.
enum EventPoster {
    struct NeedsAccessibility: Error, CustomStringConvertible {
        var description: String { "Accessibility permission is not granted (System Settings > Privacy & Security > Accessibility)" }
    }

    static var trusted: Bool { AXIsProcessTrusted() }

    static func requireTrust() throws {
        guard trusted else { throw NeedsAccessibility() }
    }

    static func keystroke(_ key: CGKeyCode, flags: CGEventFlags) throws {
        try requireTrust()
        let src = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false) else {
            throw ActionError("could not create key event")
        }
        down.flags = flags
        up.flags = flags
        down.post(tap: .cghidEventTap)
        usleep(8_000)
        up.post(tap: .cghidEventTap)
    }

    // NX_KEYTYPE_* from IOKit/hidsystem/ev_keymap.h
    enum AuxKey: Int {
        case soundUp = 0, soundDown = 1, brightnessUp = 2, brightnessDown = 3, mute = 7
        case play = 16, next = 17, previous = 18
    }

    /// Posts a system-defined (subtype 8) aux key press and release, like the media keys on the keyboard.
    static func auxKey(_ key: AuxKey) throws {
        try requireTrust()
        for down in [true, false] {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xA00 : 0xB00)
            let data1 = (key.rawValue << 16) | ((down ? 0xA : 0xB) << 8)
            guard let ev = NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags,
                                              timestamp: 0, windowNumber: 0, context: nil, subtype: 8,
                                              data1: data1, data2: -1),
                  let cg = ev.cgEvent else { throw ActionError("could not create media key event") }
            cg.post(tap: .cghidEventTap)
            usleep(8_000)
        }
    }

    /// Types text as unicode keyboard events, in chunks (CGEvent accepts at most 20 UTF-16 units per event).
    static func type(_ text: String) throws {
        try requireTrust()
        let units = Array(text.utf16)
        let src = CGEventSource(stateID: .hidSystemState)
        var i = 0
        while i < units.count {
            var end = min(i + 20, units.count)
            // Do not split a surrogate pair.
            if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            var chunk = Array(units[i..<end])
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else {
                throw ActionError("could not create text event")
            }
            down.flags = []
            up.flags = []
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            usleep(4_000)
            i = end
        }
    }
}

struct ActionError: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}
