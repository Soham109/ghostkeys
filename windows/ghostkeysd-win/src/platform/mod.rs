//! The seam between the portable daemon and the operating system.
//!
//! Five traits cover everything the daemon needs from the OS. `windows/` implements them with the
//! `windows` crate (only compiled on Windows); `mock` implements them in memory for tests and for
//! running the daemon on a Mac during development (every sensor reported absent, actions logged).

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use crate::detection::sound::SoundOutput;
use crate::protocol::Device;

pub mod mock;
#[cfg(windows)]
pub mod windows;

/// A reading from a sensor callback. `t` is `clock::now()` at delivery, in seconds.
#[derive(Debug, Clone, PartialEq)]
pub enum SensorEvent {
    /// Acceleration in g, Windows sensor axes (x right, y up the display, z toward the user).
    Accel { t: f64, a: [f64; 3] },
    /// Angular velocity in degrees per second.
    Gyro { t: f64, g: [f64; 3] },
    /// Inclinometer pitch and roll in degrees.
    Inclination { t: f64, pitch: f64, roll: f64 },
    /// Ambient light in lux.
    Light { t: f64, lux: f64 },
    /// A knock (or a burst) heard by the microphone, from the sound detector on the capture thread.
    Sound(SoundOutput),
}

pub type SensorSink = Arc<dyn Fn(SensorEvent) + Send + Sync>;

/// Mono samples (-1...1), time of the first sample in seconds, sample rate in Hz.
pub type AudioCallback = Box<dyn FnMut(&[f32], f64, f64) + Send>;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct MotionInfo {
    pub accelerometer: bool,
    pub gyrometer: bool,
    pub inclinometer: bool,
    /// The report interval the driver accepted, in ms (0 when unknown or absent).
    pub report_interval_ms: u32,
}

/// Accelerometer, gyrometer and inclinometer (Windows.Devices.Sensors).
pub trait MotionSource: Send {
    fn info(&self) -> MotionInfo;
    fn start(&mut self, sink: SensorSink) -> Result<(), String>;
    fn stop(&mut self);
}

/// Ambient light sensor (Windows.Devices.Sensors.LightSensor). Optional hardware.
pub trait LightSource: Send {
    fn present(&self) -> bool;
    fn start(&mut self, sink: SensorSink) -> Result<(), String>;
    fn stop(&mut self);
}

/// Default microphone (WASAPI shared-mode capture). Only started when sound mode is on.
pub trait AudioSource: Send {
    fn present(&self) -> bool;
    fn start(&mut self, on_audio: AudioCallback) -> Result<(), String>;
    fn stop(&mut self);
    fn running(&self) -> bool;
}

/// What the user is doing: the typing gate, held modifiers, and the foreground app.
pub trait InputActivity: Send + Sync {
    /// Seconds since the last keyboard or mouse input (GetLastInputInfo cannot tell them apart).
    fn seconds_since_input(&self) -> f64;
    /// Held modifiers as protocol names: shift, control, option (Alt), command (Windows key).
    fn modifiers(&self) -> BTreeSet<String>;
    /// Lowercased exe name of the foreground window's process, e.g. `excel.exe`.
    fn foreground_app(&self) -> Option<String>;
}

/// OS primitives behind the action kinds. Validation, safety checks, macros and pause handling are
/// done once in `actions.rs`; an implementation only performs the primitive.
pub trait ActionRunner: Send + Sync {
    fn keystroke(&self, vk: u16, modifiers: &[u16]) -> Result<(), String>;
    fn text(&self, text: &str) -> Result<(), String>;
    fn clipboard(&self, text: &str) -> Result<(), String>;
    /// Relative change of the default output volume, in percent points.
    fn volume(&self, step_percent: f64) -> Result<(), String>;
    fn mute(&self) -> Result<(), String>;
    /// playpause, next or previous.
    fn media(&self, command: &str) -> Result<(), String>;
    /// Relative change of the built-in display brightness, in percent points.
    fn brightness(&self, step_percent: f64) -> Result<(), String>;
    fn open(&self, target: &str) -> Result<(), String>;
    /// Runs an already safety-checked command, killing it after `timeout`.
    fn shell(&self, command: &str, timeout: Duration) -> Result<(), String>;
    fn window(&self, op: &str) -> Result<(), String>;
    fn app(&self, op: &str) -> Result<(), String>;
    fn system(&self, op: &str) -> Result<(), String>;
    /// `property` of Excel's ActiveCell ("Formula" or "NumberFormat") as text.
    fn excel_get(&self, property: &str) -> Result<String, String>;
    fn excel_set(&self, property: &str, value: &str) -> Result<(), String>;
    fn excel_run_macro(&self, name: &str) -> Result<(), String>;
}

/// Everything the daemon uses from the OS, gathered once at start.
pub struct Platform {
    pub device: Device,
    pub camera_present: bool,
    /// "authorized" | "denied" | "not_determined" for the microphone and camera, when known.
    pub mic_permission: Option<String>,
    pub camera_permission: Option<String>,
    pub motion: Box<dyn MotionSource>,
    pub light: Box<dyn LightSource>,
    pub audio: Box<dyn AudioSource>,
    pub input: Arc<dyn InputActivity>,
    pub actions: Arc<dyn ActionRunner>,
}

impl Platform {
    /// The real platform on Windows, the empty mock elsewhere.
    pub fn native() -> Platform {
        #[cfg(windows)]
        {
            windows::platform()
        }
        #[cfg(not(windows))]
        {
            mock::dev_platform()
        }
    }
}
