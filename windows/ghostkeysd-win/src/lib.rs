//! ghostkeysd-win: the Windows version of the Ghostkeys daemon.
//!
//! Speaks the same WebSocket protocol as the Swift daemon (docs/PROTOCOL.md) so the same Electron
//! app drives it. Everything except `platform::windows` is plain Rust and is tested on any OS.

pub mod actions;
pub mod bindings;
pub mod clock;
pub mod config;
pub mod core;
pub mod detection;
pub mod excel;
pub mod keys;
pub mod log;
pub mod options;
pub mod platform;
pub mod protocol;
pub mod safety;
pub mod security;
pub mod server;
pub mod store;
pub mod window_math;
