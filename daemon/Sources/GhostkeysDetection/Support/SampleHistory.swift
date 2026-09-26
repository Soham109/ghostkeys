// Fixed-capacity sample history addressed by absolute sample index.
//
// The tap detector needs to look back ~120 ms (gravity baseline + pre-onset window) and forward
// ~135 ms (post-onset window, pulse width limit) around every onset. Samples are stored as plain
// Doubles in parallel arrays: SIMD3 generics are slow in unoptimised (debug/test) builds.

struct SampleHistory {
    let capacity: Int
    private var ts: [Double]
    private var ax: [Double], ay: [Double], az: [Double]
    private var gx: [Double], gy: [Double], gz: [Double]
    /// Total number of samples ever appended. The newest sample has index `count - 1`.
    private(set) var count: Int = 0

    init(capacity: Int) {
        self.capacity = capacity
        ts = Array(repeating: 0, count: capacity)
        ax = ts; ay = ts; az = ts; gx = ts; gy = ts; gz = ts
    }

    mutating func append(_ s: IMUSample) {
        let k = count % capacity
        ts[k] = s.t
        ax[k] = s.a.x; ay[k] = s.a.y; az[k] = s.a.z
        gx[k] = s.g.x; gy[k] = s.g.y; gz[k] = s.g.z
        count += 1
    }

    mutating func removeAll() { count = 0 }

    /// Oldest index still stored.
    var firstIndex: Int { max(0, count - capacity) }

    func contains(_ i: Int) -> Bool { i >= firstIndex && i < count }

    /// Clamps an index into the stored range (used when the stream is younger than a window).
    func clamp(_ i: Int) -> Int { min(max(i, firstIndex), max(count - 1, 0)) }

    @inline(__always) func time(_ i: Int) -> Double { ts[i % capacity] }
    @inline(__always) func accel(_ i: Int, _ axis: Int) -> Double {
        let k = i % capacity
        switch axis { case 0: return ax[k]; case 1: return ay[k]; default: return az[k] }
    }
    @inline(__always) func gyro(_ i: Int, _ axis: Int) -> Double {
        let k = i % capacity
        switch axis { case 0: return gx[k]; case 1: return gy[k]; default: return gz[k] }
    }
}
