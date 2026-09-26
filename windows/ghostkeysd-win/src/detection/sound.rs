//! Sound mode: knocks on the laptop body heard through the microphone.
//!
//! The Mac's sound mode (GhostkeysAcoustics) is still a stub, so this is the first implementation.
//! It is written to be shared back: plain math on mono float samples, no platform calls.
//!
//! A knock through a laptop mic is a sharp, short broadband click: it rises within a millisecond or
//! two and has mostly died away 30 ms later. Speech, music, and fan noise either rise slowly or
//! keep going. The detector works on a 1 ms envelope:
//!   1. One-pole high-pass at 150 Hz (removes rumble, desk thumps through the chassis, mains hum).
//!   2. Envelope: peak |x| per 1 ms hop.
//!   3. Noise floor: median of 50 ms block medians over 2 s (ignores the clicks themselves).
//!   4. Trigger when the envelope exceeds max(absolute floor, k * noise); k and the floor come from
//!      sensitivity (strict: 10x and -40 dBFS, sensitive: 4x and -60 dBFS).
//!   5. Watch 60 ms after the trigger, then judge. Attack: the loudest hop of the 5 ms before
//!      onset is under 35% of the peak (sudden). Decay: the mean envelope 30...60 ms after onset
//!      is under 20% of the peak (short). Anything else (a word, a note, a door slam that rings)
//!      is dropped without a message.
//!   6. Refractory 80 ms from onset; 4 knocks within 0.5 s lock detection for 0.4 s ("burst").
//!
//! Each accepted impulse also carries `hf_ratio`, the share of energy above about 2 kHz in its
//! first 10 ms. Knuckles (hard, bright) should read higher than fingertips (soft, dull); telling
//! them apart needs recorded examples, so for now it is measured and reported, not used.
//!
//! Keyboard clicks are impulsive too. The daemon rejects impulses that land inside the typing gate
//! (GetLastInputInfo), the same way the Mac rejects motion spikes while you type.

use std::collections::VecDeque;

use super::BlockMedianFloor;
use crate::config::clamp;

#[derive(Debug, Clone, PartialEq)]
pub struct Impulse {
    /// Onset time in seconds (same clock as the chunk times passed to `process`).
    pub t: f64,
    /// Peak envelope (full scale = 1.0).
    pub peak: f64,
    /// Peak over the trigger threshold, mapped to 0...1.
    pub strength: f64,
    /// Late envelope over peak (smaller = more knock-like).
    pub decay_ratio: f64,
    /// Share of early energy above about 2 kHz (knuckle vs fingertip, future use).
    pub hf_ratio: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SoundOutput {
    Knock(Impulse),
    Burst { t: f64 },
}

#[derive(Debug, Clone)]
struct Candidate {
    onset: f64,
    pre: f64,
    threshold: f64,
    env: Vec<f64>,
    hf_energy: f64,
    all_energy: f64,
    burst: bool,
}

#[derive(Debug, Clone)]
pub struct SoundDetector {
    pub sensitivity: f64,
    pub sample_rate: f64,
    pub watch: usize,
    pub attack_max: f64,
    pub decay_max: f64,
    pub refractory: f64,
    pub burst_count: usize,
    pub burst_window: f64,
    pub burst_lockout: f64,
    hop: usize,
    hp_alpha: f64,
    hf_alpha: f64,
    // Filter state.
    hp_prev_in: f64,
    hp_prev_out: f64,
    hf_prev_in: f64,
    hf_prev_out: f64,
    // Current hop.
    hop_fill: usize,
    hop_peak: f64,
    hop_energy: f64,
    hop_hf_energy: f64,
    hop_start_t: f64,
    // History.
    recent_env: VecDeque<f64>,
    floor: BlockMedianFloor,
    candidate: Option<Candidate>,
    last_onset: f64,
    recent_knocks: Vec<f64>,
    lockout_until: f64,
}

impl SoundDetector {
    pub fn new(sample_rate: f64) -> Self {
        let rate = sample_rate.max(8000.0);
        let one_pole = |hz: f64| {
            let rc = 1.0 / (2.0 * std::f64::consts::PI * hz);
            rc / (rc + 1.0 / rate)
        };
        SoundDetector {
            sensitivity: 0.5,
            sample_rate: rate,
            watch: 60,
            attack_max: 0.35,
            decay_max: 0.20,
            refractory: 0.080,
            burst_count: 4,
            burst_window: 0.5,
            burst_lockout: 0.4,
            hop: (rate / 1000.0).round().max(1.0) as usize,
            hp_alpha: one_pole(150.0),
            hf_alpha: one_pole(2000.0),
            hp_prev_in: 0.0,
            hp_prev_out: 0.0,
            hf_prev_in: 0.0,
            hf_prev_out: 0.0,
            hop_fill: 0,
            hop_peak: 0.0,
            hop_energy: 0.0,
            hop_hf_energy: 0.0,
            hop_start_t: 0.0,
            recent_env: VecDeque::with_capacity(8),
            floor: BlockMedianFloor::new(50, 40),
            candidate: None,
            last_onset: f64::NEG_INFINITY,
            recent_knocks: Vec::new(),
            lockout_until: f64::NEG_INFINITY,
        }
    }

    pub fn noise_multiplier(&self) -> f64 {
        10.0 - 6.0 * clamp(self.sensitivity, 0.0, 1.0)
    }

    /// -40 dBFS (strict) ... -60 dBFS (sensitive).
    pub fn absolute_floor(&self) -> f64 {
        10f64.powf(-(40.0 + 20.0 * clamp(self.sensitivity, 0.0, 1.0)) / 20.0)
    }

    pub fn threshold(&self) -> f64 {
        self.absolute_floor().max(self.noise_multiplier() * self.floor.value)
    }

    /// Onset of an impulse still being judged (the grammar holds a group open for it).
    pub fn in_flight(&self) -> Option<f64> {
        self.candidate.as_ref().map(|c| c.onset)
    }

    /// Feed mono samples; `t_first` is the time of `samples[0]` in seconds.
    pub fn process(&mut self, samples: &[f32], t_first: f64) -> Vec<SoundOutput> {
        let mut out = Vec::new();
        let dt = 1.0 / self.sample_rate;
        for (i, &s) in samples.iter().enumerate() {
            let x = if s.is_finite() { s as f64 } else { 0.0 };
            // High-pass (RC) at 150 Hz, and a second one at 2 kHz on top for the bright share.
            let hp = self.hp_alpha * (self.hp_prev_out + x - self.hp_prev_in);
            self.hp_prev_in = x;
            self.hp_prev_out = hp;
            let hf = self.hf_alpha * (self.hf_prev_out + hp - self.hf_prev_in);
            self.hf_prev_in = hp;
            self.hf_prev_out = hf;

            if self.hop_fill == 0 {
                self.hop_start_t = t_first + i as f64 * dt;
            }
            self.hop_peak = self.hop_peak.max(hp.abs());
            self.hop_energy += hp * hp;
            self.hop_hf_energy += hf * hf;
            self.hop_fill += 1;
            if self.hop_fill >= self.hop {
                if let Some(o) = self.on_hop(self.hop_start_t, self.hop_peak, self.hop_energy, self.hop_hf_energy) {
                    out.push(o);
                }
                self.hop_fill = 0;
                self.hop_peak = 0.0;
                self.hop_energy = 0.0;
                self.hop_hf_energy = 0.0;
            }
        }
        out
    }

    fn on_hop(&mut self, t: f64, env: f64, energy: f64, hf_energy: f64) -> Option<SoundOutput> {
        if let Some(c) = self.candidate.as_mut() {
            c.env.push(env);
            if c.env.len() <= 10 {
                c.all_energy += energy;
                c.hf_energy += hf_energy;
            }
            if c.env.len() < self.watch {
                return None;
            }
            let c = self.candidate.take().unwrap();
            return self.judge(c);
        }

        // Only quiet hops feed the floor and the pre-onset history.
        let pre = self.recent_env.iter().copied().fold(0.0, f64::max);
        let warmed = self.floor.blocks() >= 5;
        let thr = self.threshold();
        if warmed && env > thr && t - self.last_onset >= self.refractory {
            self.last_onset = t;
            let burst = t < self.lockout_until;
            self.candidate = Some(Candidate {
                onset: t,
                pre,
                threshold: thr,
                env: vec![env],
                hf_energy,
                all_energy: energy,
                burst,
            });
            return None;
        }
        self.floor.push(env);
        if self.recent_env.len() >= 5 {
            self.recent_env.pop_front();
        }
        self.recent_env.push_back(env);
        None
    }

    fn judge(&mut self, c: Candidate) -> Option<SoundOutput> {
        let peak = c.env[..10.min(c.env.len())].iter().copied().fold(0.0, f64::max);
        if peak <= 0.0 {
            return None;
        }
        let late = &c.env[30.min(c.env.len())..];
        let late_mean = if late.is_empty() { 0.0 } else { late.iter().sum::<f64>() / late.len() as f64 };
        let decay_ratio = late_mean / peak;
        let attack_ok = c.pre < self.attack_max * peak;
        let decay_ok = decay_ratio < self.decay_max;
        // Whatever this was, it is part of the background now.
        self.recent_env.clear();
        if !(attack_ok && decay_ok) {
            return None;
        }
        let t = c.onset;
        self.recent_knocks.push(t);
        let window = self.burst_window;
        self.recent_knocks.retain(|&r| t - r <= window);
        let mut burst = c.burst || t < self.lockout_until;
        if self.recent_knocks.len() >= self.burst_count {
            self.lockout_until = t + self.burst_lockout;
            burst = true;
        }
        if burst {
            return Some(SoundOutput::Burst { t });
        }
        let hf_ratio = if c.all_energy > 0.0 { clamp(c.hf_energy / c.all_energy, 0.0, 1.0) } else { 0.0 };
        Some(SoundOutput::Knock(Impulse {
            t,
            peak,
            strength: clamp(peak / c.threshold / 8.0, 0.0, 1.0),
            decay_ratio,
            hf_ratio,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f64 = 48_000.0;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^= z >> 31;
            (z >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
        }
    }

    /// Room noise at -66 dBFS plus the given events.
    fn signal(seconds: f64, knocks: &[f64], tones: &[(f64, f64)]) -> Vec<f32> {
        let mut rng = Rng(7);
        let n = (seconds * RATE) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / RATE;
                let mut x = 0.0005 * rng.next();
                for &k in knocks {
                    if t >= k {
                        // Decaying broadband click, 3 ms time constant.
                        x += 0.3 * (-(t - k) / 0.003).exp() * rng.next();
                    }
                }
                for &(from, to) in tones {
                    if t >= from && t <= to {
                        x += 0.2 * (2.0 * std::f64::consts::PI * 220.0 * t).sin();
                    }
                }
                x as f32
            })
            .collect()
    }

    /// Feeds in 10 ms chunks, like a WASAPI shared-mode stream.
    fn detect(sig: &[f32]) -> Vec<SoundOutput> {
        let mut d = SoundDetector::new(RATE);
        let mut out = vec![];
        for (i, chunk) in sig.chunks(480).enumerate() {
            out.extend(d.process(chunk, i as f64 * 0.01));
        }
        out
    }

    fn knocks(v: &[SoundOutput]) -> Vec<&Impulse> {
        v.iter()
            .filter_map(|o| match o {
                SoundOutput::Knock(i) => Some(i),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn quiet_room_is_silent() {
        assert!(detect(&signal(3.0, &[], &[])).is_empty());
    }

    #[test]
    fn knocks_are_found_with_accurate_onsets() {
        let out = detect(&signal(3.0, &[1.0, 1.25, 2.0], &[]));
        let k = knocks(&out);
        assert_eq!(k.len(), 3, "{out:?}");
        for (imp, want) in k.iter().zip([1.0, 1.25, 2.0]) {
            assert!((imp.t - want).abs() < 0.003, "{} vs {}", imp.t, want);
            assert!(imp.decay_ratio < 0.2);
            assert!(imp.hf_ratio > 0.0 && imp.hf_ratio <= 1.0);
        }
    }

    #[test]
    fn a_sustained_tone_is_not_a_knock() {
        let out = detect(&signal(3.0, &[], &[(1.0, 1.5)]));
        assert!(knocks(&out).is_empty(), "{out:?}");
    }

    #[test]
    fn a_knock_during_a_tone_still_counts_only_if_it_stands_out() {
        // The tone's sudden start is not a knock; nothing else happens.
        let out = detect(&signal(3.0, &[], &[(1.0, 2.5)]));
        assert!(knocks(&out).is_empty());
    }

    #[test]
    fn rapid_clicking_is_a_burst() {
        let out = detect(&signal(3.0, &[1.0, 1.1, 1.2, 1.3, 1.4], &[]));
        assert!(out.iter().any(|o| matches!(o, SoundOutput::Burst { .. })), "{out:?}");
    }

    #[test]
    fn works_at_44100_and_with_odd_chunks() {
        let rate = 44_100.0;
        let mut rng = Rng(3);
        let n = (2.0 * rate) as usize;
        let sig: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / rate;
                let mut x = 0.0005 * rng.next();
                if t >= 1.0 {
                    x += 0.3 * (-(t - 1.0) / 0.003).exp() * rng.next();
                }
                x as f32
            })
            .collect();
        let mut d = SoundDetector::new(rate);
        let mut out = vec![];
        let mut pos = 0;
        for size in [333usize, 1024, 17, 4410].iter().cycle() {
            if pos >= sig.len() {
                break;
            }
            let end = (pos + size).min(sig.len());
            out.extend(d.process(&sig[pos..end], pos as f64 / rate));
            pos = end;
        }
        let k = knocks(&out);
        assert_eq!(k.len(), 1, "{out:?}");
        assert!((k[0].t - 1.0).abs() < 0.003);
    }
}
