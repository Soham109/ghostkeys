//! In-memory platform: used by the tests, and by `ghostkeysd-win` when it runs on a Mac or Linux
//! for development (so the Electron app can be pointed at it). Nothing here touches the OS.

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::*;
use crate::log;
use crate::protocol::Device;

/// Motion hardware that exists only on paper: reports `info`, delivers nothing unless a test
/// pushes events through the sink it captured.
#[derive(Default)]
pub struct MockMotion {
    pub info: MotionInfo,
    pub sink: Arc<Mutex<Option<SensorSink>>>,
}

impl MotionSource for MockMotion {
    fn info(&self) -> MotionInfo {
        self.info
    }
    fn start(&mut self, sink: SensorSink) -> Result<(), String> {
        *self.sink.lock().unwrap() = Some(sink);
        Ok(())
    }
    fn stop(&mut self) {
        *self.sink.lock().unwrap() = None;
    }
}

#[derive(Default)]
pub struct MockLight {
    pub present: bool,
    pub sink: Arc<Mutex<Option<SensorSink>>>,
}

impl LightSource for MockLight {
    fn present(&self) -> bool {
        self.present
    }
    fn start(&mut self, sink: SensorSink) -> Result<(), String> {
        if !self.present {
            return Err("no light sensor".into());
        }
        *self.sink.lock().unwrap() = Some(sink);
        Ok(())
    }
    fn stop(&mut self) {
        *self.sink.lock().unwrap() = None;
    }
}

#[derive(Default)]
pub struct MockAudio {
    pub present: bool,
    pub callback: Arc<Mutex<Option<AudioCallback>>>,
}

impl AudioSource for MockAudio {
    fn present(&self) -> bool {
        self.present
    }
    fn start(&mut self, on_audio: AudioCallback) -> Result<(), String> {
        if !self.present {
            return Err("no microphone".into());
        }
        *self.callback.lock().unwrap() = Some(on_audio);
        Ok(())
    }
    fn stop(&mut self) {
        *self.callback.lock().unwrap() = None;
    }
    fn running(&self) -> bool {
        self.callback.lock().unwrap().is_some()
    }
}

#[derive(Debug, Clone)]
pub struct InputState {
    pub idle_seconds: f64,
    pub modifiers: BTreeSet<String>,
    pub app: Option<String>,
}

pub struct MockInput(pub Mutex<InputState>);

impl Default for MockInput {
    fn default() -> Self {
        MockInput(Mutex::new(InputState { idle_seconds: 99.0, modifiers: BTreeSet::new(), app: None }))
    }
}

impl InputActivity for MockInput {
    fn seconds_since_input(&self) -> f64 {
        self.0.lock().unwrap().idle_seconds
    }
    fn modifiers(&self) -> BTreeSet<String> {
        self.0.lock().unwrap().modifiers.clone()
    }
    fn foreground_app(&self) -> Option<String> {
        self.0.lock().unwrap().app.clone()
    }
}

/// Records every primitive call as a line of text; holds a fake Excel active cell.
pub struct MockActions {
    pub calls: Mutex<Vec<String>>,
    pub excel_cell: Mutex<Option<(String, String)>>, // (Formula, NumberFormat); None = Excel not running
    pub echo: bool,
}

impl Default for MockActions {
    fn default() -> Self {
        MockActions { calls: Mutex::new(vec![]), excel_cell: Mutex::new(None), echo: false }
    }
}

impl MockActions {
    fn record(&self, s: String) -> Result<(), String> {
        if self.echo {
            log::info(&format!("mock action: {s}"));
        }
        self.calls.lock().unwrap().push(s);
        Ok(())
    }
    pub fn take_calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}

impl ActionRunner for MockActions {
    fn keystroke(&self, vk: u16, modifiers: &[u16]) -> Result<(), String> {
        self.record(format!("keystroke {vk:#04x} {modifiers:?}"))
    }
    fn text(&self, text: &str) -> Result<(), String> {
        self.record(format!("text {text}"))
    }
    fn clipboard(&self, text: &str) -> Result<(), String> {
        self.record(format!("clipboard {text}"))
    }
    fn volume(&self, step: f64) -> Result<(), String> {
        self.record(format!("volume {step}"))
    }
    fn mute(&self) -> Result<(), String> {
        self.record("mute".into())
    }
    fn media(&self, command: &str) -> Result<(), String> {
        self.record(format!("media {command}"))
    }
    fn brightness(&self, step: f64) -> Result<(), String> {
        self.record(format!("brightness {step}"))
    }
    fn open(&self, target: &str) -> Result<(), String> {
        self.record(format!("open {target}"))
    }
    fn shell(&self, command: &str, timeout: Duration) -> Result<(), String> {
        self.record(format!("shell {command} ({}s)", timeout.as_secs()))
    }
    fn window(&self, op: &str) -> Result<(), String> {
        self.record(format!("window {op}"))
    }
    fn app(&self, op: &str) -> Result<(), String> {
        self.record(format!("app {op}"))
    }
    fn system(&self, op: &str) -> Result<(), String> {
        self.record(format!("system {op}"))
    }
    fn excel_get(&self, property: &str) -> Result<String, String> {
        let cell = self.excel_cell.lock().unwrap();
        let (formula, format) = cell.as_ref().ok_or("Excel is not running")?;
        match property {
            "Formula" => Ok(formula.clone()),
            "NumberFormat" => Ok(format.clone()),
            p => Err(format!("unknown property {p}")),
        }
    }
    fn excel_set(&self, property: &str, value: &str) -> Result<(), String> {
        {
            let mut cell = self.excel_cell.lock().unwrap();
            let c = cell.as_mut().ok_or("Excel is not running")?;
            match property {
                "Formula" => c.0 = value.to_string(),
                "NumberFormat" => c.1 = value.to_string(),
                p => return Err(format!("unknown property {p}")),
            }
        }
        self.record(format!("excel {property}={value}"))
    }
    fn excel_run_macro(&self, name: &str) -> Result<(), String> {
        if self.excel_cell.lock().unwrap().is_none() {
            return Err("Excel is not running".into());
        }
        self.record(format!("excel run {name}"))
    }
}

/// Handles to a test platform's mocks, kept alongside the `Platform` that owns the boxed sources.
pub struct MockHandles {
    pub motion_sink: Arc<Mutex<Option<SensorSink>>>,
    pub light_sink: Arc<Mutex<Option<SensorSink>>>,
    pub audio: Arc<Mutex<Option<AudioCallback>>>,
    pub input: Arc<MockInput>,
    pub actions: Arc<MockActions>,
}

/// A platform with the given hardware, for tests.
pub fn test_platform(motion: MotionInfo, light: bool, mic: bool) -> (Platform, MockHandles) {
    let m = MockMotion { info: motion, ..Default::default() };
    let l = MockLight { present: light, ..Default::default() };
    let a = MockAudio { present: mic, ..Default::default() };
    let input = Arc::new(MockInput::default());
    let actions = Arc::new(MockActions::default());
    let handles = MockHandles {
        motion_sink: m.sink.clone(),
        light_sink: l.sink.clone(),
        audio: a.callback.clone(),
        input: input.clone(),
        actions: actions.clone(),
    };
    let p = Platform {
        device: Device { model: "Mock".into(), chip: "mock".into(), family: "other".into() },
        camera_present: false,
        mic_permission: mic.then(|| "authorized".to_string()),
        camera_permission: None,
        motion: Box::new(m),
        light: Box::new(l),
        audio: Box::new(a),
        input,
        actions,
    };
    (p, handles)
}

/// Development platform off Windows: no sensors (reported honestly), actions only logged.
pub fn dev_platform() -> Platform {
    let (mut p, _) = test_platform(MotionInfo::default(), false, false);
    p.device = Device { model: "not-windows".into(), chip: std::env::consts::ARCH.into(), family: "other".into() };
    p.actions = Arc::new(MockActions { echo: true, ..Default::default() });
    p
}
