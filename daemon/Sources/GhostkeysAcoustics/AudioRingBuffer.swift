import Foundation

/// Fixed-length history of the most recent mono audio (default 200 ms), addressable by stream time.
///
/// The writer (the audio tap) and readers (tap classification) may be on different threads; access is locked.
/// Time is whatever clock the writer passes in (the session uses host time in seconds, the same clock as the IMU).
public final class AudioRingBuffer: @unchecked Sendable {
    public let sampleRate: Double
    public let capacity: Int
    private var storage: [Float]
    private var writeIndex = 0
    private var available = 0
    private var endTime: Double = 0
    private let lock = NSLock()
    /// A write whose start time differs from the previous write's end by more than this is a discontinuity:
    /// the history is cleared so reads never splice unrelated audio together.
    public var discontinuityTolerance: Double = 0.005

    public init(duration: Double = 0.2, sampleRate: Double = 48_000) {
        self.sampleRate = sampleRate
        capacity = max(1, Int((duration * sampleRate).rounded()))
        storage = [Float](repeating: 0, count: capacity)
    }

    /// Appends samples whose first sample is at `time`.
    public func write(_ samples: UnsafeBufferPointer<Float>, time: Double) {
        guard let src = samples.baseAddress, !samples.isEmpty else { return }
        lock.lock(); defer { lock.unlock() }
        if available > 0 && abs(time - endTime) > discontinuityTolerance { available = 0; writeIndex = 0 }
        var n = samples.count
        var s = src
        if n > capacity { s = src + (n - capacity); n = capacity }
        storage.withUnsafeMutableBufferPointer { st in
            let first = min(n, capacity - writeIndex)
            (st.baseAddress! + writeIndex).update(from: s, count: first)
            if first < n { st.baseAddress!.update(from: s + first, count: n - first) }
        }
        writeIndex = (writeIndex + n) % capacity
        available = min(capacity, available + n)
        endTime = time + Double(samples.count) / sampleRate
    }

    public func write(_ samples: [Float], time: Double) {
        samples.withUnsafeBufferPointer { write($0, time: time) }
    }

    /// Time span currently held: from the oldest sample's time to the time just after the newest sample.
    public var timeRange: ClosedRange<Double>? {
        lock.lock(); defer { lock.unlock() }
        guard available > 0 else { return nil }
        return (endTime - Double(available) / sampleRate)...endTime
    }

    /// `count` samples starting at `startTime`, or nil if that span is not (or no longer) in the buffer.
    public func read(from startTime: Double, count: Int) -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        guard count > 0, available > 0 else { return nil }
        let oldest = endTime - Double(available) / sampleRate
        let offset = Int(((startTime - oldest) * sampleRate).rounded())
        guard offset >= 0, offset + count <= available else { return nil }
        var out = [Float](repeating: 0, count: count)
        let start = ((writeIndex - available + offset) % capacity + capacity) % capacity
        storage.withUnsafeBufferPointer { st in
            out.withUnsafeMutableBufferPointer { o in
                let first = min(count, capacity - start)
                o.baseAddress!.update(from: st.baseAddress! + start, count: first)
                if first < count { (o.baseAddress! + first).update(from: st.baseAddress!, count: count - first) }
            }
        }
        return out
    }

    /// The newest `count` samples (fewer if the buffer holds fewer).
    public func latest(_ count: Int) -> [Float] {
        let range = timeRange
        guard let range else { return [] }
        let n = min(count, Int(((range.upperBound - range.lowerBound) * sampleRate).rounded()))
        return read(from: range.upperBound - Double(n) / sampleRate, count: n) ?? []
    }

    public func clear() {
        lock.lock(); defer { lock.unlock() }
        available = 0
        writeIndex = 0
    }
}
