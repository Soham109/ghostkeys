// Which saved calibration samples survive a new calibration run.
//
// The calibration wizard lets the user redo only some zones. A run replaces the samples of the labels it
// captured and keeps every other zone's saved samples, so redoing two zones never erases the other six.

import Foundation

public enum CalibrationMerge {
    /// Saved samples of labels the run did not capture, followed by all of the run's samples.
    /// Saved samples of zones no longer in `knownZones` are dropped. "none" is replaced only when the run
    /// captured negatives; otherwise the saved negatives are kept.
    public static func merge<S>(saved: [S], run: [S], knownZones: Set<String>, label: (S) -> String) -> [S] {
        let recaptured = Set(run.map(label))
        let kept = saved.filter {
            let l = label($0)
            return !recaptured.contains(l) && (l == "none" || knownZones.contains(l))
        }
        return kept + run
    }
}
