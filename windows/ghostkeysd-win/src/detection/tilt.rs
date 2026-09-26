//! Tilt gesture: the laptop is rolled sideways by more than 8 degrees and brought back within 2 s.
//! Port of TiltDetector.swift, fed a roll angle instead of a gravity vector so it works with either
//! the accelerometer or the inclinometer.
//!
//! Windows sensor axes (Microsoft "Sensor coordinate system"): x points right, y points up along the
//! display, z points out of the display toward the user. A still accelerometer reads gravity itself
//! (flat on a table, screen up: z = -1 g). If the right side goes down, gravity leans toward +x, so
//!     roll = atan2(ax, sqrt(ay^2 + az^2))     (degrees, positive = right side down)
//! This holds whether the sensor sits in the base (z carries gravity) or in the lid of a 2-in-1
//! (y carries gravity). `roll_sign` flips it should a driver report the other convention.

#[derive(Debug, Clone)]
enum State {
    Idle,
    Excursion { start: f64, peak: f64 },
}

#[derive(Debug, Clone)]
pub struct TiltDetector {
    pub trigger_degrees: f64,
    pub return_degrees: f64,
    pub max_duration: f64,
    pub baseline_seconds: f64,
    pub roll_sign: f64,
    state: State,
    baseline: Option<f64>,
    last_t: Option<f64>,
}

impl Default for TiltDetector {
    fn default() -> Self {
        TiltDetector {
            trigger_degrees: 8.0,
            return_degrees: 3.0,
            max_duration: 2.0,
            baseline_seconds: 1.0,
            roll_sign: 1.0,
            state: State::Idle,
            baseline: None,
            last_t: None,
        }
    }
}

/// Roll in degrees from an accelerometer reading in g (Windows axes, see module docs).
pub fn roll_from_accel(a: [f64; 3]) -> f64 {
    a[0].atan2((a[1] * a[1] + a[2] * a[2]).sqrt()).to_degrees()
}

impl TiltDetector {
    pub fn reset(&mut self) {
        self.state = State::Idle;
        self.baseline = None;
        self.last_t = None;
    }

    /// True while the machine is off its resting roll (used as the "motion" gate for knocks).
    pub fn in_excursion(&self) -> bool {
        matches!(self.state, State::Excursion { .. })
    }

    /// Feed roll (degrees) at the sensor rate. Returns "tilt_left" / "tilt_right".
    pub fn process(&mut self, roll_degrees: f64, t: f64) -> Option<&'static str> {
        let roll = self.roll_sign * roll_degrees;
        let dt = self.last_t.map(|l| t - l).unwrap_or(0.0);
        self.last_t = Some(t);
        let Some(base) = self.baseline else {
            self.baseline = Some(roll);
            return None;
        };
        let dev = roll - base;
        match self.state.clone() {
            State::Idle => {
                if dev.abs() > self.trigger_degrees {
                    self.state = State::Excursion { start: t, peak: dev };
                } else if dev.abs() < self.return_degrees {
                    // Slowly follow the resting roll (desk not level, lap, stand).
                    let a = (dt / self.baseline_seconds).min(1.0);
                    self.baseline = Some(base + a * dev);
                } else {
                    // 3 to 8 degrees off: a slow change of resting position. Re-baseline slowly.
                    let a = (dt / (4.0 * self.baseline_seconds)).min(1.0);
                    self.baseline = Some(base + a * dev);
                }
                None
            }
            State::Excursion { start, peak } => {
                let new_peak = if dev.abs() > peak.abs() { dev } else { peak };
                if t - start > self.max_duration {
                    // Held too long: not a gesture, the machine now rests at a new angle.
                    self.state = State::Idle;
                    self.baseline = Some(roll);
                    return None;
                }
                if dev.abs() < self.return_degrees {
                    self.state = State::Idle;
                    return Some(if new_peak > 0.0 { "tilt_right" } else { "tilt_left" });
                }
                self.state = State::Excursion { start, peak: new_peak };
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(d: &mut TiltDetector, samples: &[(f64, f64)]) -> Vec<&'static str> {
        samples.iter().filter_map(|&(t, r)| d.process(r, t)).collect()
    }

    #[test]
    fn roll_and_back_is_a_tilt() {
        let mut d = TiltDetector::default();
        let mut s: Vec<(f64, f64)> = (0..60).map(|i| (i as f64 / 60.0, 0.0)).collect();
        s.extend([(1.1, 5.0), (1.2, 12.0), (1.4, 14.0), (1.6, 6.0), (1.8, 1.0)]);
        assert_eq!(run(&mut d, &s), ["tilt_right"]);
        let mut d = TiltDetector::default();
        let s = [(0.0, 0.0), (0.5, 0.0), (1.0, -10.0), (1.5, 0.5)];
        assert_eq!(run(&mut d, &s), ["tilt_left"]);
    }

    #[test]
    fn held_too_long_rebaselines() {
        let mut d = TiltDetector::default();
        let s = [(0.0, 0.0), (0.5, 0.0), (1.0, 12.0), (2.0, 12.0), (3.5, 12.0), (4.0, 12.0), (4.5, 12.0)];
        assert!(run(&mut d, &s).is_empty());
    }

    #[test]
    fn roll_from_accel_signs() {
        // Flat, screen up.
        assert!(roll_from_accel([0.0, 0.0, -1.0]).abs() < 1e-9);
        // Right side down: gravity toward +x.
        let r = roll_from_accel([0.17, 0.0, -0.98]);
        assert!(r > 9.0 && r < 11.0, "{r}");
        // Lid-mounted sensor, screen upright, rolled left.
        assert!(roll_from_accel([-0.17, -0.98, 0.0]) < -9.0);
    }
}
