import Foundation
import Darwin
import GhostkeysAcoustics

/// `ghostkeys-lab sonar-bench [--seconds N]`: the SonarField real-hardware check, gated on typed consent.
/// Plays two inaudible tones (the generators enforce -30 dBFS combined, built-in speakers only, fades, auto-stop) and
/// records the microphone for up to 20 s. Never runs without the exact consent phrase, and never while a Ghostkeys
/// daemon has the microphone open.
func runSonarBench(_ args: Args) throws {
    let seconds = try args.double("seconds", 15)

    // A running daemon mic session (sound or sonar) would fight over the mic and the speakers.
    if let holder = daemonMicHolder() {
        throw LabError("a Ghostkeys sound or sonar session is running (ghostkeysd pid \(holder)); stop it or quit Ghostkeys first")
    }

    print(SonarBench.disclosure)
    print("")
    print("Type \(SonarBench.consentPhrase) and press Return to start (anything else cancels): ", terminator: "")
    fflush(stdout)
    guard let typed = readLine(strippingNewline: true) else { throw LabError("no input; not starting") }
    let consent = SonarBench.Consent(typed: typed)
    guard consent.granted else {
        print("Not the consent phrase. Nothing was played or recorded.")
        return
    }
    let report = try SonarBench.run(consent: consent, seconds: seconds) { print($0) }
    print("")
    print("route               \(report.route)")
    print(String(format: "pilot SNR           left %.1f dB, right %.1f dB (SonarField needs at least 25 dB)",
                 report.medianSnrLeftDb, report.medianSnrRightDb))
    print(String(format: "interference        %.0f%% of readings", report.interferenceShare * 100))
    print(String(format: "largest path swing  left %.0f mm, right %.0f mm", report.maxPathSwingLeftMm, report.maxPathSwingRightMm))
    print("gestures            \(report.gestures.isEmpty ? "none" : report.gestures.joined(separator: ", "))")
    print("air events          \(report.airEvents)")
}

/// The pid in ghostkeysd's mic marker (<default daemon dir>/mic.active), if that process is still alive.
private func daemonMicHolder() -> Int32? {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    let url = base.appendingPathComponent("Ghostkeys/daemon/mic.active")
    guard let s = try? String(contentsOf: url, encoding: .utf8),
          let pid = Int32(s.trimmingCharacters(in: .whitespacesAndNewlines)) else { return nil }
    return (kill(pid, 0) == 0 || errno == EPERM) ? pid : nil
}
