// SonarField: in-air gestures without a camera, from two inaudible pilot tones (one per speaker group).
//
// Each pilot is tracked two ways on the single (beamformed, mono) microphone channel:
//  (a) Doppler band analysis: how far the pilot's spectral peak widens left/right (as SoundWave, CHI 2012);
//  (b) phase tracking (after LLAP, MobiCom 2016): I/Q demodulate the pilot, low-pass and decimate, remove the static
//      part (direct path and still objects), and integrate the phase change of what is left (the moving hand) into a
//      relative path-length change: path change = -dphi * lambda / (2 pi).
// Separating the pilots by frequency: both sit on a 750 Hz grid (48 kHz / 64). Averaging 64-sample blocks nulls
// every multiple of 750 Hz, so when one pilot is demodulated the other lands exactly on a null.
import Accelerate
import Foundation

public struct SonarFieldConfig: Codable, Equatable, Sendable {
    public static let defaultLeftPilotHz: Double = 19_500
    public static let defaultRightPilotHz: Double = 20_250

    public var sampleRate: Double = GhostkeysAcousticsInfo.sampleRate
    /// Left channel pilot (snapped to the demodulation grid). 19.5 kHz is FFT bin 1664 at 4096 points.
    public var leftPilotHz: Double = SonarFieldConfig.defaultLeftPilotHz
    /// Right channel pilot. 20.25 kHz is FFT bin 1728.
    public var rightPilotHz: Double = SonarFieldConfig.defaultRightPilotHz
    /// Length of each of the three cascaded averages in the demodulation filter. 64 puts exact nulls on every
    /// multiple of 750 Hz, where the other pilot sits.
    public var decimation: Int = 64
    /// Samples between baseband outputs. 32 gives a 1500 Hz baseband: phase steps stay under 1 rad up to about
    /// 4 m/s of path change (a fast swipe).
    public var outputHop: Int = 32
    public var fftSize: Int = 4096
    public var hopSize: Int = 1024
    public var speedOfSound: Double = 343

    /// Static-component tracker time constant, seconds. Anything that stops moving fades into "static" this fast.
    public var staticTimeConstant: Double = 0.3
    /// The moving part must be at least this strong relative to the static part to be tracked, dB.
    public var dynamicGateDb: Double = -65
    /// ...and this many times the baseband noise power.
    public var noiseGateFactor: Double = 6
    /// Baseband samples are held this long so an impulse (key click) can also void the samples just before it.
    public var processingDelay: Double = 0.02
    /// Residual (non-pilot) ultrasonic energy jump that marks an impulse, dB above its floor.
    public var impulseDb: Double = 12
    /// Seconds after start used only to settle the static and drift trackers.
    public var warmup: Double = 0.4

    /// Path speed (either side) that counts as motion, mm/s.
    public var movingSpeedMmPerSec: Double = 40
    public var velocityWindow: Double = 0.05
    /// An episode ends after this long without motion (0.6 s while a hover slider is active).
    public var idleEnd: Double = 0.3
    public var hoverIdleEnd: Double = 0.6
    /// hover_level begins only after this much continuous motion (quick moves are push/pull/sweep instead).
    public var hoverDelay: Double = 0.5
    /// Common-mode (both sides together) movement must exceed this multiple of differential movement for a hover.
    public var hoverDominance: Double = 1.7
    public var hoverMinPathMm: Double = 10
    /// Hand displacement that maps to value 1.0.
    public var hoverRangeMm: Double = 150
    public var hoverStepMm: Double = 1
    public var pushMinPathMm: Double = 30
    public var pushMaxDuration: Double = 0.45
    public var pushDominance: Double = 1.5
    public var sweepMinDiffMm: Double = 60
    public var sweepDominance: Double = 1.5
    public var sweepMaxDuration: Double = 1.5
    /// Minimum finger travel estimate for a slide, mm.
    public var slideMinMm: Double = 3
    /// Finger travel that maps to value 1.0.
    public var slideRangeMm: Double = 40

    /// Pilot must stand this far above the local noise, dB.
    public var minPilotSnrDb: Double = 25
    /// Narrow peaks near the pilots within this many dB of the weaker pilot mean music or another ultrasonic source.
    public var tonalInterferenceDb: Double = 45
    /// A peak counts as narrow when this far above the guard band's median, dB.
    public var tonalPeakOverMedianDb: Double = 15
    /// Broadband noise near the pilots within this many dB of the weaker pilot also counts as interference.
    public var broadbandInterferenceDb: Double = 25
    /// Bins around each pilot left out of the interference check (they hold the hand's own Doppler echoes).
    public var guardExclusionBins: Int = 30
    public var guardSpanBins: Int = 60
    /// How long detection stays suppressed after interference is last seen, seconds.
    public var interferenceHold: Double = 0.5

    public init() {}

    public var basebandRate: Double { sampleRate / Double(outputHop) }
    /// Nearest frequency on the grid (multiples of sampleRate / decimation) where demodulation nulls the other pilot
    /// and FFT bins line up.
    public func snapped(_ hz: Double) -> Double {
        let grid = sampleRate / Double(decimation)
        return (hz / grid).rounded() * grid
    }
}

public struct SonarFieldSideStatus: Equatable, Sendable {
    public var pilotDb: Float = -200
    public var noiseDb: Float = -200
    public var pilotPresent = false
    /// Accumulated relative path-length change since start, mm (negative = the hand got closer overall).
    public var pathMm: Double = 0
    /// Moving part relative to the static part, dB.
    public var dynamicDb: Float = -200
    /// Doppler widening beyond rest, in FFT bins (11.7 Hz each).
    public var dopplerLeftShift: Double = 0
    public var dopplerRightShift: Double = 0
}

public struct SonarFieldStatus: Equatable, Sendable {
    public var time: Double = 0
    public var left = SonarFieldSideStatus()
    public var right = SonarFieldSideStatus()
    public var interference = false
    public var suppressed = false
    public var warmedUp = false
    /// Both pilots present, warmed up, nothing suppressing detection.
    public var ready: Bool { warmedUp && left.pilotPresent && right.pilotPresent && !interference && !suppressed }
}

/// Numbers for tuning on real hardware, accumulated between `debugSnapshot()` calls (the daemon asks ~10 times a
/// second and sends them as `sonar_debug`). Levels in dBFS use the 4096-point Hann FFT: a full-scale sine is 0 dBFS;
/// noise is per FFT bin (11.7 Hz), reported as the sine level that would give the median bin power near the pilot.
public struct SonarFieldDebug: Sendable {
    public struct Side: Sendable {
        public var frequencyHz: Double = 0
        /// Pilot as received at the mic.
        public var pilotDbfs: Double = -200
        /// Median bin 28 to 40 bins from the pilot.
        public var noiseDbfsPerBin: Double = -200
        public var snrDb: Double = 0
        public var pilotPresent = false
        /// Strongest energy below / above the pilot (bins 2 to 26 away), relative to the pilot, dB. Motion raises it.
        public var sidebandLowDbc: Double = -200
        public var sidebandHighDbc: Double = -200
        /// Doppler widening beyond rest, bins, latest frame (negative side = away, positive = toward).
        public var dopplerLeftShiftBins: Double = 0
        public var dopplerRightShiftBins: Double = 0
        /// Phase tracker: path change over the window, mm, and the variance of its per-sample increments, mm^2.
        public var pathDeltaMm: Double = 0
        public var pathStepVarianceMm2: Double = 0
        public var pathTotalMm: Double = 0
        /// Moving part relative to the static part, dB.
        public var dynamicDb: Double = -200
        /// Share of baseband samples in the window with the tracking gate open (0...1).
        public var gateOpenShare: Double = 0
    }
    public var windowSeconds: Double = 0
    public var left = Side()
    public var right = Side()
    public var warmedUp = false
    /// Detection suppressed by interference near the pilots, and why ("tonal" peaks or "broadband" noise).
    public var interference = false
    public var interferenceReason: String?
    /// Strongest and median guard-band bin near the pilots (echo zones excluded), dBFS.
    public var guardPeakDbfs: Double = -200
    public var guardMedianDbfs: Double = -200
    /// `suppress(until:)` from the daemon (typing gate, IMU motion) is active.
    public var suppressedByDaemon = false
    /// Both pilots present, warmed up, nothing suppressing: gestures can fire.
    public var ready = false
    /// Median bin level at 21.5 to 23.5 kHz minus 14 to 16 kHz, dB. A strongly negative value (below about -30)
    /// means the input path low-passes before 20 kHz.
    public var highBandRolloffDb: Double = 0
    public var impulseBlocks = 0
    public var basebandSamples = 0
    /// Times the analysis restarted because audio chunk times jumped (gaps over 10 ms). Should stay 0.
    public var restarts = 0
    public var episodeActive = false
    public var hoverActive = false
    public var slideActive = false
}

public enum SonarFieldEvent: Equatable, Sendable {
    case air(AcousticAirEvent)
    case gesture(AcousticGesture)
    /// Raw per-side Doppler result (diagnostics; push/pull use it as corroboration).
    case doppler(side: SpeakerSide, SonarWaveEvent)
}

struct Cx {
    var re: Double
    var im: Double
    static func + (a: Cx, b: Cx) -> Cx { Cx(re: a.re + b.re, im: a.im + b.im) }
    static func - (a: Cx, b: Cx) -> Cx { Cx(re: a.re - b.re, im: a.im - b.im) }
    static func * (a: Cx, b: Cx) -> Cx { Cx(re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re) }
    static func * (a: Cx, s: Double) -> Cx { Cx(re: a.re * s, im: a.im * s) }
    var conj: Cx { Cx(re: re, im: -im) }
    var norm2: Double { re * re + im * im }
    var arg: Double { atan2(im, re) }
}

/// Phase tracker for one pilot's baseband signal: drift correction, static removal, phase integration.
final class PhaseSideTracker {
    let wavelengthMm: Double
    private let alpha: Double
    private let driftRateWarm: Double
    private let driftRate: Double
    private let activityThreshold: Double
    private let maxGapBlocks: Int
    private let gateRel: Double
    private let noiseFactor: Double
    private var rawPrev: Cx?
    private var rotation = Cx(re: 0, im: 0)
    private var derotation = Cx(re: 1, im: 0)
    private var staticPart: Cx?
    private var previous: Cx?
    private var noise: Double?
    private var lastDynamic: Cx?
    private var gapBlocks = 0
    /// Smoothed |phase change| per baseband sample of the moving part.
    private var activity = 0.0
    private(set) var pathMm = 0.0
    private(set) var dynamicRatio = 0.0
    /// Diagnostics for the last sample: path increment (mm) and whether the tracking gate was open.
    private(set) var lastStepMm = 0.0
    private(set) var gateOpen = false

    init(frequency: Double, config: SonarFieldConfig) {
        wavelengthMm = config.speedOfSound / frequency * 1000
        alpha = 1 / (config.staticTimeConstant * config.basebandRate)
        let perSecond = config.basebandRate
        driftRateWarm = 37.5 / perSecond      // about 27 ms time constant while warming up
        driftRate = 1.5 / perSecond           // about 0.7 s afterwards
        activityThreshold = 7.5 / perSecond   // 7.5 rad/s of phase change counts as motion
        maxGapBlocks = Int(0.04 * perSecond)
        gateRel = pow(10, config.dynamicGateDb / 10)
        noiseFactor = config.noiseGateFactor
    }

    func step(_ z: Cx, bad: Bool, integrate: Bool, warm: Bool) {
        lastStepMm = 0
        if bad { gateOpen = false; return } // an impulse: keep all state, bridge the phase across the gap
        // Drift: a clock offset between speaker and mic makes everything, including the static part, rotate slowly.
        // Estimate that rotation from the raw signal (dominated by the static part) and undo it. Learn it only while
        // nothing moves: the static part is ~25 dB above an echo, so even a small bias picked up from a moving echo
        // would leak more static signal into the moving part than the echo itself.
        if let p = rawPrev, warm || activity < activityThreshold { rotation = rotation + (z * p.conj - rotation) * (warm ? driftRateWarm : driftRate) }
        rawPrev = z
        let rn = rotation.norm2
        if rn > 0 {
            derotation = derotation * rotation.conj * (1 / rn.squareRoot())
            derotation = derotation * (1 / derotation.norm2.squareRoot())
        }
        let zc = z * derotation
        guard let s = staticPart, let prev = previous else { staticPart = zc; previous = zc; return }
        // Baseband noise: half the squared sample-to-sample difference. For white noise that equals the noise power,
        // and the moving part is about as big as the difference. For a real echo rotating by dphi per sample the
        // moving part is much bigger (ratio 2 / dphi^2), so the estimate may only rise when the ratio says "noise";
        // otherwise fast motion would lift the floor and close the gate mid-gesture.
        let e = (zc - prev).norm2 / 2
        previous = zc
        let d = zc - s
        if let n = noise {
            if e < n { noise = n + 0.1 * (e - n) } else if d.norm2 < 4 * e { noise = n * 1.002 }
        } else { noise = e }
        staticPart = s + (zc - s) * alpha
        let sp = staticPart!.norm2
        dynamicRatio = sp > 0 ? d.norm2 / sp : 0
        gateOpen = d.norm2 > max(gateRel * sp, noiseFactor * noise!)
        if gateOpen {
            if let last = lastDynamic {
                let dphi = (d * last.conj).arg
                activity += 0.05 * (abs(dphi) - activity)
                if integrate {
                    lastStepMm = -dphi * wavelengthMm / (2 * Double.pi)
                    pathMm += lastStepMm
                }
            }
            lastDynamic = d
            gapBlocks = 0
        } else {
            activity *= 0.95
            gapBlocks += 1
            if gapBlocks > maxGapBlocks { lastDynamic = nil }
        }
    }
}

/// Streaming SonarField analysis. Feed mono microphone audio (48 kHz) while `StereoPilotGenerator` plays; not thread
/// safe. Contact (from `FrictionDetector`) and suppression (typing, IMU motion) come in through the `note...` calls.
public final class SonarField {
    public let config: SonarFieldConfig
    public private(set) var status = SonarFieldStatus()

    private let sr: Double
    private let n: Int
    private let leftHz: Double, rightHz: Double
    /// Demodulation tables: third-order CIC low-pass kernel (three cascaded 64-sample averages, 190 taps) times the
    /// pilot's complex oscillator. Plain block averaging only nulls exact multiples of 750 Hz; the other pilot's
    /// Doppler-shifted echoes sit next to those nulls and would alias onto the same baseband offset as a real echo.
    private let kernelLength: Int
    private let kCosL: [Float], kSinL: [Float], kCosR: [Float], kSinR: [Float]
    private var history: [Float]
    private var block: [Float]
    /// Band-passed copy of `block` for the impulse detector (filtered once per chunk).
    private var filteredBlock: [Float]
    private var chunkFiltered: [Float] = []
    /// The oscillator tables restart at every output; when a hop is not a whole number of pilot cycles, this
    /// per-output rotation puts the reference phase back.
    private let hopRotationL: Cx, hopRotationR: Cx
    private var correctionL = Cx(re: 1, im: 0), correctionR = Cx(re: 1, im: 0)
    private var residual: [Float]
    private var blockFill = 0
    private let residualFilter: BiquadFilter
    private var residualFloor: Double?
    private var leftTracker: PhaseSideTracker
    private var rightTracker: PhaseSideTracker
    private struct Pending { var t: Double; var zL: Cx; var zR: Cx; var bad: Bool }
    private var pending: [Pending] = []
    private var blockIndex = 0
    private var badUntil = -1
    private let delayBlocks: Int
    private var hT: [Double] = [], hL: [Double] = [], hR: [Double] = []
    private var sinceEval = 0
    private let fft: RealFFT
    private let framer: SlidingFramer
    private let window: [Float]
    private var power: [Float]
    private let dopplerL: DopplerBandTracker
    private let dopplerR: DopplerBandTracker
    private let binL: Int, binR: Int
    private let guardExclusion: Int, guardSpan: Int
    private let evalEvery: Int
    private let historyKeep: Int
    private let impulseFactor: Double
    private let warmupSeconds: Double
    private var interferenceUntil = -Double.infinity
    private var suppressedUntil = -Double.infinity
    private var firstTime: Double?
    private var expectedNextTime: Double?
    private var recentDoppler: [(side: SpeakerSide, event: SonarWaveEvent)] = []

    private struct Episode {
        var start: Double
        var startL: Double
        var startR: Double
        var lastMoving: Double
        var maxAbsCommon = 0.0
        var tainted = false
        var contact = false
        var hover: Hover?
        var hoverEnded = false
    }
    private struct Hover {
        var side: SpeakerSide
        var startPath: Double
        var lastReported: Double
        var lastTime: Double
    }
    private struct Slide {
        var start: Double
        var lastDx = 0.0
        var lastDy = 0.0
        var lastTime: Double
    }
    private struct DebugAccumulator {
        var pathStart: Double?
        var sum = 0.0, sumSq = 0.0, count = 0, gateOpen = 0
        var sideLow = -200.0, sideHigh = -200.0
    }
    private var dbgL = DebugAccumulator(), dbgR = DebugAccumulator()
    private var dbgImpulses = 0, dbgRestarts = 0, dbgFrames = 0
    private var dbgWindowStart: Double?
    private var dbgGuardPeak = -200.0, dbgGuardMedian = -200.0, dbgRolloff = 0.0
    private var dbgInterferenceReason: String?
    private var lastStatusTime = 0.0
    /// dB offset from Hann-FFT bin power to the dBFS of a sine (a full-scale sine gives (N/4)^2).
    private lazy var binToDbfs: Double = -20 * log10(Double(config.fftSize) / 4)

    private var episode: Episode?
    private var contacts: [(start: Double, end: Double?)] = []
    private var slide: Slide?

    public init(config: SonarFieldConfig = .init()) {
        var c = config
        c.leftPilotHz = config.snapped(config.leftPilotHz)
        c.rightPilotHz = config.snapped(config.rightPilotHz)
        precondition(c.leftPilotHz != c.rightPilotHz, "the two pilots must differ")
        self.config = c
        sr = c.sampleRate
        n = c.outputHop
        precondition(c.outputHop > 0 && c.outputHop <= 3 * c.decimation)
        func hopRotation(_ f: Double) -> Cx {
            let a = -2 * Double.pi * f * Double(c.outputHop) / c.sampleRate
            return Cx(re: cos(a), im: sin(a))
        }
        hopRotationL = hopRotation(c.leftPilotHz)
        hopRotationR = hopRotation(c.rightPilotHz)
        leftHz = c.leftPilotHz
        rightHz = c.rightPilotHz
        let box = [Double](repeating: 1, count: c.decimation)
        var kernel = box
        for _ in 0..<2 {
            var next = [Double](repeating: 0, count: kernel.count + box.count - 1)
            for i in kernel.indices { for j in box.indices { next[i + j] += kernel[i] * box[j] } }
            kernel = next
        }
        let total = kernel.reduce(0, +)
        let length = 3 * c.decimation
        kernelLength = length
        let h = kernel.map { $0 / total } + [Double](repeating: 0, count: length - kernel.count)
        // history[i] holds sample (blockEnd - L + i); pair it with h[L - 1 - i] and the oscillator at offset i.
        func kTable(_ f: Double, _ fn: (Double) -> Double) -> [Float] {
            (0..<length).map { i in Float(2 * h[length - 1 - i] * fn(2 * Double.pi * f * Double(i) / c.sampleRate)) }
        }
        kCosL = kTable(c.leftPilotHz, cos); kSinL = kTable(c.leftPilotHz, sin)
        kCosR = kTable(c.rightPilotHz, cos); kSinR = kTable(c.rightPilotHz, sin)
        history = [Float](repeating: 0, count: length)
        block = [Float](repeating: 0, count: n)
        filteredBlock = [Float](repeating: 0, count: n)
        residual = [Float](repeating: 0, count: n)
        let guardHz = min(c.leftPilotHz, c.rightPilotHz) - 2_000
        residualFilter = BiquadFilter(coefficients: BiquadFilter.bandpass(center: guardHz, q: 8, sampleRate: c.sampleRate)
                                      + BiquadFilter.bandpass(center: guardHz, q: 8, sampleRate: c.sampleRate))
        leftTracker = PhaseSideTracker(frequency: c.leftPilotHz, config: c)
        rightTracker = PhaseSideTracker(frequency: c.rightPilotHz, config: c)
        delayBlocks = max(1, Int(c.processingDelay * c.basebandRate))
        fft = RealFFT(size: c.fftSize)
        framer = SlidingFramer(frameSize: c.fftSize, hop: c.hopSize)
        window = DSPMath.periodicHann(c.fftSize)
        power = [Float](repeating: 0, count: fft.bins)
        func doppler(_ f: Double) -> DopplerBandTracker {
            var s = SonarConfig()
            s.sampleRate = c.sampleRate; s.fftSize = c.fftSize; s.hopSize = c.hopSize; s.pilotHz = f
            s.maxScanBins = 26
            s.noiseReferenceBins = 28...40
            return DopplerBandTracker(config: s)
        }
        dopplerL = doppler(leftHz)
        dopplerR = doppler(rightHz)
        let binHz = c.sampleRate / Double(c.fftSize)
        binL = Int((leftHz / binHz).rounded())
        binR = Int((rightHz / binHz).rounded())
        guardExclusion = c.guardExclusionBins
        guardSpan = c.guardSpanBins
        evalEvery = max(1, Int(c.basebandRate / 100))
        historyKeep = Int(4 * c.basebandRate)
        impulseFactor = pow(10, c.impulseDb / 10)
        warmupSeconds = c.warmup
    }

    public var pilotFrequencies: (left: Double, right: Double) { (leftHz, rightHz) }

    public func reset() {
        blockFill = 0
        correctionL = Cx(re: 1, im: 0); correctionR = Cx(re: 1, im: 0)
        for i in history.indices { history[i] = 0 }
        residualFilter.reset()
        residualFloor = nil
        pending.removeAll()
        blockIndex = 0; badUntil = -1
        hT.removeAll(); hL.removeAll(); hR.removeAll()
        sinceEval = 0
        framer.reset()
        dopplerL.reset(); dopplerR.reset()
        interferenceUntil = -.infinity
        suppressedUntil = -.infinity
        firstTime = nil
        expectedNextTime = nil
        recentDoppler.removeAll()
        episode = nil
        contacts.removeAll()
        slide = nil
        status = SonarFieldStatus()
        leftTracker = PhaseSideTracker(frequency: leftHz, config: config)
        rightTracker = PhaseSideTracker(frequency: rightHz, config: config)
    }

    // MARK: Inputs from the rest of the daemon

    /// Suppress gestures until `time` (typing gate, IMU motion or bump, paused). Active gestures end as cancelled.
    public func suppress(until time: Double) { suppressedUntil = max(suppressedUntil, time) }

    /// Finger contact began (the friction detector's rub start). Starts a finger_slide.
    public func noteContactBegan(at time: Double) -> [SonarFieldEvent] {
        contacts.append((time, nil))
        episode?.contact = true
        guard slide == nil else { return [] }
        slide = Slide(start: time, lastTime: time)
        let (dx, dy) = slideDelta(from: time, to: hT.last ?? time)
        slide!.lastDx = dx; slide!.lastDy = dy
        return [.air(slideEvent(.began, time: hT.last ?? time, dx: dx, dy: dy))]
    }

    /// Contact ended with an accepted rub from `start` to `end`: finishes the slide and classifies its direction.
    public func noteContactEnded(start: Double, end: Double) -> [SonarFieldEvent] {
        closeContact(end)
        var out: [SonarFieldEvent] = []
        let (dx, dy) = slideDelta(from: start, to: end)
        let suppressed = isSuppressed(during: start, end)
        if slide != nil { out.append(.air(slideEvent(.ended, time: end, dx: dx, dy: dy, cancelled: suppressed))) }
        slide = nil
        guard !suppressed, max(abs(dx), abs(dy)) >= config.slideMinMm else { return out }
        let kind: AcousticGestureKind = abs(dx) > abs(dy) ? (dx > 0 ? .fingerSlideRight : .fingerSlideLeft)
                                                         : (dy > 0 ? .fingerSlideUp : .fingerSlideDown)
        let travel = max(abs(dx), abs(dy))
        let ratio = max(abs(dx), abs(dy)) / max(1e-6, abs(dx) + abs(dy))
        out.append(.gesture(AcousticGesture(kind: kind, time: end, confidence: min(1, ratio * min(1, travel / (3 * config.slideMinMm))),
                                            duration: end - start, side: sideOfLargerChange(from: start, to: end),
                                            distanceMm: travel)))
        return out
    }

    /// Contact ended without an accepted rub.
    public func noteContactCancelled(at time: Double) -> [SonarFieldEvent] {
        closeContact(time)
        guard slide != nil else { return [] }
        let (dx, dy) = slideDelta(from: slide!.start, to: time)
        slide = nil
        return [.air(slideEvent(.ended, time: time, dx: dx, dy: dy, cancelled: true))]
    }

    private func closeContact(_ time: Double) {
        if let i = contacts.lastIndex(where: { $0.end == nil }) { contacts[i].end = time }
        contacts.removeAll { ($0.end ?? .infinity) < time - 5 }
    }

    // MARK: Audio

    public func process(_ samples: [Float], time: Double) -> [SonarFieldEvent] {
        samples.withUnsafeBufferPointer { process($0, time: time) }
    }

    public func process(_ samples: UnsafeBufferPointer<Float>, time: Double) -> [SonarFieldEvent] {
        guard let x = samples.baseAddress, !samples.isEmpty else { return [] }
        if let expected = expectedNextTime, abs(expected - time) > 0.01 { reset(); dbgRestarts += 1 }
        expectedNextTime = time + Double(samples.count) / sr
        if firstTime == nil { firstTime = time }
        var events: [SonarFieldEvent] = []
        let half = Double(config.fftSize) / 2 / sr
        framer.push(samples, time: time, sampleRate: sr) { frame, end in analyzeSpectrum(frame, t: end - half, events: &events) }
        var i = 0
        let count = samples.count
        if chunkFiltered.count < count { chunkFiltered = [Float](repeating: 0, count: count) }
        chunkFiltered.withUnsafeMutableBufferPointer { residualFilter.process(x, $0.baseAddress!, count: count) }
        while i < count {
            let take = min(n - blockFill, count - i)
            block.withUnsafeMutableBufferPointer { b in (b.baseAddress! + blockFill).update(from: x + i, count: take) }
            filteredBlock.withUnsafeMutableBufferPointer { b in
                chunkFiltered.withUnsafeBufferPointer { (b.baseAddress! + blockFill).update(from: $0.baseAddress! + i, count: take) }
            }
            blockFill += take
            i += take
            if blockFill == n {
                blockFill = 0
                processBlock(center: time + Double(i) / sr - Double(n) / 2 / sr, events: &events)
            }
        }
        return events
    }

    private func demodulate(_ h: UnsafePointer<Float>, _ c: [Float], _ s: [Float]) -> Cx {
        let i = c.withUnsafeBufferPointer { Double(DSPMath.dot(h, $0.baseAddress!, kernelLength)) }
        let q = s.withUnsafeBufferPointer { Double(DSPMath.dot(h, $0.baseAddress!, kernelLength)) }
        return Cx(re: i, im: -q)
    }

    private func processBlock(center t: Double, events: inout [SonarFieldEvent]) {
        var zL = Cx(re: 0, im: 0), zR = Cx(re: 0, im: 0)
        var e: Double = 0
        history.withUnsafeMutableBufferPointer { hp in
            let h = hp.baseAddress!
            h.update(from: h + n, count: kernelLength - n)
            block.withUnsafeBufferPointer { (h + kernelLength - n).update(from: $0.baseAddress!, count: n) }
            zL = demodulate(h, kCosL, kSinL) * correctionL
            zR = demodulate(h, kCosR, kSinR) * correctionR
        }
        correctionL = correctionL * hopRotationL
        correctionR = correctionR * hopRotationR
        let normL = correctionL.norm2.squareRoot(), normR = correctionR.norm2.squareRoot()
        correctionL = correctionL * (1 / normL); correctionR = correctionR * (1 / normR)
        // Impulse detector: energy in a band below the pilots and their echoes (about 16.5 to 18.5 kHz). Key clicks
        // and knocks are broadband and light it up; steady pilots and moving echoes barely touch it.
        filteredBlock.withUnsafeBufferPointer { e = Double(DSPMath.meanSquare($0.baseAddress!, n)) }
        var impulse = false
        if let floor = residualFloor {
            impulse = e > floor * impulseFactor && e > 1e-13
            if !impulse { residualFloor = e < floor ? floor + 0.05 * (e - floor) : floor * 1.0003 }
        } else {
            residualFloor = e
        }
        if impulse {
            dbgImpulses += 1
            badUntil = blockIndex + Int(0.008 * config.basebandRate)
            for k in max(0, pending.count - Int(0.004 * config.basebandRate))..<pending.count { pending[k].bad = true }
        }
        pending.append(Pending(t: t, zL: zL, zR: zR, bad: blockIndex <= badUntil))
        blockIndex += 1
        if pending.count > delayBlocks {
            let ready = pending.count - delayBlocks
            for k in 0..<ready { integrate(pending[k], events: &events) }
            pending.removeFirst(ready)
        }
    }

    private func integrate(_ p: Pending, events: inout [SonarFieldEvent]) {
        let warm = p.t - (firstTime ?? p.t) < warmupSeconds
        leftTracker.step(p.zL, bad: p.bad, integrate: !warm, warm: warm)
        rightTracker.step(p.zR, bad: p.bad, integrate: !warm, warm: warm)
        status.time = p.t
        status.warmedUp = !warm
        status.left.pathMm = leftTracker.pathMm
        status.right.pathMm = rightTracker.pathMm
        lastStatusTime = p.t
        func acc(_ a: inout DebugAccumulator, _ tr: PhaseSideTracker) {
            if a.pathStart == nil { a.pathStart = tr.pathMm }
            a.sum += tr.lastStepMm; a.sumSq += tr.lastStepMm * tr.lastStepMm; a.count += 1
            if tr.gateOpen { a.gateOpen += 1 }
        }
        acc(&dbgL, leftTracker); acc(&dbgR, rightTracker)
        guard !warm else { return }
        hT.append(p.t); hL.append(leftTracker.pathMm); hR.append(rightTracker.pathMm)
        let keep = historyKeep
        if hT.count > 2 * keep {
            let drop = hT.count - keep
            hT.removeFirst(drop); hL.removeFirst(drop); hR.removeFirst(drop)
        }
        sinceEval += 1
        if sinceEval >= evalEvery {
            sinceEval = 0
            evaluate(t: p.t, events: &events)
        }
    }

    // MARK: Spectrum: per-side Doppler, pilot presence, interference

    private func analyzeSpectrum(_ frame: UnsafePointer<Float>, t: Double, events: inout [SonarFieldEvent]) {
        window.withUnsafeBufferPointer { w in
            power.withUnsafeMutableBufferPointer { pp in
                let p = pp.baseAddress!
                fft.powerSpectrum(frame, count: config.fftSize, window: w.baseAddress!, into: p)
                func side(_ side: SpeakerSide, _ tracker: DopplerBandTracker, _ s: inout SonarFieldSideStatus) {
                    if let e = tracker.analyze(p, time: t) {
                        events.append(.doppler(side: side, e))
                        recentDoppler.append((side, e))
                    }
                    if let f = tracker.lastFrame {
                        s.pilotDb = f.pilotDb; s.noiseDb = f.noiseDb; s.pilotPresent = f.pilotPresent
                        s.dopplerLeftShift = f.leftShift; s.dopplerRightShift = f.rightShift
                    }
                }
                side(.left, dopplerL, &status.left)
                side(.right, dopplerR, &status.right)
                // Diagnostics: sideband energy per side, and (every 10th frame) the input's high-band rolloff.
                func sidebands(_ bin: Int, _ a: inout DebugAccumulator) {
                    let pilot = Double(max(p[bin], 1e-20))
                    var lo: Float = 0, hi: Float = 0
                    var k = 2
                    while k <= 26 { lo += p[bin - k]; hi += p[bin + k]; k += 1 }
                    a.sideLow = max(a.sideLow, 10 * log10(max(Double(lo), 1e-20) / pilot))
                    a.sideHigh = max(a.sideHigh, 10 * log10(max(Double(hi), 1e-20) / pilot))
                }
                sidebands(binL, &dbgL); sidebands(binR, &dbgR)
                dbgFrames += 1
                if dbgFrames % 10 == 1 {
                    let binHz = sr / Double(config.fftSize)
                    func band(_ a: Double, _ b: Double) -> Double {
                        let lo = Int(a / binHz), hi = min(fft.bins - 1, Int(b / binHz))
                        guard hi > lo else { return -200 }
                        return Double(DSPMath.db(DSPMath.median(Array(UnsafeBufferPointer(start: p + lo, count: hi - lo)))))
                    }
                    dbgRolloff = band(21_500, 23_500) - band(14_000, 16_000)
                }
                if let first = recentDoppler.first, first.event.time < t - 2 { recentDoppler.removeAll { $0.event.time < t - 2 } }
                // Interference: narrow peaks or loud broadband noise near the pilots, outside the echo zones.
                let excl = guardExclusion, bl = binL, br = binR
                let lo = max(1, bl - guardSpan), hi = min(fft.bins - 1, br + guardSpan)
                var guardBins: [Float] = []
                guardBins.reserveCapacity(hi - lo + 1)
                var k = lo
                while k <= hi {
                    if abs(k - bl) > excl && abs(k - br) > excl { guardBins.append(p[k]) }
                    k += 1
                }
                guard !guardBins.isEmpty else { return }
                let pilotDb = Double(min(DSPMath.db(p[binL]), DSPMath.db(p[binR])))
                let peakDb = Double(DSPMath.db(guardBins.max()!))
                let medianDb = Double(DSPMath.db(DSPMath.median(guardBins)))
                let tonal = peakDb > pilotDb - config.tonalInterferenceDb && peakDb > medianDb + config.tonalPeakOverMedianDb
                let broadband = medianDb > pilotDb - config.broadbandInterferenceDb
                if tonal || broadband { interferenceUntil = t + config.interferenceHold }
                if tonal || broadband { dbgInterferenceReason = tonal ? "tonal" : "broadband" }
                dbgGuardPeak = peakDb; dbgGuardMedian = medianDb
            }
        }
        status.interference = t < interferenceUntil
    }

    // MARK: Diagnostics

    /// Numbers since the previous call (see `SonarFieldDebug`). Cheap; call ~10 times a second.
    public func debugSnapshot() -> SonarFieldDebug {
        var d = SonarFieldDebug()
        let off = binToDbfs
        func side(_ s: SonarFieldSideStatus, _ a: DebugAccumulator, _ tr: PhaseSideTracker, _ f: Double) -> SonarFieldDebug.Side {
            var o = SonarFieldDebug.Side()
            o.frequencyHz = f
            o.pilotDbfs = Double(s.pilotDb) + off
            o.noiseDbfsPerBin = Double(s.noiseDb) + off
            o.snrDb = Double(s.pilotDb - s.noiseDb)
            o.pilotPresent = s.pilotPresent
            o.sidebandLowDbc = a.sideLow
            o.sidebandHighDbc = a.sideHigh
            o.dopplerLeftShiftBins = s.dopplerLeftShift
            o.dopplerRightShiftBins = s.dopplerRightShift
            o.pathTotalMm = tr.pathMm
            o.pathDeltaMm = tr.pathMm - (a.pathStart ?? tr.pathMm)
            if a.count > 1 {
                let mean = a.sum / Double(a.count)
                o.pathStepVarianceMm2 = max(0, a.sumSq / Double(a.count) - mean * mean)
            }
            o.dynamicDb = Double(DSPMath.db(Float(tr.dynamicRatio)))
            o.gateOpenShare = a.count > 0 ? Double(a.gateOpen) / Double(a.count) : 0
            return o
        }
        d.left = side(status.left, dbgL, leftTracker, leftHz)
        d.right = side(status.right, dbgR, rightTracker, rightHz)
        d.windowSeconds = dbgWindowStart.map { lastStatusTime - $0 } ?? 0
        d.warmedUp = status.warmedUp
        d.interference = status.interference
        d.interferenceReason = status.interference ? dbgInterferenceReason : nil
        d.guardPeakDbfs = dbgGuardPeak + off
        d.guardMedianDbfs = dbgGuardMedian + off
        d.suppressedByDaemon = lastStatusTime < suppressedUntil
        d.ready = status.warmedUp && status.left.pilotPresent && status.right.pilotPresent && !status.interference && !d.suppressedByDaemon
        d.highBandRolloffDb = dbgRolloff
        d.impulseBlocks = dbgImpulses
        d.basebandSamples = dbgL.count
        d.restarts = dbgRestarts
        d.episodeActive = episode != nil
        d.hoverActive = episode?.hover != nil
        d.slideActive = slide != nil
        dbgL = DebugAccumulator(); dbgR = DebugAccumulator()
        dbgImpulses = 0
        dbgWindowStart = lastStatusTime
        return d
    }

    // MARK: Gestures

    private func isSuppressed(at t: Double) -> Bool {
        t < suppressedUntil || t < interferenceUntil || !status.left.pilotPresent || !status.right.pilotPresent
    }

    private func isSuppressed(during a: Double, _ b: Double) -> Bool {
        suppressedUntil > a || interferenceUntil > a || isSuppressed(at: b)
    }

    private func index(at time: Double) -> Int? {
        guard !hT.isEmpty else { return nil }
        var lo = 0, hi = hT.count - 1
        while lo < hi {
            let mid = (lo + hi) / 2
            if hT[mid] < time { lo = mid + 1 } else { hi = mid }
        }
        return lo
    }

    /// Lateral (dx, positive right) and along-grille (dy, positive toward the hinge) movement estimates, mm.
    /// The differential path change (left minus right) cancels the shared microphone term, so it tracks lateral
    /// movement; the common path change is dominated by distance to the microphones near the hinge.
    private func slideDelta(from a: Double, to b: Double) -> (Double, Double) {
        guard let i = index(at: a), let j = index(at: b) else { return (0, 0) }
        let dL = hL[j] - hL[i], dR = hR[j] - hR[i]
        return ((dL - dR) / 2, -(dL + dR) / 4)
    }

    private func sideOfLargerChange(from a: Double, to b: Double) -> SpeakerSide? {
        guard let i = index(at: a), let j = index(at: b) else { return nil }
        return abs(hL[j] - hL[i]) >= abs(hR[j] - hR[i]) ? .left : .right
    }

    private func slideEvent(_ phase: AirPhase, time: Double, dx: Double, dy: Double, cancelled: Bool = false) -> AcousticAirEvent {
        let main = abs(dx) > abs(dy) ? dx : dy
        return AcousticAirEvent(kind: .fingerSlide, phase: phase, time: time, side: nil,
                                value: max(-1, min(1, dy / config.slideRangeMm)), displacementMm: main,
                                dxMm: dx, dyMm: dy, confidence: 0.7, cancelled: cancelled)
    }

    private func hoverEvent(_ phase: AirPhase, _ h: Hover, path: Double, time: Double, cancelled: Bool = false) -> AcousticAirEvent {
        let displacement = (path - h.startPath) / 2
        return AcousticAirEvent(kind: .hoverLevel, phase: phase, time: time, side: h.side,
                                value: max(-1, min(1, displacement / config.hoverRangeMm)), displacementMm: displacement,
                                confidence: 0.8, cancelled: cancelled)
    }

    private func evaluate(t: Double, events: inout [SonarFieldEvent]) {
        status.left.dynamicDb = DSPMath.db(Float(leftTracker.dynamicRatio))
        status.right.dynamicDb = DSPMath.db(Float(rightTracker.dynamicRatio))
        let w = Int(config.velocityWindow * config.basebandRate)
        guard hT.count > w else { return }
        let last = hT.count - 1
        let vL = (hL[last] - hL[last - w]) / config.velocityWindow
        let vR = (hR[last] - hR[last - w]) / config.velocityWindow
        let suppressed = isSuppressed(at: t)
        status.suppressed = t < suppressedUntil
        let moving = max(abs(vL), abs(vR)) > config.movingSpeedMmPerSec

        // Continuous finger slide while in contact.
        if var s = slide {
            let (dx, dy) = slideDelta(from: s.start, to: t)
            if max(abs(dx - s.lastDx), abs(dy - s.lastDy)) >= 1 && t - s.lastTime >= 0.02 {
                s.lastDx = dx; s.lastDy = dy; s.lastTime = t
                events.append(.air(slideEvent(.changed, time: t, dx: dx, dy: dy)))
                slide = s
            }
        }

        if episode == nil {
            guard moving else { return }
            episode = Episode(start: t, startL: hL[last], startR: hR[last], lastMoving: t)
            if contacts.contains(where: { ($0.end ?? .infinity) > t - 0.3 }) { episode!.contact = true }
        }
        var ep = episode!
        if moving { ep.lastMoving = t }
        if suppressed { ep.tainted = true }
        if slide != nil { ep.contact = true }
        let dL = hL[last] - ep.startL, dR = hR[last] - ep.startR
        let common = (dL + dR) / 2, diff = dL - dR
        ep.maxAbsCommon = max(ep.maxAbsCommon, abs(common))

        if var h = ep.hover {
            let path = h.side == .left ? hL[last] : hR[last]
            if ep.tainted || ep.contact {
                events.append(.air(hoverEvent(.ended, h, path: path, time: t, cancelled: true)))
                ep.hover = nil
                ep.hoverEnded = true
            } else if abs(path - h.lastReported) >= 2 * config.hoverStepMm && t - h.lastTime >= 0.02 {
                h.lastReported = path; h.lastTime = t
                ep.hover = h
                events.append(.air(hoverEvent(.changed, h, path: path, time: t)))
            }
        } else if !ep.hoverEnded && !ep.tainted && !ep.contact && moving && t - ep.start >= config.hoverDelay
                    && abs(common) >= config.hoverDominance * abs(diff)
                    && max(abs(dL), abs(dR)) >= config.hoverMinPathMm
                    && abs(common) >= 0.8 * ep.maxAbsCommon {
            let side: SpeakerSide = abs(dL) >= abs(dR) ? .left : .right
            let h = Hover(side: side, startPath: side == .left ? ep.startL : ep.startR,
                          lastReported: side == .left ? hL[last] : hR[last], lastTime: t)
            ep.hover = h
            events.append(.air(hoverEvent(.began, h, path: h.lastReported, time: t)))
        }

        let idleLimit = ep.hover != nil ? config.hoverIdleEnd : config.idleEnd
        guard t - ep.lastMoving > idleLimit else { episode = ep; return }
        episode = nil
        if let h = ep.hover {
            let path = h.side == .left ? hL[last] : hR[last]
            events.append(.air(hoverEvent(.ended, h, path: path, time: t)))
            return
        }
        guard !ep.tainted, !ep.contact, !ep.hoverEnded else { return }
        let duration = ep.lastMoving - ep.start
        if abs(diff) >= config.sweepMinDiffMm && abs(diff) >= config.sweepDominance * abs(common) && duration <= config.sweepMaxDuration {
            let conf = min(1, abs(diff) / (2 * config.sweepMinDiffMm)) * min(1, abs(diff) / max(1e-6, 3 * abs(common)) + 0.5)
            events.append(.gesture(AcousticGesture(kind: diff > 0 ? .sweepRight : .sweepLeft, time: ep.lastMoving,
                                                   confidence: min(1, conf), duration: duration, distanceMm: abs(diff) / 2)))
        } else if abs(common) >= config.pushMinPathMm && abs(common) >= config.pushDominance * abs(diff)
                    && duration <= config.pushMaxDuration && abs(common) >= 0.7 * ep.maxAbsCommon {
            let side: SpeakerSide = abs(dL) >= abs(dR) ? .left : .right
            let isPush = common < 0
            var conf = min(1, 0.5 + abs(common) / (4 * config.pushMinPathMm))
            let wanted: SonarWaveKind = isPush ? .toward : .away
            if recentDoppler.contains(where: { $0.side == side && $0.event.kind == wanted && $0.event.time >= ep.start - 0.1 }) {
                conf = min(1, conf + 0.2)
            }
            events.append(.gesture(AcousticGesture(kind: isPush ? .push : .pull, time: ep.lastMoving, confidence: conf,
                                                   duration: duration, side: side,
                                                   distanceMm: abs(side == .left ? dL : dR) / 2)))
        }
    }
}
