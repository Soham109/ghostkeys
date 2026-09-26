//! Knocks from the accelerometer, reduced for Windows: a knock count, no zones.
//!
//! Why reduced: the Mac reads its motion sensor near 800 Hz and classifies where a tap landed.
//! Windows.Devices.Sensors.Accelerometer lets the driver arbitrate ReportInterval; typical
//! minimums are 16 ms (about 60 Hz) or slower, and drivers often low-pass the signal. At that rate a
//! finger tap is one or two samples, too little to tell zones apart, but a firm knock on the case
//! is still a clear jump. So this detector only answers "was there a knock, and when", and the
//! gesture grammar counts them (tap / double / triple / rhythm) in the single `anywhere` zone.
//!
//! Signal chain, per sample (rate-agnostic, driven by sample timestamps):
//!   1. Level m = |a - lowpass(a)|, low-pass time constant 50 ms (removes gravity and posture).
//!   2. Noise floor: median of per-block medians over about 2 s (ignores the spikes themselves).
//!   3. Trigger when m > max(absolute floor, k * noise); k and the floor come from sensitivity.
//!   4. The pulse ends when m falls under half the trigger level. A pulse longer than 150 ms is
//!      the machine being moved or carried: rejected as "motion".
//!   5. Refractory 80 ms; 4 onsets within 0.5 s mute detection for 0.4 s ("burst").
//!   6. A gap of more than 0.5 s between samples (driver pause, sleep) resets the chain.

use super::BlockMedianFloor;
use crate::config::clamp;

#[derive(Debug, Clone, PartialEq)]
pub enum KnockOutput {
    Knock { t: f64, strength: f64 },
    Rejected { t: f64, reason: &'static str },
}

#[derive(Debug, Clone)]
pub struct KnockDetector {
    pub sensitivity: f64,
    pub lowpass_tau: f64,
    pub refractory: f64,
    pub max_pulse: f64,
    pub burst_count: usize,
    pub burst_window: f64,
    pub burst_lockout: f64,
    lp: Option<[f64; 3]>,
    last_t: Option<f64>,
    floor: BlockMedianFloor,
    pulse: Option<Pulse>,
    last_onset: f64,
    recent: Vec<f64>,
    lockout_until: f64,
    samples: usize,
    /// Last detection level in g, for the status `detector` diagnostics.
    pub level: f64,
}

#[derive(Debug, Clone)]
struct Pulse {
    onset: f64,
    peak: f64,
    threshold: f64,
    burst: bool,
    overlong: bool,
}

impl Default for KnockDetector {
    fn default() -> Self {
        KnockDetector {
            sensitivity: 0.5,
            lowpass_tau: 0.050,
            refractory: 0.080,
            max_pulse: 0.150,
            burst_count: 4,
            burst_window: 0.5,
            burst_lockout: 0.4,
            lp: None,
            last_t: None,
            // Block size is re-derived from the measured rate on the first samples; 8 blocks.
            floor: BlockMedianFloor::new(8, 8),
            pulse: None,
            last_onset: f64::NEG_INFINITY,
            recent: Vec::new(),
            lockout_until: f64::NEG_INFINITY,
            samples: 0,
            level: 0.0,
        }
    }
}

impl KnockDetector {
    /// Multiplier on the noise floor: strict 9x, sensitive 3x.
    pub fn noise_multiplier(&self) -> f64 {
        9.0 - 6.0 * clamp(self.sensitivity, 0.0, 1.0)
    }

    /// Absolute floor in g: strict 20 mg, sensitive 8 mg. Higher than the Mac's because Windows
    /// accelerometers are often quantized to a few mg and their median noise reads as zero.
    pub fn absolute_floor(&self) -> f64 {
        (20.0 - 12.0 * clamp(self.sensitivity, 0.0, 1.0)) / 1000.0
    }

    pub fn threshold(&self) -> f64 {
        self.absolute_floor().max(self.noise_multiplier() * self.floor.value)
    }

    /// Noise floor in g.
    pub fn noise(&self) -> f64 {
        self.floor.value
    }

    pub fn reset(&mut self) {
        let s = self.sensitivity;
        *self = KnockDetector { sensitivity: s, ..Default::default() };
    }

    /// Feed one accelerometer reading (g, Windows axes) with its time in seconds.
    pub fn process(&mut self, a: [f64; 3], t: f64) -> Option<KnockOutput> {
        if let Some(l) = self.last_t {
            if t - l > 0.5 || t < l {
                self.reset();
            }
        }
        let dt = self.last_t.map(|l| t - l).unwrap_or(0.0);
        self.last_t = Some(t);
        self.samples += 1;

        let Some(lp) = self.lp.as_mut() else {
            self.lp = Some(a);
            return None;
        };
        // Level against the low-pass before this sample, then update the low-pass.
        let d = [a[0] - lp[0], a[1] - lp[1], a[2] - lp[2]];
        let m = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt();
        self.level = m;
        let alpha = 1.0 - (-dt.max(0.0) / self.lowpass_tau).exp();
        for i in 0..3 {
            lp[i] += alpha * (a[i] - lp[i]);
        }

        // Size noise blocks to about 0.25 s once the rate is known (after 10 samples).
        if self.samples == 10 && dt > 0.0 {
            let per_block = ((0.25 / dt).round() as usize).clamp(3, 200);
            self.floor = BlockMedianFloor::new(per_block, 8);
        }
        // Only quiet samples feed the floor, so a knock does not raise its own threshold.
        if self.pulse.is_none() {
            self.floor.push(m);
        }

        if let Some(p) = self.pulse.as_mut() {
            p.peak = p.peak.max(m);
            let still_up = m > 0.5 * p.threshold;
            if !p.overlong && t - p.onset > self.max_pulse {
                p.overlong = true;
                let onset = p.onset;
                if !still_up {
                    self.pulse = None;
                }
                return Some(KnockOutput::Rejected { t: onset, reason: "motion" });
            }
            if still_up {
                return None;
            }
            let p = self.pulse.take().unwrap();
            if p.overlong {
                return None;
            }
            if p.burst {
                return Some(KnockOutput::Rejected { t: p.onset, reason: "burst" });
            }
            return Some(KnockOutput::Knock { t: p.onset, strength: clamp(p.peak / p.threshold / 4.0, 0.0, 1.0) });
        }

        if self.floor.blocks() < 2 {
            return None; // warm-up, about 0.5 s
        }
        let thr = self.threshold();
        if m <= thr || t - self.last_onset < self.refractory {
            return None;
        }
        self.last_onset = t;
        self.recent.push(t);
        let window = self.burst_window;
        self.recent.retain(|&r| t - r <= window);
        let mut burst = t < self.lockout_until;
        if self.recent.len() >= self.burst_count {
            self.lockout_until = t + self.burst_lockout;
            burst = true;
        }
        self.pulse = Some(Pulse { onset: t, peak: m, threshold: thr, burst, overlong: false });
        None
    }

    /// Onset time of a knock still being measured (for the grammar's in-flight hold).
    pub fn in_flight(&self) -> Option<f64> {
        self.pulse.as_ref().filter(|p| !p.overlong).map(|p| p.onset)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f64 = 1.0 / 60.0;

    /// Rest at 60 Hz with +-2 mg quantized noise; `knocks` adds a one-sample jump at those times.
    fn run(seconds: f64, knocks: &[f64], moves: &[(f64, f64)]) -> Vec<KnockOutput> {
        let mut d = KnockDetector::default();
        let mut out = vec![];
        let n = (seconds / DT) as usize;
        for i in 0..n {
            let t = i as f64 * DT;
            let noise = if i % 3 == 0 { 0.002 } else if i % 3 == 1 { -0.002 } else { 0.0 };
            let mut a = [noise, 0.0, -1.0 + noise];
            if knocks.iter().any(|&k| (t - k).abs() < DT / 2.0) {
                a[2] += 0.08;
                a[0] += 0.03;
            }
            for &(from, to) in moves {
                if t >= from && t <= to {
                    a[0] += 0.3 * ((t - from) * 20.0).sin();
                }
            }
            if let Some(o) = d.process(a, t) {
                out.push(o);
            }
        }
        out
    }

    fn knock_times(v: &[KnockOutput]) -> Vec<f64> {
        v.iter()
            .filter_map(|o| match o {
                KnockOutput::Knock { t, .. } => Some(*t),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn rest_is_silent() {
        assert!(run(5.0, &[], &[]).is_empty());
    }

    #[test]
    fn single_and_double_knocks_are_found() {
        let out = run(5.0, &[2.0, 3.0, 3.25], &[]);
        let t = knock_times(&out);
        assert_eq!(t.len(), 3, "{out:?}");
        assert!((t[0] - 2.0).abs() < 0.02);
        assert!((t[2] - 3.25).abs() < 0.02);
    }

    #[test]
    fn carrying_the_laptop_is_motion_not_knocks() {
        let out = run(5.0, &[], &[(2.0, 3.0)]);
        assert!(knock_times(&out).is_empty(), "{out:?}");
        assert!(out.iter().any(|o| matches!(o, KnockOutput::Rejected { reason: "motion", .. })));
    }

    #[test]
    fn drumming_triggers_burst_lockout() {
        let out = run(5.0, &[2.0, 2.1, 2.2, 2.3, 2.4], &[]);
        assert!(out.iter().any(|o| matches!(o, KnockOutput::Rejected { reason: "burst", .. })), "{out:?}");
        assert!(knock_times(&out).len() <= 3);
    }
}
