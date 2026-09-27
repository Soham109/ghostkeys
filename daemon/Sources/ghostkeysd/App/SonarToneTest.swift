import Foundation
import GhostkeysAcoustics

/// `--sonar-tone-test S`: proves the sonar playback path starts on this Mac without making a sound. It builds the
/// same output-only engine and the same stereo source as sonar (via `TonePlayer`), but the generator's amplitudes are
/// 0, so every rendered sample is exactly 0. No microphone, no sensors, no lock.
enum SonarToneTest {
    static func run(seconds: Double) -> Int32 {
        let route = OutputRoute.current()
        let rate = TonePlayer.outputSampleRate()
        print("output route: \(SoundSession.describe(route)) (sonar would \(route.allowsPilotTone ? "be allowed" : "be refused") here)")
        print("output nominal sample rate: \(rate.map { "\(Int($0)) Hz" } ?? "unreadable")")
        // Silent: both amplitudes 0 (the generator clamps, never raises). The route check is bypassed only because
        // nothing audible can play; the real sonar path keeps it.
        let g = StereoPilotGenerator(sampleRate: rate ?? GhostkeysAcousticsInfo.sampleRate, leftAmplitude: 0, rightAmplitude: 0,
                                     routeCheck: { .builtInSpeaker })
        guard g.leftAmplitude == 0, g.rightAmplitude == 0 else { print("refusing: amplitude is not 0"); return 1 }
        let lock = NSLock()
        var frames = 0, nonZero = 0
        let player = TonePlayer()
        var changed = false
        player.onConfigurationChange = { changed = true }
        do {
            try g.start()
            try player.start(channels: 2, sampleRate: g.sampleRate) { buffers, n in
                guard buffers.count >= 2, let l = buffers[0].mData?.assumingMemoryBound(to: Float.self),
                      let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) else { return }
                g.render(left: l, right: r, count: n)
                var nz = 0
                for i in 0..<n where l[i] != 0 || r[i] != 0 { nz += 1 }
                lock.lock(); frames += n; nonZero += nz; lock.unlock()
            }
        } catch {
            let ns = error as NSError
            print("FAIL: playback engine did not start: \(SoundSession.describe(error)) [\(ns.domain) \(ns.code)]")
            return 1
        }
        print("playback engine started (silent), running \(Int(seconds)) s ...")
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            RunLoop.current.run(until: min(end, Date().addingTimeInterval(0.25)))
            _ = g.renew()
        }
        let running = player.isPlaying
        g.stopImmediately()
        player.stop()
        lock.lock(); let f = frames, nz = nonZero; lock.unlock()
        print("rendered \(f) frames (\(String(format: "%.1f", Double(f) / (rate ?? 48_000))) s of output), non-zero samples: \(nz)"
              + (changed ? ", audio configuration changed during the test" : ""))
        let ok = f > 0 && nz == 0 && running
        print(ok ? "OK: the sonar output starts and runs on this Mac" : "FAIL: output \(running ? "ran" : "stopped") but rendered \(f) frames")
        return ok ? 0 : 1
    }
}
