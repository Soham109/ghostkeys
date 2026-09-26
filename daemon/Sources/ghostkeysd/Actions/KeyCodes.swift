import CoreGraphics

/// Virtual key codes (kVK_* from HIToolbox Events.h) for the ANSI layout.
enum KeyCodes {
    static let map: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
            "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
            "k": 40, "n": 45, "m": 46,
            "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25, "0": 29,
            "=": 24, "-": 27, "]": 30, "[": 33, "'": 39, ";": 41, "\\": 42, ",": 43, "/": 44, ".": 47, "`": 50,
            "equal": 24, "minus": 27, "rightbracket": 30, "leftbracket": 33, "quote": 39, "semicolon": 41,
            "backslash": 42, "comma": 43, "slash": 44, "period": 47, "grave": 50,
            "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
            "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
            "left": 123, "right": 124, "down": 125, "up": 126,
            "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
            "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113, "f16": 106, "f17": 64, "f18": 79, "f19": 80,
            "f20": 90,
        ]
        m["arrowleft"] = 123; m["arrowright"] = 124; m["arrowdown"] = 125; m["arrowup"] = 126
        return m
    }()

    static func code(for key: String) -> CGKeyCode? {
        map[key.lowercased()] ?? map[key]
    }

    static func flags(_ modifiers: [String]) -> CGEventFlags {
        var f = CGEventFlags()
        for m in modifiers {
            switch m.lowercased() {
            case "shift": f.insert(.maskShift)
            case "control", "ctrl": f.insert(.maskControl)
            case "option", "alt": f.insert(.maskAlternate)
            case "command", "cmd": f.insert(.maskCommand)
            case "fn": f.insert(.maskSecondaryFn)
            default: break
            }
        }
        return f
    }
}
