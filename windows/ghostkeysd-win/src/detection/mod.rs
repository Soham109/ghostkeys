//! Platform-independent detection, ported from daemon/Sources/GhostkeysDetection.
//!
//! What is ported as is: the gesture grammar, the light cover detector and the tilt detector.
//! What is new for Windows: `knock` (accelerometer knocks without zones, for the slow sensor
//! rates Windows drivers give) and `sound` (knock impulses from the microphone).

pub mod grammar;
pub mod knock;
pub mod light;
pub mod sound;
pub mod tilt;

use std::collections::BTreeSet;

/// One accepted tap (knock). `t` in seconds.
#[derive(Debug, Clone, PartialEq)]
pub struct TapEvent {
    pub t: f64,
    pub zone: String,
    pub confidence: f64,
    pub strength: f64,
    pub modifiers: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GestureEvent {
    pub t: f64,
    /// tap, double, triple, sequence, rhythm, cover, cover_hold, tilt_left, tilt_right
    pub gesture: String,
    pub zone: Option<String>,
    pub zones: Vec<String>,
    pub modifiers: BTreeSet<String>,
    pub confidence: f64,
}

impl GestureEvent {
    pub fn zoneless(name: &str, t: f64) -> Self {
        GestureEvent { t, gesture: name.into(), zone: None, zones: vec![], modifiers: BTreeSet::new(), confidence: 1.0 }
    }
}

/// Median of a slice (0 when empty).
pub fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut s = values.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = s.len() / 2;
    if s.len() % 2 == 1 {
        s[m]
    } else {
        0.5 * (s[m - 1] + s[m])
    }
}

/// Median of a noise history kept as per-block medians in a ring buffer: ignores the spikes
/// themselves, follows sustained vibration. Shared by the knock and sound detectors.
#[derive(Debug, Clone)]
pub struct BlockMedianFloor {
    block_size: usize,
    max_blocks: usize,
    block: Vec<f64>,
    medians: Vec<f64>,
    cursor: usize,
    pub value: f64,
}

impl BlockMedianFloor {
    pub fn new(block_size: usize, max_blocks: usize) -> Self {
        BlockMedianFloor {
            block_size: block_size.max(1),
            max_blocks: max_blocks.max(1),
            block: Vec::with_capacity(block_size.max(1)),
            medians: Vec::new(),
            cursor: 0,
            value: 0.0,
        }
    }

    pub fn push(&mut self, x: f64) {
        self.block.push(x);
        if self.block.len() < self.block_size {
            return;
        }
        let med = median(&self.block);
        self.block.clear();
        if self.medians.len() < self.max_blocks {
            self.medians.push(med);
        } else {
            self.medians[self.cursor] = med;
            self.cursor = (self.cursor + 1) % self.max_blocks;
        }
        self.value = median(&self.medians);
    }

    pub fn blocks(&self) -> usize {
        self.medians.len()
    }

    pub fn reset(&mut self) {
        self.block.clear();
        self.medians.clear();
        self.cursor = 0;
        self.value = 0.0;
    }
}
