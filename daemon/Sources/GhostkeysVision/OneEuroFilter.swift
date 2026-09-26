// One Euro filter (Casiez, Roussel, Vogel 2012): a low-pass filter whose cutoff rises with speed,
// so a still hand stops shaking while a fast hand does not lag.
import Foundation

public struct OneEuroFilter: Sendable {
    /// Cutoff (Hz) when the signal is still. Lower means smoother and laggier at rest.
    public var minCutoff: Double
    /// How much the cutoff grows with speed. Higher means less lag on fast motion.
    public var beta: Double
    /// Cutoff (Hz) for the speed estimate itself.
    public var derivativeCutoff: Double

    private var lastValue: Double?
    private var lastDerivative: Double = 0
    private var lastT: TimeInterval?

    public init(minCutoff: Double = 1.0, beta: Double = 0.5, derivativeCutoff: Double = 1.0) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.derivativeCutoff = derivativeCutoff
    }

    private static func alpha(cutoff: Double, dt: Double) -> Double {
        let tau = 1.0 / (2 * Double.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)
    }

    public mutating func reset() {
        lastValue = nil
        lastDerivative = 0
        lastT = nil
    }

    public mutating func filter(_ x: Double, t: TimeInterval) -> Double {
        guard let prev = lastValue, let pt = lastT else {
            lastValue = x
            lastT = t
            return x
        }
        let dt = max(t - pt, 1e-4)
        let dx = (x - prev) / dt
        let aD = Self.alpha(cutoff: derivativeCutoff, dt: dt)
        let dHat = aD * dx + (1 - aD) * lastDerivative
        let cutoff = minCutoff + beta * abs(dHat)
        let a = Self.alpha(cutoff: cutoff, dt: dt)
        let xHat = a * x + (1 - a) * prev
        lastValue = xHat
        lastDerivative = dHat
        lastT = t
        return xHat
    }
}

/// One Euro filters for all 21 joints of one hand (x and y each).
public struct HandSmoother: Sendable {
    private var fx: [OneEuroFilter]
    private var fy: [OneEuroFilter]

    /// Defaults are tuned for normalized image coordinates (0..1) at 5 to 30 fps.
    public init(minCutoff: Double = 1.5, beta: Double = 8.0, derivativeCutoff: Double = 1.0) {
        let f = OneEuroFilter(minCutoff: minCutoff, beta: beta, derivativeCutoff: derivativeCutoff)
        fx = Array(repeating: f, count: HandJoint.count)
        fy = Array(repeating: f, count: HandJoint.count)
    }

    public mutating func reset() {
        for i in 0..<HandJoint.count { fx[i].reset(); fy[i].reset() }
    }

    public mutating func smooth(_ hand: HandLandmarks, t: TimeInterval) -> HandLandmarks {
        var out = hand
        for i in 0..<HandJoint.count {
            // A joint Vision could not see (confidence 0) keeps its raw value and does not disturb the filter.
            guard hand.confidences[i] > 0 else { continue }
            out.points[i] = Point2(fx[i].filter(hand.points[i].x, t: t), fy[i].filter(hand.points[i].y, t: t))
        }
        return out
    }
}
