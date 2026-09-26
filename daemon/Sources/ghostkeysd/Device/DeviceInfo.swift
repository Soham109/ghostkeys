import Foundation
import CoreGraphics

struct DeviceInfo {
    var model: String
    var chip: String
    var family: String      // macbook-pro-14, macbook-pro-16, macbook-air-13, macbook-air-15, other

    static func current() -> DeviceInfo {
        let model = sysctlString("hw.model") ?? "unknown"
        let chip = sysctlString("machdep.cpu.brand_string") ?? "unknown"
        return DeviceInfo(model: model, chip: chip, family: guessFamily(model: model, diagonal: builtInDiagonalInches()))
    }

    static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
        return String(cString: buf)
    }

    /// Diagonal of the built-in display in inches, if it is on (not in clamshell mode).
    static func builtInDiagonalInches() -> Double? {
        var count: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        guard CGGetOnlineDisplayList(16, &ids, &count) == .success else { return nil }
        for id in ids.prefix(Int(count)) where CGDisplayIsBuiltin(id) != 0 {
            let mm = CGDisplayScreenSize(id)
            guard mm.width > 0, mm.height > 0 else { continue }
            return (mm.width * mm.width + mm.height * mm.height).squareRoot() / 25.4
        }
        return nil
    }

    /// Known Apple silicon laptop identifiers. Newer Macs use "MacNN,M" names that do not say Air or Pro,
    /// so unknown ones fall back to the screen size.
    private static let knownModels: [String: String] = [
        "MacBookAir10,1": "macbook-air-13",
        "MacBookPro17,1": "macbook-pro-13",
        "MacBookPro18,3": "macbook-pro-14", "MacBookPro18,4": "macbook-pro-14",
        "MacBookPro18,1": "macbook-pro-16", "MacBookPro18,2": "macbook-pro-16",
        "Mac14,2": "macbook-air-13", "Mac14,15": "macbook-air-15",
        "Mac14,5": "macbook-pro-14", "Mac14,9": "macbook-pro-14",
        "Mac14,6": "macbook-pro-16", "Mac14,10": "macbook-pro-16",
        "Mac14,7": "macbook-pro-13",
        "Mac15,3": "macbook-pro-14", "Mac15,6": "macbook-pro-14", "Mac15,8": "macbook-pro-14", "Mac15,10": "macbook-pro-14",
        "Mac15,7": "macbook-pro-16", "Mac15,9": "macbook-pro-16", "Mac15,11": "macbook-pro-16",
        "Mac15,12": "macbook-air-13", "Mac15,13": "macbook-air-15",
        "Mac16,1": "macbook-pro-14", "Mac16,6": "macbook-pro-14", "Mac16,8": "macbook-pro-14",
        "Mac16,5": "macbook-pro-16", "Mac16,7": "macbook-pro-16",
        "Mac16,12": "macbook-air-13", "Mac16,13": "macbook-air-15",
    ]

    static func guessFamily(model: String, diagonal: Double?) -> String {
        if let f = knownModels[model] {
            // The protocol has no 13-inch Pro family; it is closest to the 13-inch Air in size.
            return f == "macbook-pro-13" ? "macbook-air-13" : f
        }
        let lower = model.lowercased()
        let isAir = lower.contains("macbookair")
        let isPro = lower.contains("macbookpro")
        guard let d = diagonal else {
            if isAir { return "macbook-air-13" }
            if isPro { return "macbook-pro-14" }
            return "other"
        }
        // Built-in panels: Air 13.6, Pro 14.2, Air 15.3, Pro 16.2.
        switch d {
        case ..<12.5: return "other"
        case ..<13.9: return "macbook-air-13"
        case ..<14.8: return isAir ? "macbook-air-13" : "macbook-pro-14"
        case ..<15.8: return isPro ? "macbook-pro-16" : "macbook-air-15"
        case ..<17.0: return "macbook-pro-16"
        default: return "other"
        }
    }
}
