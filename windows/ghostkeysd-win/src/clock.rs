//! Monotonic seconds since daemon start. The protocol sends milliseconds (`t`).

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

pub fn start() {
    START.get_or_init(Instant::now);
}

/// Seconds since daemon start.
pub fn now() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64()
}

/// Seconds to protocol milliseconds, rounded to 0.1 ms.
pub fn ms(t: f64) -> f64 {
    (t * 10_000.0).round() / 10.0
}
