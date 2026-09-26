// Small helpers: the lab's own onset detector (ground-truth counter for recording), terminal control, stats, args.

import Foundation
import Darwin

/// A deliberately simple onset detector: deviation of acceleration from a slow gravity estimate, compared to an
/// adaptive noise floor. It only has to count taps during guided capture and mark their times, so it favors
/// simplicity and predictability over sensitivity to faint taps.
final class LabOnsetDetector {
    var minThreshold = 0.006     // g
    var noiseMultiple = 7.0
    var refractory = 0.18        // s
    private var gravity: SIMD3<Double>?
    private var noise = 0.002
    private var lastT: Double?
    private var firstT: Double?
    /// No onsets for this long after the first sample (sensor wake-up transients); the noise floor still adapts.
    var warmup = 0.5
    private var lastOnset = -1e9
    private var above = false
    private(set) var peak = 0.0

    var threshold: Double { max(minThreshold, noiseMultiple * noise) }
    var noiseFloor: Double { noise }

    /// Returns the onset time when a new tap starts at this sample.
    func ingest(t: Double, a: SIMD3<Double>) -> Double? {
        guard let g = gravity, let lt = lastT else { gravity = a; lastT = t; firstT = t; return nil }
        let warming = t - (firstT ?? t) < warmup
        let dt = min(max(t - lt, 0), 0.05)
        lastT = t
        let dev = (a - g).magnitude
        let alphaG = min(1, dt / 0.4)
        gravity = g + (a - g) * alphaG
        let th = threshold
        var onset: Double?
        if warming {
            noise += (min(dev, 0.004) - noise) * min(1, dt / 0.2)
            return nil
        }
        if dev > th {
            if !above && t - lastOnset > refractory {
                onset = t
                lastOnset = t
                peak = dev
            }
            above = true
            peak = max(peak, dev)
        } else {
            if dev < th * 0.6 { above = false }
            if t - lastOnset > 0.3 {
                // Noise floor: slow EMA of the deviation outside events, clamped so a long quiet spell cannot
                // make the detector hypersensitive.
                noise += (min(dev, th) - noise) * min(1, dt / 2.0)
                noise = max(noise, 0.0003)
            }
        }
        return onset
    }
}

extension SIMD3 where Scalar == Double {
    var magnitude: Double { (self * self).sum().squareRoot() }
}

// MARK: - Terminal

enum Terminal {
    nonisolated(unsafe) private static var saved: termios?
    static let isTTY = isatty(STDIN_FILENO) == 1 && isatty(STDOUT_FILENO) == 1

    static func rawMode() {
        guard isTTY, saved == nil else { return }
        var t = termios()
        tcgetattr(STDIN_FILENO, &t)
        saved = t
        t.c_lflag &= ~tcflag_t(ICANON | ECHO)
        tcsetattr(STDIN_FILENO, TCSANOW, &t)
        print("\u{1B}[?25l", terminator: "")   // hide cursor
        fflush(stdout)
    }

    static func restore() {
        guard var t = saved else { return }
        tcsetattr(STDIN_FILENO, TCSANOW, &t)
        saved = nil
        print("\u{1B}[?25h", terminator: "")
        fflush(stdout)
    }

    /// Non-blocking read of one key, if any.
    static func readKey() -> UInt8? {
        var fds = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        guard poll(&fds, 1, 0) > 0 else { return nil }
        var c: UInt8 = 0
        return read(STDIN_FILENO, &c, 1) == 1 ? c : nil
    }

    static let bold = "\u{1B}[1m", dim = "\u{1B}[2m", reset = "\u{1B}[0m"
    static let green = "\u{1B}[32m", yellow = "\u{1B}[33m", cyan = "\u{1B}[36m", red = "\u{1B}[31m", magenta = "\u{1B}[35m"
    static let clearLine = "\r\u{1B}[2K"

    static func banner(_ lines: [String], color: String = cyan) {
        let width = max(44, (lines.map { $0.count }.max() ?? 0) + 6)
        let bar = String(repeating: "=", count: width)
        print("\n\(color)\(bold)\(bar)\(reset)")
        for l in lines {
            let pad = max(0, width - 6 - l.count)
            print("\(color)\(bold)||  \(l)\(String(repeating: " ", count: pad))  ||\(reset)")
        }
        print("\(color)\(bold)\(bar)\(reset)")
    }
}

// MARK: - Stats

func percentile(_ xs: [Double], _ p: Double) -> Double {
    guard !xs.isEmpty else { return .nan }
    let s = xs.sorted()
    let idx = min(s.count - 1, max(0, Int((p / 100 * Double(s.count - 1)).rounded())))
    return s[idx]
}

func mean(_ xs: [Double]) -> Double { xs.isEmpty ? .nan : xs.reduce(0, +) / Double(xs.count) }

func fmt(_ x: Double, _ digits: Int = 3) -> String {
    x.isNaN ? "-" : String(format: "%.\(digits)f", x)
}

func pad(_ s: String, _ n: Int, left: Bool = false) -> String {
    s.count >= n ? s : (left ? String(repeating: " ", count: n - s.count) + s : s + String(repeating: " ", count: n - s.count))
}

/// Deterministic RNG (SplitMix64) so synth and splits are reproducible.
struct SplitMix: RandomNumberGenerator {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func gaussian() -> Double {
        let u1 = max(Double.random(in: 0..<1, using: &self), 1e-12), u2 = Double.random(in: 0..<1, using: &self)
        return (-2 * log(u1)).squareRoot() * cos(2 * .pi * u2)
    }
}

// MARK: - Args

struct Args {
    var positional: [String] = []
    var options: [String: String] = [:]
    var flags: Set<String> = []

    init(_ argv: [String], flagNames: Set<String>) {
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a.hasPrefix("--") {
                let body = String(a.dropFirst(2))
                if let eq = body.firstIndex(of: "=") {
                    options[String(body[..<eq])] = String(body[body.index(after: eq)...])
                } else if flagNames.contains(body) {
                    flags.insert(body)
                } else if i + 1 < argv.count {
                    options[body] = argv[i + 1]; i += 1
                } else {
                    flags.insert(body)
                }
            } else {
                positional.append(a)
            }
            i += 1
        }
    }

    func double(_ k: String, _ d: Double) throws -> Double {
        guard let s = options[k] else { return d }
        guard let v = Double(s) else { throw LabError("--\(k) expects a number, got \(s)") }
        return v
    }
    func int(_ k: String, _ d: Int) throws -> Int {
        guard let s = options[k] else { return d }
        guard let v = Int(s) else { throw LabError("--\(k) expects an integer, got \(s)") }
        return v
    }
}
