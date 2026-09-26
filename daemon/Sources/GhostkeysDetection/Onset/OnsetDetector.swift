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
//      train) does raise it. The floor falls fast: it is the lower of the 2 s median and the median
//      of the last 0.5 s. In the first real recording a 2 s burst of handling noise otherwise kept
//      the threshold at 156 mg for two more seconds and hid 60 to 100 mg taps made in 5 mg quiet.
//   4. Trigger when m > max(absoluteFloor, k * noise). k and absoluteFloor come from sensitivity.
//   5. Pulse tracking. The pulse ends after 15 ms below max(half the trigger threshold, 30% of the
//      pulse's own peak). Its width is the time from onset to the last sample at 50% or more of its
//      peak. Widths over 120 ms are not taps (the laptop is being moved, bumped or carried).
//      Measured on the first real recording (laptop on a lap): left-palm taps stay above half their
//      peak for 50 to 90 ms, right-palm 34 to 39 ms, grille 16 to 41 ms, while handling the machine
//      mostly lasts 150 ms or more. A width measured against the (noise-driven) trigger threshold
//      instead made most palm taps "too long" in that recording, because lap noise sat near it.
//   6. Refractory: 60 ms from onset and until the previous pulse has ended. For 300 ms after a pulse
//      ends, a new onset must also be a fresh jump: above twice the highest level of the preceding
//      25 ms. A decaying ring never jumps like that (each swing is lower than the last); a real
//      second tap does. This stops the ringing tail of a hard tap from triggering a second onset.
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
    /// The current pulse ended; width in seconds (onset to the last sample at >= 50% of its peak).
    case pulseEnded(width: Double)
    /// The pulse stayed above half its peak for more than 120 ms (or never settled within 400 ms).
    case pulseTooLong
}

struct OnsetDetector {
    // Tunables (seconds unless noted).
    var sampleRate = 797.0
    var highPassHz = 15.0
    var refractory = 0.060
    var pulseEndQuiet = 0.015
    var maxPulseWidth = 0.120
    var maxPulseSettle = 0.400         // a pulse that has not ended after this is too long regardless
    var tailGuardDuration = 0.300      // ringing tail guard, see header
    var tailJumpFactor = 2.0
    var tailLookback = 20              // samples, about 25 ms
    var burstCount = 4
    var burstWindow = 0.5
    var burstLockout = 0.4
    var blockSize = 40
    var noiseBlocks = 40               // 40 blocks * 40 samples = 1600 samples = 2 s
    var fastNoiseBlocks = 10           // 0.5 s: lets the floor drop quickly after a disturbance
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
    private var pulsePeak = 0.0
    private var pulsePeakT = 0.0
    private var pulseLastAboveHalfPeak = 0.0
    // Last finished pulse, for the ringing-tail guard.
    private var tailGuardUntil = -Double.infinity
    private var recentLevels: [Double] = []
    private var recentCursor = 0
    private var lastLevel = 0.0
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
        tailGuardUntil = -.infinity
        recentLevels.removeAll()
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
        // Levels of the preceding samples (for the tail guard), excluding this one.
        let previousLevel = lastLevel
        lastLevel = m
        if recentLevels.count < tailLookback { recentLevels.append(previousLevel) } else {
            recentLevels[recentCursor] = previousLevel
            recentCursor = (recentCursor + 1) % tailLookback
        }

        switch pulse {
        case .active:
            if m > pulsePeak { pulsePeak = m; pulsePeakT = t }
            if m >= 0.5 * pulsePeak { pulseLastAboveHalfPeak = t }
            if m > max(pulseHysteresis, 0.3 * pulsePeak) { pulseLastAbove = t }
            let width = pulseLastAboveHalfPeak - pulseOnsetT + 1 / sampleRate
            if t - pulseLastAbove >= pulseEndQuiet {
                pulse = .idle
                rememberTail()
                if width > maxPulseWidth { return .pulseTooLong }
                return .pulseEnded(width: width)
            }
            // Decide "too long" as soon as it is certain, so the rejection is not delayed.
            if width > maxPulseWidth || t - pulseOnsetT > maxPulseSettle {
                pulse = .overlong
                return .pulseTooLong
            }
            return nil
        case .overlong:
            // Wait for the disturbance to calm down before arming again.
            if m > max(pulseHysteresis, 0.3 * pulsePeak) { pulseLastAbove = t }
            if t - pulseLastAbove >= pulseEndQuiet {
                pulse = .idle
                rememberTail()
            }
            return nil
        case .idle:
            break
        }

        guard isWarmedUp else { return nil }
        let thr = threshold
        guard m > thr, t - lastOnsetT >= refractory else { return nil }
        // Ringing-tail guard (see header).
        if t < tailGuardUntil {
            guard m > tailJumpFactor * (recentLevels.max() ?? 0) else { return nil }
        }

        // New onset.
        lastOnsetT = t
        pulse = .active
        pulseOnsetT = t
        pulseLastAbove = t
        pulseLastAboveHalfPeak = t
        pulsePeak = m
        pulsePeakT = t
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

    private mutating func rememberTail() {
        tailGuardUntil = pulseLastAbove + tailGuardDuration
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
        // Newest `fastNoiseBlocks` entries (the ring's write position is the oldest once full).
        let n = blockMedians.count
        let newest = blockMedians.count < noiseBlocks ? n : blockMedianCursor + n
        var recent: [Double] = []
        recent.reserveCapacity(fastNoiseBlocks)
        for k in 1...min(fastNoiseBlocks, n) { recent.append(blockMedians[(newest - k) % n]) }
        noise = min(Stats.median(blockMedians), Stats.median(recent))
    }
}
