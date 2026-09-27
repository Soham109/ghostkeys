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

    /// Static-component tracker time constant, seconds (two stages). Anything that stops moving fades into "static"
    /// this fast. 25 ms (about 6 Hz) removes the real pilot's slow wander; a hand moving 5 cm/s or faster still
    /// passes (its Doppler is above 6 Hz).
    public var staticTimeConstant: Double = 0.025
    /// Low-pass on the moving part, Hz: hand Doppler stays below about 150 Hz (a 1.3 m/s swipe).
    public var basebandLowpassHz: Double = 150
    /// The moving part must be at least this strong relative to the static part to be tracked, dB.
    public var dynamicGateDb: Double = -65
    /// ...and this far above its own learned noise floor, dB.
    public var gateOverFloorDb: Double = 6
    /// Averaging time of the moving part's power for that comparison, seconds (longer = steadier noise estimate).
    public var gatePowerSmoothing: Double = 0.03
    /// Noise floor: log-average of the moving part's power with this time constant, frozen while tracking and for
    /// 0.3 s after.
    public var noiseFloorTime: Double = 1.5
    /// Baseband samples are held this long so an impulse (key click) can also void the samples just before it, and a
    /// noise burst seen in a whole 85 ms FFT frame can void every sample of that frame.
    public var processingDelay: Double = 0.09
    /// Residual (non-pilot) ultrasonic energy jump that marks an impulse, dB above its floor.
    public var impulseDb: Double = 12
    /// Seconds after start used only to settle the static, drift and noise-floor trackers.
    public var warmup: Double = 0.6

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
    /// A side's motion counts only when its tracker measured at least this share of the velocity window...
    public var minTrackedShare: Double = 0.6
    /// ...and its net path change over the window is at least this share of all its steps (one direction).
    public var minCoherence: Double = 0.6
    /// A gesture or hover needs the whole episode to be this one-directional (hovers that go up then down still
    /// pass: 0.5 allows a return of a third of the way).
    public var minEpisodeCoherence: Double = 0.5
    /// hover_level starts only while the path still moves at least this much within `hoverProgressWindow`.
    public var hoverMinProgressMm: Double = 12
    public var hoverProgressWindow: Double = 0.25
    /// A quick move's duration is measured where its speed is at least this share of its peak.
    public var coreSpeedShare: Double = 0.33
    public var pushMaxDuration: Double = 0.45
    public var pushDominance: Double = 1.5
    public var sweepMinDiffMm: Double = 60
    public var sweepDominance: Double = 1.5
    public var sweepMaxDuration: Double = 1.5
    /// Echo balance ((L - R) / (L + R)) that the start and the end of a sweep must each reach, on opposite sides.
    public var sweepBalance: Double = 0.3
    /// Also accept a sweep from the balance crossing alone (without a large differential path). Off: on the
    /// simulated MacBook scenes it added more wrong gestures than it found.
    public var sweepByBalance = false
    /// Minimum finger travel estimate for a slide, mm.
    public var slideMinMm: Double = 3
    /// Finger travel that maps to value 1.0.
    public var slideRangeMm: Double = 40

    /// Pilot must stand this far above the local noise (per FFT bin), dB. Measured on the M5 Pro MacBook Pro at 19%
    /// volume: 57 dB left, 27 to 41 dB right (the right speaker is far from the mics).
    public var minPilotSnrDb: Double = 15
    /// Narrow peaks near the pilots within this many dB of the weaker pilot mean music or another ultrasonic source.
    /// (45 dB tripped on the real mic's own spurs: the weaker pilot arrives at about -95 dBFS, so anything above
    /// -140 dBFS counted.)
    public var tonalInterferenceDb: Double = 30
    /// A peak counts as narrow when this far above the guard band's median, dB.
    public var tonalPeakOverMedianDb: Double = 20
    /// Broadband noise near the pilots within this many dB of the weaker pilot also counts as interference.
    public var broadbandInterferenceDb: Double = 15
    /// ...or rising this far above its own learned quiet level (a hiss, a fan, rustling near the mics), dB.
    public var broadbandRiseDb: Double = 15
    /// A guard level this far above usual voids the baseband samples of that FFT frame (no suppression), dB.
    public var burstVoidDb: Double = 8
    /// Bins around each pilot left out of the interference check (they hold the hand's own Doppler echoes).
    public var guardExclusionBins: Int = 30
    public var guardSpanBins: Int = 60
    /// How long detection stays suppressed after interference is last seen, seconds.
    public var interferenceHold: Double = 0.5
    /// Broadband bursts (a creak, a click, fan or coil noise) on the real Mac last about 0.1 s; hold them this long.
    public var broadbandHold: Double = 0.15

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
    /// At least one pilot present, warmed up, nothing suppressing detection (sweeps also need both pilots).
    public var ready: Bool { warmedUp && (left.pilotPresent || right.pilotPresent) && !interference && !suppressed }
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
        /// Moving part over its learned noise floor, dB, largest in the window (the gate opens at `gateOverFloorDb`).
        public var overFloorDb: Double = 0
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
    /// FFT frames in the window whose samples were voided by a noise burst near the pilots.
    public var burstFrames = 0
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
///
/// Tuned on real recordings from a MacBook Pro (see docs/review/SONAR_REPORT.md): there the pilot's "static" part is
/// not static. It wanders by about 1 dB and 0.05 rad a few times a second (air, speaker processing), which after the
/// old 0.3 s static tracker left a moving part only 20 dB below the pilot, far above a hand echo (30 to 45 dB below
/// the direct path). So:
/// - the static tracker is faster (`staticTimeConstant`, about 6 Hz), and a second stage removes what the first
///   lets through, so the slow wander is gone while hand Doppler (10 to 150 Hz) passes;
/// - the moving part is low-passed to the band a hand can produce (`basebandLowpassHz`), dropping most of the mic's
///   own noise;
/// - the tracking gate compares the moving part with a noise floor learned from the moving part itself while
///   nothing moves (the old sample-difference estimate read 5 to 10 times too low on real, correlated baseband
///   noise, so the gate stayed open on noise and the path wandered by hundreds of millimetres).
final class PhaseSideTracker {
    let wavelengthMm: Double
    private let alpha: Double
    private let lpCoef: Double
    private let driftRateWarm: Double
    private let maxDriftRad: Double
    private let driftRate: Double
    private let activityThreshold: Double
    private let maxGapBlocks: Int
    private let gateRel: Double
    private let floorFactor: Double
    private let floorFall: Double
    private let powerSmooth: Double
    private var rawPrev: Cx?
    private var rotation = Cx(re: 0, im: 0)
    private var derotation = Cx(re: 1, im: 0)
    private var staticPart: Cx?
    private var static2 = Cx(re: 0, im: 0)
    private var lp1 = Cx(re: 0, im: 0), lp2 = Cx(re: 0, im: 0)
    private var power = 0.0
    private(set) var noiseFloor: Double?
    private var closedFor = 0
    private var openFor = 0
    private let holdAfterOpen: Int
    private let lockOpenAfter: Int
    private let lockRise: Double
    private var lastDynamic: Cx?
    private var gapBlocks = 0
    /// Smoothed |phase change| per baseband sample of the moving part.
    private var activity = 0.0
    private(set) var pathMm = 0.0
    private(set) var dynamicRatio = 0.0
    /// Moving-part power over the learned noise floor, dB (diagnostics).
    private(set) var overFloorDb = 0.0
    /// Moving-part power above the noise floor (linear, baseband units): the echo's strength. Both pilots leave the
    /// speakers at the same level and reach the same mic, so comparing this across sides says which speaker the
    /// hand is nearer, even when one side's path is poorly measured.
    private(set) var excessPower = 0.0
    /// Diagnostics for the last sample: path increment (mm) and whether the tracking gate was open.
    private(set) var lastStepMm = 0.0
    private(set) var gateOpen = false

    init(frequency: Double, config: SonarFieldConfig) {
        wavelengthMm = config.speedOfSound / frequency * 1000
        alpha = 1 / (config.staticTimeConstant * config.basebandRate)
        lpCoef = 1 - exp(-2 * Double.pi * config.basebandLowpassHz / config.basebandRate)
        let perSecond = config.basebandRate
        driftRateWarm = 5 / perSecond         // about 0.2 s time constant while warming up
        maxDriftRad = 2 * Double.pi * 2 / perSecond
        driftRate = 1.5 / perSecond           // about 0.7 s afterwards
        activityThreshold = 7.5 / perSecond   // 7.5 rad/s of phase change counts as motion
        maxGapBlocks = Int(0.04 * perSecond)
        gateRel = pow(10, config.dynamicGateDb / 10)
        floorFactor = pow(10, config.gateOverFloorDb / 10)
        floorFall = 1 / (config.noiseFloorTime * perSecond)
        holdAfterOpen = Int(0.3 * perSecond)
        lockOpenAfter = Int(2 * perSecond)
        lockRise = 2 * log(10) / 10 / perSecond     // 2 dB/s in natural-log power units
        powerSmooth = 1 / (config.gatePowerSmoothing * perSecond)
    }

    func step(_ z: Cx, bad: Bool, integrate: Bool, warm: Bool) {
        lastStepMm = 0
        if bad { gateOpen = false; return } // an impulse: keep all state, bridge the phase across the gap
        // Drift: a clock offset between speaker and mic makes everything, including the static part, rotate slowly.
        // Estimate that rotation from the raw signal (dominated by the static part) and undo it. Learn it only while
        // nothing moves: the static part is ~25 dB above an echo, so even a small bias picked up from a moving echo
        // would leak more static signal into the moving part than the echo itself.
        // On the MacBook Pro the real drift was under 0.01 Hz, while a drift estimate learned from a noisy weak pilot
        // could lock onto tens of Hz (then the rotating "static" part looked like endless motion and froze further
        // learning). So: learn slowly, keep learning (very slowly) during motion, and never believe more than 2 Hz.
        if let p = rawPrev {
            let rate = warm ? driftRateWarm : (activity < activityThreshold ? driftRate : driftRate / 20)
            rotation = rotation + (z * p.conj - rotation) * rate
        }
        rawPrev = z
        let rn = rotation.norm2
        if rn > 0 {
            var r = rotation * (1 / rn.squareRoot())
            let angle = r.arg
            if abs(angle) > maxDriftRad { let a = angle > 0 ? maxDriftRad : -maxDriftRad; r = Cx(re: cos(a), im: sin(a)) }
            derotation = derotation * r.conj
            derotation = derotation * (1 / derotation.norm2.squareRoot())
        }
        let zc = z * derotation
        guard let s = staticPart else { staticPart = zc; static2 = Cx(re: 0, im: 0); lp1 = Cx(re: 0, im: 0); lp2 = lp1; return }
        // Two-stage static removal (second-order high-pass), then a two-pole low-pass to the hand's Doppler band.
        let d1 = zc - s
        staticPart = s + d1 * alpha
        let d2 = d1 - static2
        static2 = static2 + d2 * alpha
        lp1 = lp1 + (d2 - lp1) * lpCoef
        lp2 = lp2 + (lp1 - lp2) * lpCoef
        let d = lp2
        let sp = staticPart!.norm2
        dynamicRatio = sp > 0 ? d.norm2 / sp : 0
        power += (d.norm2 - power) * powerSmooth
        // Noise floor of the moving part: falls quickly to quiet levels, creeps up slowly (never while the gate is
        // open), so it follows the room but not a hand.
        // The floor is the typical (log-average) level of the moving part while nothing is tracked, so the gate
        // threshold sits a fixed distance above the usual noise rather than above its quietest moments.
        let lp = log(max(power, 1e-30))
        if let f = noiseFloor {
            let lf = log(f)
            if warm { noiseFloor = exp(lf + (lp - lf) * 10 * floorFall) }
            else if !gateOpen && closedFor > holdAfterOpen { noiseFloor = exp(lf + (lp - lf) * floorFall) }
            // Open for over 2 s without a break: more likely the noise got louder (or the floor was learned in a
            // quiet moment) than a hand moving that long. Let the floor rise 2 dB/s so the gate cannot lock open.
            else if gateOpen && openFor > lockOpenAfter && lp > lf { noiseFloor = exp(lf + min(lp - lf, lockRise)) }
        } else { noiseFloor = power }
        let floor = max(noiseFloor!, 1e-30)
        overFloorDb = 10 * log10(max(power, 1e-30) / floor)
        excessPower = max(0, power - floor)
        gateOpen = !warm && power > floorFactor * floor && d.norm2 > gateRel * sp
        closedFor = gateOpen ? 0 : closedFor + 1
        openFor = gateOpen ? openFor + 1 : 0
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
    /// Delay line of baseband samples; live entries are `pending[pendingHead...]` (compacted now and then, so taking
    /// one sample out is not an array shift per sample).
    private var pending: [Pending] = []
    private var pendingHead = 0
    private var blockIndex = 0
    private var badUntil = -1
    private let delayBlocks: Int
    private var hT: [Double] = [], hL: [Double] = [], hR: [Double] = []
    /// Per baseband sample: was each side's tracking gate open (its path is measured, not held).
    private var hGL: [Int] = [], hGR: [Int] = []   // running counts of open-gate samples
    /// Running sums of |path step| per side: with the path itself they give how one-directional the motion was.
    private var hAL: [Double] = [], hAR: [Double] = []
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
    private var guardFloorDb: Double?
    private var impulseRun = 0
    private var lastTonalBin: Int?
    /// Baseband samples up to this time are void (a noise burst was seen in the FFT frame covering them).
    private var voidUntilTime = -Double.infinity
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
        /// Tainted by the daemon's suppression (typing, laptop motion), which never clears within an episode.
        var suppressedByDaemon = false
        var contact = false
        var hover: Hover?
        var hoverEnded = false
        /// Evaluations so far, and how many of them each side's tracker measured (a side whose gate stays closed
        /// has no path information: its zero path means "unknown", not "still").
        var evals = 0, trackedL = 0, trackedR = 0
        var useL: Bool { Double(trackedL) >= 0.4 * Double(max(1, evals)) }
        var useR: Bool { Double(trackedR) >= 0.4 * Double(max(1, evals)) }
        /// Common-mode speed samples (time, |speed|) for the "core" duration of a quick move.
        var speeds: [(t: Double, v: Double)] = []
        var peakSpeed = 0.0
        /// Echo strength per side, summed, and the left/right balance over time ((L - R) / (L + R), weighted).
        var echoL = 0.0, echoR = 0.0
        /// Travel (sum of |change| between evaluations) of the common and differential motion, for how
        /// one-directional the episode was.
        var commonTravel = 0.0, diffTravel = 0.0
        var lastCommon = 0.0, lastDiff = 0.0
        var balance: [(t: Double, b: Double, w: Double)] = []
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
        var overFloor = -200.0
    }
    private var dbgL = DebugAccumulator(), dbgR = DebugAccumulator()
    private var dbgImpulses = 0, dbgRestarts = 0, dbgFrames = 0, dbgBurstFrames = 0
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
            s.minPilotSnrDb = c.minPilotSnrDb
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
        pending.removeAll(); pendingHead = 0
        blockIndex = 0; badUntil = -1
        hT.removeAll(); hL.removeAll(); hR.removeAll(); hGL.removeAll(); hGR.removeAll(); hAL.removeAll(); hAR.removeAll()
        sinceEval = 0
        framer.reset()
        dopplerL.reset(); dopplerR.reset()
        interferenceUntil = -.infinity
        guardFloorDb = nil
        impulseRun = 0
        lastTonalBin = nil
        voidUntilTime = -.infinity
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
        let warm = t - (firstTime ?? t) < warmupSeconds
        if let floor = residualFloor, !warm {
            impulse = e > floor * impulseFactor && e > 1e-13
            if !impulse { residualFloor = e < floor ? floor + 0.05 * (e - floor) : floor * 1.0003; impulseRun = 0 }
            else {
                // A click lasts a few milliseconds. Energy that stays up for 40 ms is a new level (the audio started
                // from silence, a fan spun up), not an impulse: take it as the floor instead of voiding forever.
                // (On the MacBook the floor was learned from the first near-silent buffers and every later block
                // counted as an impulse, so the phase trackers never ran.)
                impulseRun += 1
                if Double(impulseRun) > 0.04 * config.basebandRate { residualFloor = e; impulseRun = 0; impulse = false }
            }
        } else {
            // Warm-up: follow the level both ways.
            residualFloor = residualFloor.map { $0 + 0.2 * (e - $0) } ?? e
        }
        if impulse {
            dbgImpulses += 1
            badUntil = blockIndex + Int(0.008 * config.basebandRate)
            for k in max(pendingHead, pending.count - Int(0.004 * config.basebandRate))..<pending.count { pending[k].bad = true }
        }
        pending.append(Pending(t: t, zL: zL, zR: zR, bad: blockIndex <= badUntil || t <= voidUntilTime))
        blockIndex += 1
        if pending.count - pendingHead > delayBlocks {
            let ready = pending.count - pendingHead - delayBlocks
            for k in pendingHead..<(pendingHead + ready) { integrate(pending[k], events: &events) }
            pendingHead += ready
            if pendingHead > 512 { pending.removeFirst(pendingHead); pendingHead = 0 }
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
            a.overFloor = max(a.overFloor, tr.overFloorDb)
        }
        acc(&dbgL, leftTracker); acc(&dbgR, rightTracker)
        guard !warm else { return }
        hT.append(p.t); hL.append(leftTracker.pathMm); hR.append(rightTracker.pathMm)
        hGL.append((hGL.last ?? 0) + (leftTracker.gateOpen ? 1 : 0)); hGR.append((hGR.last ?? 0) + (rightTracker.gateOpen ? 1 : 0))
        hAL.append((hAL.last ?? 0) + abs(leftTracker.lastStepMm)); hAR.append((hAR.last ?? 0) + abs(rightTracker.lastStepMm))
        let keep = historyKeep
        if hT.count > 2 * keep {
            let drop = hT.count - keep
            hT.removeFirst(drop); hL.removeFirst(drop); hR.removeFirst(drop); hGL.removeFirst(drop); hGR.removeFirst(drop)
            hAL.removeFirst(drop); hAR.removeFirst(drop)
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
                // Typical guard level (dB average over about 2 s, frozen while interference is flagged). On the real
                // mic the guard median moves by up to 9 dB from frame to frame, so this is an average, not a minimum.
                let warmNow = t - (firstTime ?? t) < warmupSeconds
                if let g = guardFloorDb {
                    if warmNow { guardFloorDb = g + (medianDb - g) * 0.2 }
                    else if t >= interferenceUntil { guardFloorDb = g + (medianDb - g) * Double(config.hopSize) / sr / 2 }
                } else { guardFloorDb = medianDb }
                // Tonal: a narrow peak that stays on the same bin in consecutive frames (music, another device). The
                // largest of ~100 noise bins alone often sits 10 to 15 dB above the median, so a single frame is not
                // enough.
                var peakBin = lo
                var kk = lo
                while kk <= hi { if abs(kk - bl) > excl && abs(kk - br) > excl && p[kk] > p[peakBin] { peakBin = kk }; kk += 1 }
                let peakHere = peakDb > pilotDb - config.tonalInterferenceDb && peakDb > medianDb + config.tonalPeakOverMedianDb
                let tonal = peakHere && lastTonalBin.map { abs($0 - peakBin) <= 1 } == true
                lastTonalBin = peakHere ? peakBin : nil
                let broadband = medianDb > pilotDb - config.broadbandInterferenceDb
                    || (t - (firstTime ?? t) > warmupSeconds && medianDb > guardFloorDb! + config.broadbandRiseDb)
                if tonal || broadband {
                    interferenceUntil = max(interferenceUntil, t + (tonal ? config.interferenceHold : config.broadbandHold))
                }
                // Smaller noise bursts (a few dB over the usual guard level) do not block detection, but the phase of
                // a weak echo cannot be trusted under them: void the baseband samples this frame covers.
                if !warmNow, let g = guardFloorDb, medianDb > g + config.burstVoidDb || tonal || broadband {
                    let half = Double(config.fftSize) / 2 / sr
                    voidUntilTime = max(voidUntilTime, t + half)
                    for k in pendingHead..<pending.count where pending[k].t >= t - half { pending[k].bad = true }
                    dbgBurstFrames += 1
                }
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
            o.overFloorDb = a.overFloor
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
        d.ready = status.warmedUp && (status.left.pilotPresent || status.right.pilotPresent) && !status.interference && !d.suppressedByDaemon
        d.highBandRolloffDb = dbgRolloff
        d.impulseBlocks = dbgImpulses
        d.burstFrames = dbgBurstFrames
        d.basebandSamples = dbgL.count
        d.restarts = dbgRestarts
        d.episodeActive = episode != nil
        d.hoverActive = episode?.hover != nil
        d.slideActive = slide != nil
        dbgL = DebugAccumulator(); dbgR = DebugAccumulator()
        dbgImpulses = 0
        dbgBurstFrames = 0
        dbgWindowStart = lastStatusTime
        return d
    }

    // MARK: Gestures

    /// Each side is judged on its own: one healthy pilot is enough for push, pull and hover (the right speaker
    /// reaches the mics of a MacBook Pro 20 to 23 dB weaker than the left). Sweeps need both.
    private func isSuppressed(at t: Double) -> Bool {
        t < suppressedUntil || t < interferenceUntil || (!status.left.pilotPresent && !status.right.pilotPresent)
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

    /// The speaker the hand was nearer: stronger echo (both pilots leave at the same level, one mic hears both).
    /// Decided by echo strength when it is clear (3 dB or more apart), else by which side's path changed more.
    private func nearerSide(_ ep: Episode, dL: Double, dR: Double, useL: Bool, useR: Bool) -> SpeakerSide {
        if ep.echoL > 2 * ep.echoR { return .left }
        if ep.echoR > 2 * ep.echoL { return .right }
        return !useR || (useL && abs(dL) >= abs(dR)) ? .left : .right
    }

    /// A hand passing across moves the echo from one speaker to the other: the weighted left/right balance of the
    /// first third of the episode and of the last third have opposite signs, each at least `sweepBalance`.
    /// +1 = left to right (sweep_right), -1 = right to left, nil = no crossing.
    private func balanceCrossing(_ ep: Episode) -> Int? {
        guard ep.balance.count >= 6, let t0 = ep.balance.first?.t, let t1 = ep.balance.last?.t, t1 > t0 else { return nil }
        func mean(_ a: Double, _ b: Double) -> Double? {
            var s = 0.0, w = 0.0
            for x in ep.balance where x.t >= a && x.t <= b { s += x.b * x.w; w += x.w }
            return w > 0 ? s / w : nil
        }
        let third = (t1 - t0) / 3
        guard let first = mean(t0, t0 + third), let lastB = mean(t1 - third, t1) else { return nil }
        if first >= config.sweepBalance && lastB <= -config.sweepBalance { return 1 }
        if first <= -config.sweepBalance && lastB >= config.sweepBalance { return -1 }
        return nil
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
        // Motion counts only on a side whose tracker actually measured most of the window (noise that briefly opens
        // the gate makes a few large random steps, not a sustained speed).
        func tracked(_ g: [Int]) -> Bool { Double(g[last] - g[last - w]) >= config.minTrackedShare * Double(w) }
        let okL = status.left.pilotPresent, okR = status.right.pilotPresent
        // ...and only when it went one way: noise that opens the gate makes steps of random sign (measured live on the
        // weak right pilot: 10 to 40 mm per 0.1 s back and forth), a hand turns the phase steadily one way.
        func coherent(_ p: [Double], _ a: [Double]) -> Bool {
            let total = a[last] - a[last - w]
            return total > 0 && abs(p[last] - p[last - w]) >= config.minCoherence * total
        }
        let movingL = okL && abs(vL) > config.movingSpeedMmPerSec && tracked(hGL) && coherent(hL, hAL)
        let movingR = okR && abs(vR) > config.movingSpeedMmPerSec && tracked(hGR) && coherent(hR, hAR)
        let moving = movingL || movingR

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
        if t < suppressedUntil { ep.suppressedByDaemon = true }
        // A noise burst (interference) spoils only the motion it overlapped: once it is over, motion that goes on
        // starts a fresh episode. Daemon suppression (typing) does not clear: lifting the hands off the keys after
        // typing must not become a gesture.
        if ep.tainted && !suppressed && !ep.suppressedByDaemon && ep.hover == nil && moving {
            ep = Episode(start: t, startL: hL[last], startR: hR[last], lastMoving: t)
            if contacts.contains(where: { ($0.end ?? .infinity) > t - 0.3 }) { ep.contact = true }
        }
        if suppressed { ep.tainted = true }
        if slide != nil { ep.contact = true }
        ep.evals += 1
        if okL && tracked(hGL) { ep.trackedL += 1 }
        if okR && tracked(hGR) { ep.trackedR += 1 }
        // Echo strength only where that side's tracker is open: the left pilot's own wander is ~10 dB stronger at
        // the mic than the right's noise, and would otherwise read as an echo.
        let xL = okL && leftTracker.gateOpen ? leftTracker.excessPower : 0
        let xR = okR && rightTracker.gateOpen ? rightTracker.excessPower : 0
        ep.echoL += xL; ep.echoR += xR
        if xL + xR > 0 { ep.balance.append((t, (xL - xR) / (xL + xR), xL + xR)) }
        // One usable side: it alone gives the common motion (no differential, so no sweeps).
        let useL = ep.useL || !ep.useR && okL && abs(vL) >= abs(vR), useR = ep.useR || !useL
        let both = useL && useR
        let dL = useL ? hL[last] - ep.startL : 0, dR = useR ? hR[last] - ep.startR : 0
        let common = both ? (dL + dR) / 2 : dL + dR, diff = both ? dL - dR : 0
        // How one-directional the episode was (1 = every step the same way): the common part for push, pull and
        // hover, the differential part for sweeps.
        ep.commonTravel += abs(common - ep.lastCommon); ep.lastCommon = common
        ep.diffTravel += abs(diff - ep.lastDiff); ep.lastDiff = diff
        let commonCoherent = ep.commonTravel > 0 && abs(common) >= config.minEpisodeCoherence * ep.commonTravel
        let diffCoherent = ep.diffTravel > 0 && abs(diff) >= config.minEpisodeCoherence * ep.diffTravel
        ep.maxAbsCommon = max(ep.maxAbsCommon, abs(common))
        let vc = both ? max(abs(vL), abs(vR)) : (useL ? abs(vL) : abs(vR))
        ep.speeds.append((t, vc))
        ep.peakSpeed = max(ep.peakSpeed, vc)

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
        } else if !ep.hoverEnded && !ep.tainted && !ep.contact && moving && commonCoherent && t - ep.start >= config.hoverDelay
                    && abs(common) >= config.hoverDominance * abs(diff)
                    && max(abs(dL), abs(dR)) >= config.hoverMinPathMm
                    && abs(common) >= 0.8 * ep.maxAbsCommon {
            let side = nearerSide(ep, dL: dL, dR: dR, useL: useL, useR: useR)
            // Still progressing: a quick push that is over (only noise left) must not turn into a hover.
            let path = side == .left ? hL : hR
            let back = index(at: t - config.hoverProgressWindow) ?? last
            if abs(path[last] - path[back]) >= config.hoverMinProgressMm {
                let h = Hover(side: side, startPath: side == .left ? ep.startL : ep.startR,
                              lastReported: path[last], lastTime: t)
                ep.hover = h
                events.append(.air(hoverEvent(.began, h, path: h.lastReported, time: t)))
            }
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
        // Duration of the move itself: where the speed was at least a third of its peak (noise before and after
        // the move stretches the episode, not the move).
        let core = ep.speeds.filter { $0.v >= config.coreSpeedShare * ep.peakSpeed }
        let duration = max(0, (core.last?.t ?? ep.lastMoving) - (core.first?.t ?? ep.start))
        let end = core.last?.t ?? ep.lastMoving
        let crossing: Int? = config.sweepByBalance ? balanceCrossing(ep) : nil
        if duration <= config.sweepMaxDuration,
           let dir = crossing ?? (both && diffCoherent && abs(diff) >= config.sweepMinDiffMm && abs(diff) >= config.sweepDominance * abs(common) ? (diff > 0 ? 1 : -1) : nil) {
            let conf = crossing != nil ? 0.8 : min(1, abs(diff) / (2 * config.sweepMinDiffMm)) * min(1, abs(diff) / max(1e-6, 3 * abs(common)) + 0.5)
            events.append(.gesture(AcousticGesture(kind: dir > 0 ? .sweepRight : .sweepLeft, time: end,
                                                   confidence: min(1, conf), duration: duration, distanceMm: abs(diff) / 2)))
        } else if commonCoherent && abs(common) >= config.pushMinPathMm && abs(common) >= config.pushDominance * abs(diff)
                    && duration <= config.pushMaxDuration && abs(common) >= 0.7 * ep.maxAbsCommon {
            let side = nearerSide(ep, dL: dL, dR: dR, useL: useL, useR: useR)
            let isPush = common < 0
            var conf = min(1, 0.5 + abs(common) / (4 * config.pushMinPathMm))
            let wanted: SonarWaveKind = isPush ? .toward : .away
            if recentDoppler.contains(where: { $0.side == side && $0.event.kind == wanted && $0.event.time >= ep.start - 0.1 }) {
                conf = min(1, conf + 0.2)
            }
            events.append(.gesture(AcousticGesture(kind: isPush ? .push : .pull, time: end, confidence: conf,
                                                   duration: duration, side: side,
                                                   distanceMm: abs(side == .left ? dL : dR) / 2)))
        }
    }
}
