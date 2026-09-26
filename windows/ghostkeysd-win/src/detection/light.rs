//! Cover the ambient light sensor with a hand. Port of LightGestureDetector.swift.
//!
//! - Baseline: exponential average of the light value (5 s time constant), updated only while not
//!   covered. Ignored while the baseline is below 0.05 (a dark room: covering changes nothing).
//! - Covered: the value falls below 30% of the baseline and some reading in the previous 0.5 s was
//!   still at 60% of the baseline or more (a fast drop; dimming lights or a cloud are slow).
//! - "cover": the value comes back above 50% of the pre-cover baseline within 2 s, no hold emitted.
//! - "cover_hold": still covered 1.2 s after the drop. Once per cover; the release after a hold emits nothing.
//! - Covered for more than 10 s: a lighting change; re-baseline.
//!
//! Windows light sensors often report only on change (LightSensor.ReadingChanged), so the daemon
//! calls `poll` every 100 ms for cover_hold to fire on time.
//!
//! Input is the same normalized 0...1 value the Mac sends: log10(1 + lux) / log10(1 + 3000).

use std::collections::VecDeque;

use super::GestureEvent;
use crate::config::clamp;

pub const LUX_FULL_SCALE: f64 = 3000.0;

/// Lux to the protocol's 0...1 light value (same log scale as the Mac daemon).
pub fn normalize_lux(lux: f64) -> f64 {
    let lux = if lux.is_finite() { lux.max(0.0) } else { 0.0 };
    ((1.0 + lux).log10() / (1.0 + LUX_FULL_SCALE).log10()).min(1.0)
}

#[derive(Debug, Clone)]
pub struct LightGestureDetector {
    pub drop_fraction: f64,
    pub fast_drop_window: f64,
    pub recover_fraction: f64,
    pub cover_max_duration: f64,
    pub hold_after: f64,
    pub dark_baseline: f64,
    pub baseline_seconds: f64,
    baseline: Option<f64>,
    last_t: Option<f64>,
    history: VecDeque<(f64, f64)>,
    cover_start: Option<f64>,
    cover_baseline: f64,
    hold_emitted: bool,
}

impl Default for LightGestureDetector {
    fn default() -> Self {
        LightGestureDetector {
            drop_fraction: 0.30,
            fast_drop_window: 0.5,
            recover_fraction: 0.5,
            cover_max_duration: 2.0,
            hold_after: 1.2,
            dark_baseline: 0.05,
            baseline_seconds: 5.0,
            baseline: None,
            last_t: None,
            history: VecDeque::new(),
            cover_start: None,
            cover_baseline: 0.0,
            hold_emitted: false,
        }
    }
}

impl LightGestureDetector {
    pub fn reset(&mut self) {
        self.baseline = None;
        self.last_t = None;
        self.history.clear();
        self.cover_start = None;
    }

    pub fn ingest(&mut self, value: f64, t: f64) -> Option<GestureEvent> {
        let r = self.ingest_inner(clamp(value, 0.0, 1.0), t);
        self.last_t = Some(t);
        r
    }

    fn ingest_inner(&mut self, v: f64, t: f64) -> Option<GestureEvent> {
        let Some(base) = self.baseline else {
            self.baseline = Some(v);
            self.history.push_back((t, v));
            return None;
        };

        if let Some(start) = self.cover_start {
            if v >= self.recover_fraction * self.cover_baseline {
                self.cover_start = None;
                self.history.clear();
                self.history.push_back((t, v));
                if !self.hold_emitted && t - start <= self.cover_max_duration {
                    return Some(GestureEvent::zoneless("cover", t));
                }
                return None;
            }
            if t - start > 10.0 {
                self.cover_start = None;
                self.baseline = Some(v);
                self.history.clear();
                return None;
            }
            return self.poll(t);
        }

        // Not covered.
        self.history.push_back((t, v));
        while let Some(&(ft, _)) = self.history.front() {
            if t - ft > self.fast_drop_window {
                self.history.pop_front();
            } else {
                break;
            }
        }
        if base >= self.dark_baseline && v < self.drop_fraction * base && self.history.iter().any(|&(_, hv)| hv >= 0.6 * base) {
            self.cover_start = Some(t);
            self.cover_baseline = base;
            self.hold_emitted = false;
            return None;
        }
        let dt = self.last_t.map(|l| (t - l).max(0.0)).unwrap_or(0.0);
        self.baseline = Some(base + (dt / self.baseline_seconds).min(1.0) * (v - base));
        None
    }

    /// Time-based check for cover_hold when no new readings arrive.
    pub fn poll(&mut self, t: f64) -> Option<GestureEvent> {
        let start = self.cover_start?;
        if self.hold_emitted || t - start < self.hold_after {
            return None;
        }
        self.hold_emitted = true;
        Some(GestureEvent::zoneless("cover_hold", t))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(d: &mut LightGestureDetector, from: f64, to: f64, v: f64) -> Vec<String> {
        let mut out = vec![];
        let mut t = from;
        while t < to - 1e-9 {
            if let Some(g) = d.ingest(v, t) {
                out.push(g.gesture);
            }
            t += 0.05;
        }
        out
    }

    #[test]
    fn quick_cover_emits_cover() {
        let mut d = LightGestureDetector::default();
        assert!(feed(&mut d, 0.0, 3.0, 0.6).is_empty());
        assert!(feed(&mut d, 3.0, 3.6, 0.05).is_empty());
        assert_eq!(feed(&mut d, 3.6, 4.0, 0.6), ["cover"]);
    }

    #[test]
    fn long_cover_emits_hold_once_and_nothing_on_release() {
        let mut d = LightGestureDetector::default();
        feed(&mut d, 0.0, 3.0, 0.6);
        assert!(d.ingest(0.05, 3.0).is_none());
        assert!(d.poll(3.5).is_none());
        assert_eq!(d.poll(4.3).map(|g| g.gesture), Some("cover_hold".into()));
        assert!(d.poll(4.5).is_none());
        assert!(feed(&mut d, 4.6, 5.0, 0.6).is_empty());
    }

    #[test]
    fn slow_dimming_is_not_a_cover() {
        let mut d = LightGestureDetector::default();
        let mut t = 0.0;
        let mut v = 0.6;
        let mut out = vec![];
        while t < 20.0 {
            if let Some(g) = d.ingest(v, t) {
                out.push(g.gesture);
            }
            v *= 0.99;
            t += 0.1;
        }
        assert!(out.is_empty());
    }

    #[test]
    fn dark_room_is_ignored() {
        let mut d = LightGestureDetector::default();
        feed(&mut d, 0.0, 3.0, 0.03);
        assert!(feed(&mut d, 3.0, 3.5, 0.0).is_empty());
        assert!(feed(&mut d, 3.5, 4.0, 0.03).is_empty());
    }

    #[test]
    fn lux_normalization_matches_mac_scale() {
        assert_eq!(normalize_lux(0.0), 0.0);
        assert!((normalize_lux(3000.0) - 1.0).abs() < 1e-12);
        assert_eq!(normalize_lux(1e9), 1.0);
        assert_eq!(normalize_lux(f64::NAN), 0.0);
    }
}
