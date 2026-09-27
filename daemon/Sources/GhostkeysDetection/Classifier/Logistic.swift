// Multinomial logistic regression (L2-regularised) and one-dimensional Platt scaling, pure Swift.
//
// Objective (same as scikit-learn's LogisticRegression with C):
//     C * sum_i -log softmax(W x_i + b)[y_i]  +  0.5 * |W|^2        (bias not penalised)
// on standardized inputs, minimised with L-BFGS. With ~150 calibration samples, 33 features and
// under 10 classes this converges in well under 200 iterations.

import Foundation

struct LogisticModel: Codable, Sendable {
    var mean: [Double]
    var scale: [Double]
    /// weights[c] has one entry per feature; classes are the ZoneModel labels in order.
    var weights: [[Double]]
    var bias: [Double]

    func probabilities(_ x: [Double]) -> [Double] {
        let p = mean.count
        var z = [Double](repeating: 0, count: p)
        for j in 0..<p { z[j] = (x[j] - mean[j]) / scale[j] }
        var logits = bias
        for c in 0..<weights.count {
            var s = logits[c]
            for j in 0..<p { s += weights[c][j] * z[j] }
            logits[c] = s
        }
        return LogisticModel.softmax(logits)
    }

    /// Loss and gradient of the objective above. Marked for optimisation even in debug builds: it is
    /// the whole cost of training (about 6 ms per call unoptimised on 150 samples).
    @_optimize(speed)
    static func lossGrad(_ th: [Double], _ zf: [Double], _ y: [Int], n: Int, p: Int, k: Int, c: Double) -> (Double, [Double]) {
        let dim = k * (p + 1)
        // Plain pointers in this function's own body (closures would not inherit @_optimize).
        let t = UnsafeMutablePointer<Double>.allocate(capacity: dim)
        let z = UnsafeMutablePointer<Double>.allocate(capacity: n * p)
        let gr = UnsafeMutablePointer<Double>.allocate(capacity: dim)
        let lg = UnsafeMutablePointer<Double>.allocate(capacity: k)
        let yy = UnsafeMutablePointer<Int>.allocate(capacity: n)
        defer { t.deallocate(); z.deallocate(); gr.deallocate(); lg.deallocate(); yy.deallocate() }
        for i in 0..<dim { t[i] = th[i]; gr[i] = 0 }
        for i in 0..<(n * p) { z[i] = zf[i] }
        for i in 0..<n { yy[i] = y[i] }
        var loss = 0.0
        for cl in 0..<k {
            for j in 0..<p { let w = t[cl * (p + 1) + j]; loss += 0.5 * w * w; gr[cl * (p + 1) + j] = w }
        }
        for i in 0..<n {
            let zi = z + i * p
            var mx = -Double.infinity
            for cl in 0..<k {
                let o = t + cl * (p + 1)
                var s = o[p]
                for j in 0..<p { s += o[j] * zi[j] }
                lg[cl] = s
                if s > mx { mx = s }
            }
            var sum = 0.0
            for cl in 0..<k { lg[cl] = exp(lg[cl] - mx); sum += lg[cl] }
            loss -= c * log(max(lg[yy[i]] / sum, 1e-300))
            for cl in 0..<k {
                let d = c * (lg[cl] / sum - (cl == yy[i] ? 1 : 0))
                let o = gr + cl * (p + 1)
                for j in 0..<p { o[j] += d * zi[j] }
                o[p] += d
            }
        }
        return (loss, Array(UnsafeBufferPointer(start: gr, count: dim)))
    }

    static func softmax(_ l: [Double]) -> [Double] {
        let m = l.max() ?? 0
        let e = l.map { exp($0 - m) }
        let s = e.reduce(0, +)
        return e.map { $0 / s }
    }

    /// Fits on rows `x` with class indices `y` in 0..<classes.
    static func fit(_ x: [[Double]], _ y: [Int], classes k: Int, c: Double = 0.3, iterations: Int = 150,
                    warmStart: LogisticModel? = nil) -> LogisticModel {
        let n = x.count, p = x.first?.count ?? 0
        var mean = [Double](repeating: 0, count: p), scale = [Double](repeating: 1, count: p)
        for r in x { for j in 0..<p { mean[j] += r[j] } }
        for j in 0..<p { mean[j] /= Double(max(n, 1)) }
        for j in 0..<p {
            var v = 0.0
            for r in x { v += (r[j] - mean[j]) * (r[j] - mean[j]) }
            let sd = (v / Double(max(n, 1))).squareRoot()
            scale[j] = sd > 1e-12 ? sd : 1
        }
        // Flat, standardized design matrix; the loss loop below runs on raw buffers because it
        // dominates training time (debug builds check every array index otherwise).
        var zf = [Double](repeating: 0, count: n * p)
        for i in 0..<n { for j in 0..<p { zf[i * p + j] = (x[i][j] - mean[j]) / scale[j] } }
        let dim = k * (p + 1)   // per class: p weights then 1 bias
        func lossGrad(_ th: [Double]) -> (Double, [Double]) { LogisticModel.lossGrad(th, zf, y, n: n, p: p, k: k, c: c) }
        var start = [Double](repeating: 0, count: dim)
        if let w = warmStart, w.weights.count == k, w.weights.first?.count == p {
            for cl in 0..<k { for j in 0..<p { start[cl * (p + 1) + j] = w.weights[cl][j] }; start[cl * (p + 1) + p] = w.bias[cl] }
        }
        let theta = LBFGS.minimize(lossGrad, start: start, iterations: iterations)
        var w = [[Double]](), b = [Double]()
        for cl in 0..<k {
            let o = cl * (p + 1)
            w.append(Array(theta[o..<(o + p)])); b.append(theta[o + p])
        }
        return LogisticModel(mean: mean, scale: scale, weights: w, bias: b)
    }
}

/// Platt scaling: P(correct) = sigmoid(a * logit(raw) + b).
struct PlattScaling: Codable, Sendable {
    var a: Double
    var b: Double

    func apply(_ raw: Double) -> Double {
        let r = Stats.clamp(raw, 1e-4, 1 - 1e-4)
        return 1 / (1 + exp(-(a * log(r / (1 - r)) + b)))
    }

    /// Fits on (raw confidence, was correct) pairs; nil if there are no errors or no successes.
    static func fit(raw: [Double], correct: [Bool], c: Double = 10) -> PlattScaling? {
        guard correct.contains(true), correct.contains(false) else { return nil }
        let u = raw.map { r -> Double in let q = Stats.clamp(r, 1e-4, 1 - 1e-4); return log(q / (1 - q)) }
        func lossGrad(_ th: [Double]) -> (Double, [Double]) {
            var loss = 0.5 * th[0] * th[0], ga = th[0], gb = 0.0
            for (x, ok) in zip(u, correct) {
                let p = 1 / (1 + exp(-(th[0] * x + th[1])))
                loss -= c * (ok ? log(max(p, 1e-300)) : log(max(1 - p, 1e-300)))
                let d = c * (p - (ok ? 1 : 0))
                ga += d * x; gb += d
            }
            return (loss, [ga, gb])
        }
        let th = LBFGS.minimize(lossGrad, start: [1, 0], iterations: 200)
        return PlattScaling(a: th[0], b: th[1])
    }
}

/// Limited-memory BFGS with backtracking (Armijo) line search.
enum LBFGS {
    static func minimize(_ f: ([Double]) -> (Double, [Double]), start: [Double], iterations: Int, memory: Int = 8) -> [Double] {
        var x = start
        var (fx, g) = f(x)
        var sHist: [[Double]] = [], yHist: [[Double]] = []
        func dot(_ a: [Double], _ b: [Double]) -> Double { var s = 0.0; for i in 0..<a.count { s += a[i] * b[i] }; return s }
        for _ in 0..<iterations {
            // Two-loop recursion for the search direction.
            var q = g
            var alphas: [Double] = []
            for i in stride(from: sHist.count - 1, through: 0, by: -1) {
                let rho = 1 / dot(yHist[i], sHist[i])
                let a = rho * dot(sHist[i], q)
                alphas.append(a)
                for j in 0..<q.count { q[j] -= a * yHist[i][j] }
            }
            if let s = sHist.last, let yv = yHist.last {
                let gamma = dot(s, yv) / dot(yv, yv)
                for j in 0..<q.count { q[j] *= gamma }
            }
            for (n, i) in (0..<sHist.count).enumerated() {
                let rho = 1 / dot(yHist[i], sHist[i])
                let bta = rho * dot(yHist[i], q)
                let a = alphas[sHist.count - 1 - n]
                for j in 0..<q.count { q[j] += sHist[i][j] * (a - bta) }
            }
            let dir = q.map { -$0 }
            var slope = dot(g, dir)
            var d = dir
            if slope >= 0 { d = g.map { -$0 }; slope = -dot(g, g); sHist.removeAll(); yHist.removeAll() }
            var step = 1.0
            var xn = x, fn = fx, gn = g
            var accepted = false
            for _ in 0..<30 {
                for j in 0..<x.count { xn[j] = x[j] + step * d[j] }
                (fn, gn) = f(xn)
                        if fn <= fx + 1e-4 * step * slope { accepted = true; break }
                step *= 0.5
            }
            guard accepted else { break }
            let s = zip(xn, x).map { $0 - $1 }, yv = zip(gn, g).map { $0 - $1 }
            if dot(s, yv) > 1e-12 {
                sHist.append(s); yHist.append(yv)
                if sHist.count > memory { sHist.removeFirst(); yHist.removeFirst() }
            }
            let improvement = fx - fn
            x = xn; fx = fn; g = gn
            if improvement < 1e-9 * max(1, abs(fx)) || dot(g, g) < 1e-12 { break }
        }
        return x
    }
}
