// Small statistics and linear algebra helpers. Matrices are row-major flat [Double] of size n*n.

import Foundation

enum Stats {
    static func median(_ values: [Double]) -> Double {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        let m = s.count / 2
        return s.count % 2 == 1 ? s[m] : 0.5 * (s[m - 1] + s[m])
    }

    /// Linear-interpolated quantile, q in 0...1.
    static func quantile(_ values: [Double], _ q: Double) -> Double {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        let pos = min(max(q, 0), 1) * Double(s.count - 1)
        let lo = Int(pos.rounded(.down)), hi = min(lo + 1, s.count - 1)
        let f = pos - Double(lo)
        return s[lo] * (1 - f) + s[hi] * f
    }

    static func clamp(_ x: Double, _ lo: Double, _ hi: Double) -> Double { min(max(x, lo), hi) }
}

/// Deterministic pseudo random generator (SplitMix64) so training splits are reproducible.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

enum LinearAlgebra {
    /// Cholesky factor L (lower triangular, row-major) of a symmetric positive definite matrix.
    /// A tiny ridge is added on failure, so the result is always usable.
    static func cholesky(_ a: [Double], n: Int) -> [Double] {
        var ridge = 0.0
        for _ in 0..<8 {
            var l = [Double](repeating: 0, count: n * n)
            var ok = true
            outer: for i in 0..<n {
                for j in 0...i {
                    var sum = a[i * n + j] + (i == j ? ridge : 0)
                    for k in 0..<j { sum -= l[i * n + k] * l[j * n + k] }
                    if i == j {
                        if sum <= 1e-12 { ok = false; break outer }
                        l[i * n + i] = sum.squareRoot()
                    } else {
                        l[i * n + j] = sum / l[j * n + j]
                    }
                }
            }
            if ok { return l }
            ridge = ridge == 0 ? 1e-6 : ridge * 100
        }
        // Give up gracefully: identity.
        var l = [Double](repeating: 0, count: n * n)
        for i in 0..<n { l[i * n + i] = 1 }
        return l
    }

    /// Solves L y = b for lower triangular L (forward substitution). This is the whitening transform:
    /// if L L^T = Sigma then |L^-1 (x - mu)| is the Mahalanobis distance.
    static func forwardSolve(_ l: [Double], n: Int, _ b: [Double]) -> [Double] {
        var y = [Double](repeating: 0, count: n)
        for i in 0..<n {
            var sum = b[i]
            let row = i * n
            for k in 0..<i { sum -= l[row + k] * y[k] }
            y[i] = sum / l[row + i]
        }
        return y
    }

    static func distance(_ a: [Double], _ b: [Double]) -> Double {
        var s = 0.0
        for i in 0..<min(a.count, b.count) { let d = a[i] - b[i]; s += d * d }
        return s.squareRoot()
    }
}
