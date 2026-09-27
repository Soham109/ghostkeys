import Foundation

/// Numbers that arrive in messages or configs. JSON can carry 1e300 (and strings like "inf"), and Swift traps when a
/// non-finite or out-of-range Double is converted to Int, which would kill the daemon. Every message-controlled number
/// that becomes an Int goes through here: non-finite values are refused, finite ones are clamped first.
enum SafeNumbers {
    /// A finite Double, or nil (missing, not a number, NaN or infinite).
    static func finite(_ any: Any?) -> Double? {
        guard let n = any as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    /// Clamps a finite Double into `range` and rounds it; nil when non-finite.
    static func int(_ d: Double, in range: ClosedRange<Int>) -> Int? {
        guard d.isFinite else { return nil }
        let clamped = min(Double(range.upperBound), max(Double(range.lowerBound), d.rounded()))
        return Int(clamped)
    }

    /// A message field as a clamped Int. Missing gives `defaultValue`; present but not a finite number gives nil
    /// (the caller refuses the message).
    static func field(_ any: Any?, in range: ClosedRange<Int>, default defaultValue: Int) -> Int? {
        guard let any else { return defaultValue }
        guard let d = finite(any) else { return nil }
        return int(d, in: range)
    }
}
