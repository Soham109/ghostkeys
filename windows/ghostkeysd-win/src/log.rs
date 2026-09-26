//! Minimal stderr logging. The Electron app prefixes and forwards the daemon's stderr.

use std::sync::atomic::{AtomicBool, Ordering};

static VERBOSE: AtomicBool = AtomicBool::new(false);

pub fn set_verbose(v: bool) {
    VERBOSE.store(v, Ordering::Relaxed);
}

pub fn info(msg: &str) {
    eprintln!("{msg}");
}

pub fn error(msg: &str) {
    eprintln!("error: {msg}");
}

pub fn debug(msg: &str) {
    if VERBOSE.load(Ordering::Relaxed) {
        eprintln!("debug: {msg}");
    }
}
