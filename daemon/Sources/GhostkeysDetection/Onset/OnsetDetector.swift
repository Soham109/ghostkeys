// Streaming onset (spike) detector for the accelerometer.
//
// Signal chain, per sample:
//   1. One-pole high-pass at 15 Hz on each accel axis. This removes gravity and slow posture changes.
//      The recorded rest data on this Mac shows the resting noise is strongly low-frequency (lag-1
//      autocorrelation 0.98), while finger taps ring at tens to hundreds of Hz, so a real high-pass
//      separates them much better than subtracting a slow gravity average alone.
//   2. Detection level m = magnitude of the high-passed vector (in g).
//   3. Adaptive noise floor: the median of m over the last 2 s, computed robustly as the median of
//      per-block medians (blocks of 40 samples, about 50 ms). A median ignores the spikes themselves,
//      so taps and keystrokes do not inflate the floor, but sustained vibration (typing, a fan, a
//      train) does raise it.
//   4. Trigger when m > max(absoluteFloor, k * noise). k and absoluteFloor come from sensitivity.
//   5. Pulse tracking with hysteresis (half the trigger threshold). A pulse ends after 15 ms quiet.
//      Pulses longer than 120 ms are not taps (the laptop is being moved, bumped or carried).
//   6. Refractory 60 ms from onset and until the previous pulse has ended.
//   7. Burst lockout: 4 onsets within 0.5 s mute detection for 0.4 s (rattling, drumming, typing).

import Foundation

struct OnsetInfo {
    var index: Int          // absolute sample index of the first sample above threshold
    var t: Double
    var threshold: Double   // trigger threshold in g at onset
    var noise: Double       // noise floor (median level) in g at onset
    var burst: Bool         // true if the onset fell in (or started) a burst lockout
}

enum OnsetOutput {
    case onset(OnsetInfo)
    /// The current pulse ended; width in seconds (onset to last sample above the hysteresis level).
    case pulseEnded(width: Double)
    /// The current pulse is still above the hysteresis level 120 ms after onset.
    case pulseTooLong
}

struct OnsetDetector {
    // Tunables (seconds unless noted).
    var sampleRate = 797.0
    var highPassHz = 15.0
    var refractory = 0.060
    var pulseEndQuiet = 0.015
    var maxPulseWidth = 0.120
    var burstCount = 4
    var burstWindow = 0.5
    var burstLockout = 0.4
    var blockSize = 40
    var noiseBlocks = 40               // 40 blocks * 40 samples = 1600 samples = 2 s
    var minBlocksBeforeDetecting = 5   // warm-up, about 0.25 s

    /// 0 (strict) ... 1 (sensitive).
    var sensitivity = 0.5

    // Filter state.
    private var lpX = 0.0, lpY = 0.0, lpZ = 0.0
    private var initialized = false
    private var alpha = 0.0

    // Noise floor state.
    private var block: [Double] = []
    private var blockMedians: [Double] = []
    private var blockMedianCursor = 0
    private(set) var noise = 0.0

    // Pulse state.
    private enum PulseState { case idle, active, overlong }
    private var pulse = PulseState.idle
    private var pulseOnsetT = 0.0
    private var pulseLastAbove = 0.0
    private var pulseHysteresis = 0.0
    private var lastOnsetT = -Double.infinity
    private var recentOnsets: [Double] = []
    private(set) var lockoutUntil = -Double.infinity

    /// Last detection level (g), for diagnostics.
    private(set) var level = 0.0

    var isPulseActive: Bool { pulse != .idle }

    /// Multiplier on the noise floor. Strict: 9x, sensitive: 3x (6x at the default 0.5).
    var noiseMultiplier: Double { 9 - 6 * Stats.clamp(sensitivity, 0, 1) }
    /// Absolute floor in g. Strict: 30 mg, default (0.5): 17.5 mg, sensitive: 5 mg.
    /// On the recorded rest data the median level is ~1.2 mg, so 6x noise would be ~7 mg, but the
    /// same recording has several 12 to 25 mg, ~40 Hz desk wobbles (someone moving nearby). The
    /// floor keeps most of those out; the pulse width limit and the classifier handle the rest.
    var absoluteFloor: Double { (30 - 25 * Stats.clamp(sensitivity, 0, 1)) / 1000 }
    var threshold: Double { max(absoluteFloor, noiseMultiplier * noise) }
    var isWarmedUp: Bool { blockMedians.count >= minBlocksBeforeDetecting }

    mutating func reset() {
        initialized = false
        block.removeAll(keepingCapacity: true)
        blockMedians.removeAll(keepingCapacity: true)
        blockMedianCursor = 0
        noise = 0
        pulse = .idle
        lastOnsetT = -.infinity
        recentOnsets.removeAll()
        lockoutUntil = -.infinity
    }

    mutating func process(ax: Double, ay: Double, az: Double, t: Double, index: Int) -> OnsetOutput? {
        if !initialized {
            lpX = ax; lpY = ay; lpZ = az
            alpha = 1 - exp(-2 * Double.pi * highPassHz / sampleRate)
            initialized = true
            block.reserveCapacity(blockSize)
        }
        lpX += alpha * (ax - lpX); lpY += alpha * (ay - lpY); lpZ += alpha * (az - lpZ)
        let hx = ax - lpX, hy = ay - lpY, hz = az - lpZ
        let m = (hx * hx + hy * hy + hz * hz).squareRoot()
        level = m

        updateNoise(m)

        switch pulse {
        case .active:
            if m > pulseHysteresis { pulseLastAbove = t }
            if t - pulseLastAbove >= pulseEndQuiet {
                pulse = .idle
                return .pulseEnded(width: pulseLastAbove - pulseOnsetT + 1 / sampleRate)
            }
            if t - pulseOnsetT > maxPulseWidth {
                pulse = .overlong
                return .pulseTooLong
            }
            return nil
        case .overlong:
            // Wait for the disturbance to calm down before arming again.
            if m > pulseHysteresis { pulseLastAbove = t }
            if t - pulseLastAbove >= pulseEndQuiet { pulse = .idle }
            return nil
        case .idle:
            break
        }

        guard isWarmedUp else { return nil }
        let thr = threshold
        guard m > thr, t - lastOnsetT >= refractory else { return nil }

        // New onset.
        lastOnsetT = t
        pulse = .active
        pulseOnsetT = t
        pulseLastAbove = t
        pulseHysteresis = 0.5 * thr

        recentOnsets.append(t)
        while let first = recentOnsets.first, t - first > burstWindow { recentOnsets.removeFirst() }
        var burst = t < lockoutUntil
        if recentOnsets.count >= burstCount {
            lockoutUntil = t + burstLockout
            burst = true
        }
        return .onset(OnsetInfo(index: index, t: t, threshold: thr, noise: noise, burst: burst))
    }

    private mutating func updateNoise(_ m: Double) {
        block.append(m)
        guard block.count >= blockSize else { return }
        block.sort()
        let med = block[block.count / 2]
        block.removeAll(keepingCapacity: true)
        if blockMedians.count < noiseBlocks {
            blockMedians.append(med)
        } else {
            blockMedians[blockMedianCursor] = med
            blockMedianCursor = (blockMedianCursor + 1) % noiseBlocks
        }
        noise = Stats.median(blockMedians)
    }
}
