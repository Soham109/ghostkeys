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
//   4. Trigger when m > max(floor, k * noise). See "Threshold" below for k and the floor.
//   5. Pulse tracking. The pulse ends after 15 ms below max(half the trigger threshold, 30% of the
//      pulse's own peak). Its width is the time from onset to the last sample at 50% or more of its
//      peak. Widths over 160 ms are not taps (the laptop is being moved, bumped or carried).
//      Measured on the first real recording (laptop on a lap): left-palm taps stay above half their
//      peak for 50 to 90 ms, right-palm 34 to 39 ms, grille 16 to 41 ms, while handling the machine
//      mostly lasts 150 ms or more. The first real calibration then showed right-palm widths bunched
//      just under the old 120 ms limit (median 97, max 119: the rest had been cut off), so the limit
//      is 160 ms; handling pulses in the lab recording were mostly 196 ms or longer.
//      A width measured against the (noise-driven) trigger threshold
//      instead made most palm taps "too long" in that recording, because lap noise sat near it.
//   6. Refractory: 60 ms from onset and until the previous pulse has ended. For 300 ms after a pulse
//      ends, a new onset must also be a fresh jump: above twice the highest level of the 25 ms that
//      ended 25 ms earlier. A decaying ring never jumps like that (each swing is lower than the last);
//      a real second tap does. This stops the ringing tail of a hard tap from triggering a second onset.
//      The window is lagged because real taps ring up over a few samples: measured against the 25 ms
//      just before it, the second tap of a double was compared with its own rising edge and never
//      counted (26 Sep 2026, Mac17,9: 9 of 9 real double taps came out as single taps; the case's
//      rebound 80 to 95 ms after each tap is still rejected, see daemon/analysis/README.md).
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
    /// A much stronger spike started while a weak pulse was still active: the weak pulse is
    /// abandoned (it gets no pulseEnded) and this is the new onset.
    case restart(OnsetInfo)
    /// The pulse stayed above half its peak for more than 160 ms (or never settled within 400 ms).
    case pulseTooLong
}

struct OnsetDetector {
    // Tunables (seconds unless noted).
    var sampleRate = 797.0
    var highPassHz = 15.0
    var refractory = 0.060
    var pulseEndQuiet = 0.015
    var maxPulseWidth = 0.160
    var maxPulseSettle = 0.400         // a pulse that has not ended after this is too long regardless
    var tailGuardDuration = 0.300      // ringing tail guard, see header
    var tailJumpFactor = 2.0
    var tailLookback = 20              // samples, about 25 ms
    var tailLag = 20                   // samples, about 25 ms: skipped so a tap's own ring-up is not its reference
    var restartFactor = 3.0            // a hit this many times the active pulse's peak restarts it
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
    private var recentCursor = 0             // ring position: the oldest entry once recentLevels is full
    private var lastLevel = 0.0
    private var lastOnsetT = -Double.infinity
    private var recentOnsets: [Double] = []
    private(set) var lockoutUntil = -Double.infinity

    /// Last detection level (g), for diagnostics.
    private(set) var level = 0.0

    var isPulseActive: Bool { pulse != .idle }

    // MARK: Threshold
    //
    // threshold = max(k * noise, floor), both scaled by sensitivity (the user's override):
    //   k      = 7 - 4 s               (7 strict, 5 default, 3 sensitive)
    //   floor  = base * 2^(1 - 2 s)    (x2 strict, x1 default, x0.5 sensitive), at least 3 mg, where
    //   base   = the floor learned from this user's calibration taps (ZoneModel.onsetFloor: half the
    //            10th-percentile peak of their gentlest zone, 4 to 17.5 mg), or 17.5 mg without one;
    //            lowered to 6 mg while the machine is quiet (see `quiet`), or during calibration
    //            capture so that gentle calibration taps are captured at all.
    // On a quiet desk (noise ~1.2 mg) the default threshold is then ~6 mg, so 8 to 15 mg fingertip
    // taps trigger. With lap, typing or music noise, k * noise takes over and the threshold rises by
    // itself. The old fixed 17.5 mg floor made users tap very hard; it was set against 12 to 32 mg
    // desk wobbles, which are now left to the classifier (none class, reject distance, gates).

    // Everything below applies only in light-touch mode.
    /// Floor learned at calibration (g), or nil.
    var learnedFloor: Double?
    /// Calibration capture: use the quiet floor regardless of activity.
    var captureMode = false
    /// Set by the engine: no key or trackpad activity in the last second.
    var inputIdle = true
    var defaultFloor = 0.0175
    var quietFloor = 0.006
    var quietNoiseMax = 0.003          // noise must stay under this...
    var quietBlocks = 6                // ...for the last 6 blocks (300 ms)
    private(set) var recentNoiseMax = Double.infinity

    var sensitivityScale: Double { exp2(1 - 2 * Stats.clamp(sensitivity, 0, 1)) }
    var noiseMultiplier: Double { 7 - 4 * Stats.clamp(sensitivity, 0, 1) }
    /// Quiet: the last 300 ms were calm (median of the 50 ms block medians under 3 mg) and no key or
    /// trackpad activity for a second.
    var quiet: Bool { recentNoiseMax < quietNoiseMax && inputIdle }
    var absoluteFloor: Double {
        var base = learnedFloor ?? defaultFloor
        if captureMode || quiet { base = min(base, quietFloor) }
        return max(0.003, base * sensitivityScale)
    }
    var threshold: Double {
        if !lightTouch {   // the fixed-floor rule (default; see DetectionSettings.lightTouch)
            let sv = Stats.clamp(sensitivity, 0, 1)
            return max((30 - 25 * sv) / 1000, (9 - 6 * sv) * noise)
        }
        return max(absoluteFloor, noiseMultiplier * noise)
    }
    /// Light-touch mode: adaptive floor (learned, quiet, capture) and onset restart. When false, the
    /// fixed rule applies: floor 30 - 25 s mg (17.5 at 0.5) and (9 - 6 s) x noise.
    var lightTouch = false
    var isWarmedUp: Bool { blockMedians.count >= minBlocksBeforeDetecting }

    mutating func reset() {
        initialized = false
        block.removeAll(keepingCapacity: true)
        blockMedians.removeAll(keepingCapacity: true)
        blockMedianCursor = 0
        noise = 0
        recentNoiseMax = .infinity
        pulse = .idle
        lastOnsetT = -.infinity
        tailGuardUntil = -.infinity
        recentLevels.removeAll()
        recentCursor = 0
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
        if recentLevels.count < tailLookback + tailLag { recentLevels.append(previousLevel) } else {
            recentLevels[recentCursor] = previousLevel
            recentCursor = (recentCursor + 1) % (tailLookback + tailLag)
        }

        switch pulse {
        case .active:
            // A fresh, much stronger hit inside a weak pulse (a gentle desk wobble just before a
            // real tap): restart the onset at the hit, otherwise the tap is swallowed by the wobble.
            if lightTouch, m > restartFactor * pulsePeak, t - pulseOnsetT >= 0.02, m > threshold,
               m > tailJumpFactor * recentMax() {
                return .restart(startPulse(m: m, t: t, index: index, thr: threshold, burst: false))
            }
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
            guard m > tailJumpFactor * laggedMax() else { return nil }
        }

        // New onset.
        let info = startPulse(m: m, t: t, index: index, thr: thr, burst: false)
        return .onset(info)
    }

    private mutating func startPulse(m: Double, t: Double, index: Int, thr: Double, burst _: Bool) -> OnsetInfo {
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
        return OnsetInfo(index: index, t: t, threshold: thr, noise: noise, burst: burst)
    }

    /// Levels of the preceding samples, oldest first.
    private func previousLevels() -> [Double] {
        recentLevels.count < tailLookback + tailLag ? recentLevels
            : Array(recentLevels[recentCursor...]) + Array(recentLevels[..<recentCursor])
    }
    /// Highest level of the last `tailLookback` samples.
    private func recentMax() -> Double { previousLevels().suffix(tailLookback).max() ?? 0 }
    /// Highest level of the `tailLookback` samples before the last `tailLag` ones.
    private func laggedMax() -> Double { previousLevels().dropLast(tailLag).suffix(tailLookback).max() ?? 0 }

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
        for k in 1...min(max(fastNoiseBlocks, quietBlocks), n) { recent.append(blockMedians[(newest - k) % n]) }
        noise = min(Stats.median(blockMedians), Stats.median(Array(recent.prefix(fastNoiseBlocks))))
        // Median, not max: the taps themselves must not switch quiet mode off.
        recentNoiseMax = n >= quietBlocks ? Stats.median(Array(recent.prefix(quietBlocks))) : .infinity
    }
}
