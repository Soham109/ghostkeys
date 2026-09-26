// Small signal-processing toolkit shared by the detectors. Everything here is pure and allocation-free on the hot path.
import Accelerate
import Foundation

enum DSPMath {
    /// Periodic Hann window (the right choice for spectral analysis with overlapping frames).
    static func periodicHann(_ n: Int) -> [Float] {
        var w = [Float](repeating: 0, count: n)
        for i in 0..<n { w[i] = 0.5 - 0.5 * cos(2 * Float.pi * Float(i) / Float(n)) }
        return w
    }

    /// Tukey (tapered cosine) window: flat in the middle, cosine ramps over `alpha / 2` of each end.
    /// Used for tap windows so the onset transient is not attenuated the way a Hann window would.
    static func tukey(_ n: Int, alpha: Float) -> [Float] {
        var w = [Float](repeating: 1, count: n)
        let ramp = max(1, Int(alpha * Float(n - 1) / 2))
        for i in 0..<min(ramp, n) {
            let v = 0.5 - 0.5 * cos(Float.pi * Float(i) / Float(ramp))
            w[i] = v
            w[n - 1 - i] = v
        }
        return w
    }

    @inline(__always) static func db(_ power: Float) -> Float { 10 * log10(max(power, 1e-20)) }

    @inline(__always) static func sum(_ p: UnsafePointer<Float>, _ n: Int) -> Float {
        guard n > 0 else { return 0 }
        var s: Float = 0
        vDSP_sve(p, 1, &s, vDSP_Length(n))
        return s
    }

    @inline(__always) static func meanSquare(_ p: UnsafePointer<Float>, _ n: Int) -> Float {
        guard n > 0 else { return 0 }
        var s: Float = 0
        vDSP_measqv(p, 1, &s, vDSP_Length(n))
        return s
    }

    @inline(__always) static func dot(_ a: UnsafePointer<Float>, _ b: UnsafePointer<Float>, _ n: Int) -> Float {
        guard n > 0 else { return 0 }
        var s: Float = 0
        vDSP_dotpr(a, 1, b, 1, &s, vDSP_Length(n))
        return s
    }

    static func median(_ values: [Float]) -> Float {
        guard !values.isEmpty else { return 0 }
        let s = values.sorted()
        return s.count % 2 == 1 ? s[s.count / 2] : 0.5 * (s[s.count / 2 - 1] + s[s.count / 2])
    }

    static func nextPowerOfTwo(atLeast n: Int) -> Int {
        var p = 1
        while p < n { p <<= 1 }
        return p
    }

    /// Ordinary least squares fit y = a + b x. Returns slope and R squared.
    static func linearFit(x: [Double], y: [Double]) -> (slope: Double, intercept: Double, r2: Double) {
        let n = Double(x.count)
        guard x.count >= 2 else { return (0, y.first ?? 0, 0) }
        let mx = x.reduce(0, +) / n, my = y.reduce(0, +) / n
        var sxx = 0.0, sxy = 0.0, syy = 0.0
        for i in 0..<x.count {
            let dx = x[i] - mx, dy = y[i] - my
            sxx += dx * dx; sxy += dx * dy; syy += dy * dy
        }
        guard sxx > 0 else { return (0, my, 0) }
        let slope = sxy / sxx
        let r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0
        return (slope, my - slope * mx, r2)
    }
}

/// Real-input FFT of a power-of-two size (vDSP split-complex radix-2).
final class RealFFT {
    let size: Int
    /// Number of spectrum bins, `size / 2 + 1` (DC through Nyquist).
    let bins: Int
    private let log2n: vDSP_Length
    private let setup: FFTSetup
    private var padded: [Float]
    private var re: [Float]
    private var im: [Float]

    init(size: Int) {
        precondition(size >= 8 && size & (size - 1) == 0, "FFT size must be a power of two")
        self.size = size
        bins = size / 2 + 1
        log2n = vDSP_Length(size.trailingZeroBitCount)
        setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2))!
        padded = [Float](repeating: 0, count: size)
        re = [Float](repeating: 0, count: size / 2)
        im = [Float](repeating: 0, count: size / 2)
    }

    deinit { vDSP_destroy_fftsetup(setup) }

    /// |X[k]|^2 of the (optionally windowed) input, zero-padded to `size`. Writes `bins` values to `out`.
    /// Scale: plain DFT (sum over samples), so a full-scale bin-centered sine of amplitude A under window w gives
    /// roughly (A * sum(w) / 2)^2 at its bin.
    func powerSpectrum(_ input: UnsafePointer<Float>, count: Int, window: UnsafePointer<Float>?, into out: UnsafeMutablePointer<Float>) {
        let half = size / 2
        let n = min(count, size)
        padded.withUnsafeMutableBufferPointer { pad in
            let p = pad.baseAddress!
            if let window { vDSP_vmul(input, 1, window, 1, p, 1, vDSP_Length(n)) } else { p.update(from: input, count: n) }
            if n < size { (p + n).update(repeating: 0, count: size - n) }
            re.withUnsafeMutableBufferPointer { r in
                im.withUnsafeMutableBufferPointer { i in
                    var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                    p.withMemoryRebound(to: DSPComplex.self, capacity: half) { c in
                        vDSP_ctoz(c, 2, &split, 1, vDSP_Length(half))
                    }
                    vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    let nyquist = i[0]
                    i[0] = 0
                    vDSP_zvmags(&split, 1, out, 1, vDSP_Length(half))
                    out[half] = nyquist * nyquist
                    var quarter: Float = 0.25 // zrip output is 2x the DFT
                    vDSP_vsmul(out, 1, &quarter, out, 1, vDSP_Length(half + 1))
                }
            }
        }
    }

    /// Inverse transform of a real, even spectrum given as `bins` values (for example a power spectrum), which yields
    /// the autocorrelation of the signal that produced it. Writes the first `count` lags (unnormalized) to `out`.
    func inverseEvenSpectrum(_ spectrum: UnsafePointer<Float>, into out: UnsafeMutablePointer<Float>, count: Int) {
        let half = size / 2
        re.withUnsafeMutableBufferPointer { r in
            im.withUnsafeMutableBufferPointer { i in
                r.baseAddress!.update(from: spectrum, count: half)
                i.baseAddress!.update(repeating: 0, count: half)
                i[0] = spectrum[half]
                var split = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                vDSP_fft_zrip(setup, &split, 1, log2n, FFTDirection(FFT_INVERSE))
                padded.withUnsafeMutableBufferPointer { pad in
                    pad.baseAddress!.withMemoryRebound(to: DSPComplex.self, capacity: half) { c in
                        vDSP_ztoc(&split, 1, c, 2, vDSP_Length(half))
                    }
                    out.update(from: pad.baseAddress!, count: min(count, size))
                }
            }
        }
    }
}

/// Cascade of biquad sections (vDSP). Keeps state between calls so it can filter a stream chunk by chunk.
final class BiquadFilter {
    private let setup: vDSP_biquad_Setup
    private var delay: [Float]
    let sections: Int

    /// `coefficients`: 5 per section, `[b0, b1, b2, a1, a2]` normalized so a0 = 1.
    init(coefficients: [Double]) {
        precondition(coefficients.count % 5 == 0 && !coefficients.isEmpty)
        sections = coefficients.count / 5
        setup = vDSP_biquad_CreateSetup(coefficients, vDSP_Length(sections))!
        delay = [Float](repeating: 0, count: 2 * sections + 2)
    }

    deinit { vDSP_biquad_DestroySetup(setup) }

    func reset() { for i in delay.indices { delay[i] = 0 } }

    func process(_ x: UnsafePointer<Float>, _ y: UnsafeMutablePointer<Float>, count: Int) {
        guard count > 0 else { return }
        delay.withUnsafeMutableBufferPointer { d in
            vDSP_biquad(setup, d.baseAddress!, x, 1, y, 1, vDSP_Length(count))
        }
    }

    func process(_ x: [Float]) -> [Float] {
        var y = [Float](repeating: 0, count: x.count)
        x.withUnsafeBufferPointer { xp in y.withUnsafeMutableBufferPointer { yp in
            process(xp.baseAddress!, yp.baseAddress!, count: x.count)
        } }
        return y
    }

    // RBJ audio-EQ-cookbook designs.
    static func highpass(cutoff: Double, sampleRate: Double, q: Double = 0.7071) -> [Double] {
        let w = 2 * Double.pi * cutoff / sampleRate, alpha = sin(w) / (2 * q), c = cos(w), a0 = 1 + alpha
        return [(1 + c) / 2 / a0, -(1 + c) / a0, (1 + c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0]
    }

    static func lowpass(cutoff: Double, sampleRate: Double, q: Double = 0.7071) -> [Double] {
        let w = 2 * Double.pi * cutoff / sampleRate, alpha = sin(w) / (2 * q), c = cos(w), a0 = 1 + alpha
        return [(1 - c) / 2 / a0, (1 - c) / a0, (1 - c) / 2 / a0, -2 * c / a0, (1 - alpha) / a0]
    }

    /// Constant 0 dB peak gain band-pass.
    static func bandpass(center: Double, q: Double, sampleRate: Double) -> [Double] {
        let w = 2 * Double.pi * center / sampleRate, alpha = sin(w) / (2 * q), c = cos(w), a0 = 1 + alpha
        return [alpha / a0, 0, -alpha / a0, -2 * c / a0, (1 - alpha) / a0]
    }
}

/// Triangular mel filterbank applied to a power spectrum.
struct MelFilterbank {
    let bandCount: Int
    private let starts: [Int]
    private let weights: [[Float]]

    init(bandCount: Int, fftSize: Int, sampleRate: Double, minHz: Double, maxHz: Double) {
        self.bandCount = bandCount
        let bins = fftSize / 2 + 1
        let binHz = sampleRate / Double(fftSize)
        func mel(_ f: Double) -> Double { 2595 * log10(1 + f / 700) }
        func hz(_ m: Double) -> Double { 700 * (pow(10, m / 2595) - 1) }
        let lo = mel(minHz), hi = mel(maxHz)
        let edges = (0..<(bandCount + 2)).map { hz(lo + (hi - lo) * Double($0) / Double(bandCount + 1)) }
        var starts: [Int] = [], weights: [[Float]] = []
        for b in 0..<bandCount {
            let l = edges[b], c = edges[b + 1], u = edges[b + 2]
            let first = max(1, Int(ceil(l / binHz))), last = min(bins - 1, Int(floor(u / binHz)))
            var w: [Float] = []
            if first <= last {
                for k in first...last {
                    let f = Double(k) * binHz
                    let v = f <= c ? (f - l) / max(c - l, 1e-9) : (u - f) / max(u - c, 1e-9)
                    w.append(Float(max(0, v)))
                }
            }
            if w.allSatisfy({ $0 <= 0 }) {
                // Band narrower than one bin: use the nearest bin so every band carries information.
                starts.append(min(bins - 1, max(1, Int((c / binHz).rounded()))))
                weights.append([1])
            } else {
                starts.append(first)
                weights.append(w)
            }
        }
        self.starts = starts
        self.weights = weights
    }

    func apply(_ power: UnsafePointer<Float>, into out: UnsafeMutablePointer<Float>) {
        for b in 0..<bandCount {
            out[b] = weights[b].withUnsafeBufferPointer { DSPMath.dot(power + starts[b], $0.baseAddress!, $0.count) }
        }
    }
}

/// Cuts a stream into overlapping frames of `frameSize` samples every `hop` samples.
final class SlidingFramer {
    let frameSize: Int
    let hop: Int
    private var buffer: [Float]
    private var filled = 0

    init(frameSize: Int, hop: Int) {
        precondition(hop > 0 && hop <= frameSize)
        self.frameSize = frameSize
        self.hop = hop
        buffer = [Float](repeating: 0, count: frameSize)
    }

    func reset() { filled = 0 }

    /// Calls `body(frame, endTime)` for every completed frame. `endTime` is the time just after the frame's last sample,
    /// derived from `time` (time of `samples[0]`).
    func push(_ samples: UnsafeBufferPointer<Float>, time: Double, sampleRate: Double,
              _ body: (UnsafePointer<Float>, Double) -> Void) {
        guard let src = samples.baseAddress else { return }
        let n = samples.count
        var i = 0
        while i < n {
            let take = min(frameSize - filled, n - i)
            buffer.withUnsafeMutableBufferPointer { b in (b.baseAddress! + filled).update(from: src + i, count: take) }
            filled += take
            i += take
            if filled == frameSize {
                buffer.withUnsafeBufferPointer { b in body(b.baseAddress!, time + Double(i) / sampleRate) }
                buffer.withUnsafeMutableBufferPointer { b in
                    let p = b.baseAddress!
                    p.update(from: p + hop, count: frameSize - hop)
                }
                filled = frameSize - hop
            }
        }
    }
}
