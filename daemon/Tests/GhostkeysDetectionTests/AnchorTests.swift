import Darwin
import Testing
@testable import GhostkeysDetection

/// A tap whose ring builds up before it decays, like real taps on the chassis: the first half cycle is
/// smaller than the rebound. Lighter copies of it must give the same force-independent features.
@Suite struct AnchorTests {
    /// Candidate features of one ringing tap with peak amplitude `amp` (g) on the z axis.
    static func features(amp: Double) -> TapFeatures? {
        let fs = 797.0, f0 = 45.0, tau = 0.03, t0 = 1.0
        let engine = TapEngine(settings: DetectionSettings())
        var rng = SplitMix64(seed: 3)
        var out: TapFeatures?
        for i in 0..<Int(2 * fs) {
            let t = Double(i) / fs
            var z = -1.0
            if t >= t0 {
                let u = t - t0
                z += amp * sin(2 * .pi * f0 * u) * (u / tau) * exp(1 - u / tau)
            }
            let n = { (Double(rng.next() % 2001) / 1000 - 1) * 0.0005 }
            for e in engine.ingest(IMUSample(t: t, a: SIMD3(n(), n(), z + n()), g: SIMD3(n(), n(), n())), context: InputContext()) {
                if case .candidate(let f) = e, out == nil { out = f }
            }
        }
        return out
    }

    /// The light copy's first half cycle stays under the 17.5 mg onset threshold; its window must still
    /// start on that half cycle, not on the rebound.
    @Test func lighterCopyKeepsImpulseDirection() throws {
        let firm = try #require(Self.features(amp: 0.15))
        let light = try #require(Self.features(amp: 0.045))
        #expect(firm[.impulseDirZ] > 0.9, "firm \(firm[.impulseDirZ])")
        #expect(light[.impulseDirZ] > 0.9, "light \(light[.impulseDirZ])")
    }
}
