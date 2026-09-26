//! Turns accepted taps into gestures. A line-for-line port of GestureGrammar.swift.
//!
//! Rules (times are tap onset times; gaps are onset to onset):
//! - Zones NOT in `zones_needing_multi_tap`: every tap is emitted as "tap" at once (lowest latency).
//!   Such zones never produce double/triple/rhythm.
//! - Zones in `zones_needing_multi_tap`: taps are grouped. A tap joins the open group of the same zone
//!   if the gap is 80 ms ... double window. Gaps under 80 ms are one tap (bounce). The group closes
//!   when the double window has passed since its last tap, emitting "tap" (1) or "double" (2).
//!   A third tap emits "triple" immediately.
//! - "rhythm": a single tap, a pause of 350...900 ms (single tap to first tap of the double), then a
//!   double in the same zone. Emitted instead of that "double".
//! - "sequence": a lone tap in zone A, then a tap in a different zone B within 500 ms.
//!
//! On Windows there is only the `anywhere` zone, so "sequence" never fires; it is kept so the port
//! stays exact and zones can be added later without touching this file.

use std::collections::BTreeSet;

use super::{GestureEvent, TapEvent};

#[derive(Debug, Clone)]
struct Group {
    zone: String,
    times: Vec<f64>,
    confidences: Vec<f64>,
    modifiers: BTreeSet<String>,
}

#[derive(Debug, Clone)]
struct Lone {
    zone: String,
    t: f64,
    confidence: f64,
    modifiers: BTreeSet<String>,
}

#[derive(Debug, Clone)]
pub struct GestureGrammar {
    pub zones_needing_multi_tap: BTreeSet<String>,
    pub double_window: f64,
    pub min_gap: f64,
    pub sequence_window: f64,
    pub rhythm_pause: (f64, f64),
    pending: Option<Group>,
    last_lone: Option<Lone>,
    last_single: Option<(String, f64)>,
}

impl Default for GestureGrammar {
    fn default() -> Self {
        GestureGrammar {
            zones_needing_multi_tap: BTreeSet::new(),
            double_window: 0.350,
            min_gap: 0.080,
            sequence_window: 0.500,
            rhythm_pause: (0.350, 0.900),
            pending: None,
            last_lone: None,
            last_single: None,
        }
    }
}

impl GestureGrammar {
    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// When the pending group would close if nothing else arrives.
    pub fn pending_deadline(&self) -> Option<f64> {
        self.pending.as_ref().map(|p| p.times.last().copied().unwrap_or(0.0) + self.double_window)
    }

    pub fn reset(&mut self) {
        self.pending = None;
        self.last_lone = None;
        self.last_single = None;
    }

    pub fn accept(&mut self, tap: &TapEvent) -> Vec<GestureEvent> {
        let mut out = Vec::new();
        let z = tap.zone.as_str();
        let t = tap.t;
        let multi = self.zones_needing_multi_tap.contains(z);

        // Bounce: a second trigger under 80 ms in the same zone is the same tap.
        if let Some(p) = &self.pending {
            if p.zone == z {
                if let Some(last) = p.times.last() {
                    if t - last < self.min_gap {
                        return out;
                    }
                }
            }
        }
        if let Some(l) = &self.last_lone {
            if l.zone == z && t - l.t < self.min_gap && !multi {
                return out;
            }
        }

        // Sequence: lone tap in another zone shortly before.
        if let Some(l) = self.last_lone.clone() {
            if l.zone != z && t - l.t <= self.sequence_window {
                let pending_is_that_tap =
                    self.pending.as_ref().map(|p| p.zone == l.zone && p.times.len() == 1).unwrap_or(false);
                let other_pending = self.pending.is_some() && !pending_is_that_tap;
                if !other_pending {
                    if pending_is_that_tap {
                        self.pending = None;
                    }
                    if !multi {
                        out.push(gesture("tap", Some(z), vec![z.into()], t, tap.confidence, &tap.modifiers));
                    }
                    let mods: BTreeSet<String> = l.modifiers.union(&tap.modifiers).cloned().collect();
                    out.push(gesture(
                        "sequence",
                        None,
                        vec![l.zone.clone(), z.into()],
                        t,
                        l.confidence.min(tap.confidence),
                        &mods,
                    ));
                    self.last_lone = None;
                    self.last_single = None;
                    return out;
                }
            }
        }

        // A different zone (or an expired group) closes the open group first.
        if let Some(p) = &self.pending {
            let last = p.times.last().copied().unwrap_or(t);
            if p.zone != z || t - last > self.double_window {
                out.extend(self.close());
            }
        }

        if !multi {
            out.push(gesture("tap", Some(z), vec![z.into()], t, tap.confidence, &tap.modifiers));
            self.last_lone = Some(Lone { zone: z.into(), t, confidence: tap.confidence, modifiers: tap.modifiers.clone() });
            return out;
        }

        if let Some(mut p) = self.pending.take() {
            p.times.push(t);
            p.confidences.push(tap.confidence);
            if p.times.len() >= 3 {
                let conf = p.confidences.iter().copied().fold(f64::INFINITY, f64::min);
                out.push(gesture("triple", Some(z), vec![z.into()], t, conf, &p.modifiers));
                self.last_single = None;
            } else {
                self.pending = Some(p);
            }
            self.last_lone = None;
        } else {
            self.pending = Some(Group {
                zone: z.into(),
                times: vec![t],
                confidences: vec![tap.confidence],
                modifiers: tap.modifiers.clone(),
            });
            self.last_lone = Some(Lone { zone: z.into(), t, confidence: tap.confidence, modifiers: tap.modifiers.clone() });
        }
        out
    }

    /// Closes the open group once its window has passed. `oldest_in_flight` is the onset time of the
    /// oldest spike still being analysed (its tap would arrive later but may belong to the group).
    pub fn tick(&mut self, now: f64, oldest_in_flight: Option<f64>) -> Vec<GestureEvent> {
        let Some(deadline) = self.pending_deadline() else { return vec![] };
        if now <= deadline {
            return vec![];
        }
        if let Some(o) = oldest_in_flight {
            if o <= deadline {
                return vec![];
            }
        }
        self.close()
    }

    fn close(&mut self) -> Vec<GestureEvent> {
        let Some(p) = self.pending.take() else { return vec![] };
        let conf = if p.confidences.is_empty() { 0.0 } else { p.confidences.iter().copied().fold(f64::INFINITY, f64::min) };
        match p.times.len() {
            1 => {
                self.last_single = Some((p.zone.clone(), p.times[0]));
                vec![gesture("tap", Some(&p.zone), vec![p.zone.clone()], p.times[0], conf, &p.modifiers)]
            }
            2 => {
                let mut name = "double";
                if let Some((sz, st)) = &self.last_single {
                    let gap = p.times[0] - st;
                    if *sz == p.zone && gap >= self.rhythm_pause.0 && gap <= self.rhythm_pause.1 {
                        name = "rhythm";
                    }
                }
                self.last_single = None;
                vec![gesture(name, Some(&p.zone), vec![p.zone.clone()], p.times[1], conf, &p.modifiers)]
            }
            _ => {
                self.last_single = None;
                vec![]
            }
        }
    }
}

fn gesture(name: &str, zone: Option<&str>, zones: Vec<String>, t: f64, confidence: f64, modifiers: &BTreeSet<String>) -> GestureEvent {
    GestureEvent {
        t,
        gesture: name.into(),
        zone: zone.map(String::from),
        zones,
        modifiers: modifiers.clone(),
        confidence,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tap(zone: &str, t: f64) -> TapEvent {
        TapEvent { t, zone: zone.into(), confidence: 0.9, strength: 0.5, modifiers: BTreeSet::new() }
    }

    fn names(v: &[GestureEvent]) -> Vec<String> {
        v.iter().map(|g| g.gesture.clone()).collect()
    }

    fn multi(zones: &[&str]) -> GestureGrammar {
        GestureGrammar { zones_needing_multi_tap: zones.iter().map(|s| s.to_string()).collect(), ..Default::default() }
    }

    #[test]
    fn immediate_zone_emits_tap_at_once() {
        let mut g = GestureGrammar::default();
        assert_eq!(names(&g.accept(&tap("a", 1.0))), ["tap"]);
        assert!(!g.has_pending());
    }

    #[test]
    fn bounce_under_80ms_is_one_tap() {
        let mut g = GestureGrammar::default();
        assert_eq!(names(&g.accept(&tap("a", 1.0))), ["tap"]);
        assert!(g.accept(&tap("a", 1.05)).is_empty());
        let mut m = multi(&["a"]);
        m.accept(&tap("a", 1.0));
        assert!(m.accept(&tap("a", 1.03)).is_empty());
        assert_eq!(names(&m.tick(2.0, None)), ["tap"]);
    }

    #[test]
    fn double_closes_after_window() {
        let mut g = multi(&["a"]);
        assert!(g.accept(&tap("a", 1.0)).is_empty());
        assert!(g.accept(&tap("a", 1.2)).is_empty());
        assert!(g.tick(1.5, None).is_empty(), "still inside the window");
        let out = g.tick(1.6, None);
        assert_eq!(names(&out), ["double"]);
        assert_eq!(out[0].t, 1.2);
    }

    #[test]
    fn single_in_multi_zone_waits_then_taps() {
        let mut g = multi(&["a"]);
        assert!(g.accept(&tap("a", 1.0)).is_empty());
        assert_eq!(g.pending_deadline(), Some(1.35));
        assert_eq!(names(&g.tick(1.4, None)), ["tap"]);
    }

    #[test]
    fn triple_fires_immediately() {
        let mut g = multi(&["a"]);
        g.accept(&tap("a", 1.0));
        g.accept(&tap("a", 1.2));
        assert_eq!(names(&g.accept(&tap("a", 1.4))), ["triple"]);
        assert!(!g.has_pending());
    }

    #[test]
    fn in_flight_spike_holds_the_group_open() {
        let mut g = multi(&["a"]);
        g.accept(&tap("a", 1.0));
        assert!(g.tick(1.5, Some(1.3)).is_empty());
        assert_eq!(names(&g.accept(&tap("a", 1.3))), Vec::<String>::new());
        assert_eq!(names(&g.tick(1.8, None)), ["double"]);
    }

    #[test]
    fn rhythm_is_single_pause_double() {
        let mut g = multi(&["a"]);
        g.accept(&tap("a", 1.0));
        assert_eq!(names(&g.tick(1.4, None)), ["tap"]);
        g.accept(&tap("a", 1.6)); // 600 ms after the single
        g.accept(&tap("a", 1.8));
        assert_eq!(names(&g.tick(2.3, None)), ["rhythm"]);
    }

    #[test]
    fn pause_too_long_is_plain_double() {
        let mut g = multi(&["a"]);
        g.accept(&tap("a", 1.0));
        g.tick(1.4, None);
        g.accept(&tap("a", 2.0)); // 1000 ms: outside 350...900
        g.accept(&tap("a", 2.2));
        assert_eq!(names(&g.tick(2.7, None)), ["double"]);
    }

    #[test]
    fn sequence_across_zones() {
        let mut g = GestureGrammar::default();
        assert_eq!(names(&g.accept(&tap("a", 1.0))), ["tap"]);
        let out = g.accept(&tap("b", 1.3));
        assert_eq!(names(&out), ["tap", "sequence"]);
        assert_eq!(out[1].zones, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(out[1].zone, None);
    }

    #[test]
    fn sequence_consumes_pending_multi_tap() {
        let mut g = multi(&["a", "b"]);
        assert!(g.accept(&tap("a", 1.0)).is_empty());
        let out = g.accept(&tap("b", 1.2));
        assert_eq!(names(&out), ["sequence"]);
        assert!(!g.has_pending());
    }

    #[test]
    fn sequence_window_expires() {
        let mut g = GestureGrammar::default();
        g.accept(&tap("a", 1.0));
        assert_eq!(names(&g.accept(&tap("b", 1.6))), ["tap"]);
    }
}
