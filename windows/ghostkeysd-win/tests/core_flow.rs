//! The whole daemon logic on mock hardware: sensor readings in, protocol messages and OS
//! primitives out.

use std::fs;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use ghostkeysd_win::actions::{ActionExecutor, RunContext};
use ghostkeysd_win::core::{ActionDone, Core, CoreDeps, Hardware, Outgoing, Target};
use ghostkeysd_win::detection::sound::{Impulse, SoundOutput};
use ghostkeysd_win::platform::mock::{test_platform, MockHandles};
use ghostkeysd_win::platform::{MotionInfo, SensorEvent};
use ghostkeysd_win::protocol::OutMsg;
use ghostkeysd_win::security::ApprovalStore;
use ghostkeysd_win::store::ConfigStore;
use serde_json::{json, Value};

struct Rig {
    core: Core,
    mocks: MockHandles,
    done: mpsc::Receiver<ActionDone>,
    dir: std::path::PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}

fn rig(name: &str, accel: bool, light: bool, mic: bool) -> Rig {
    let dir = std::env::temp_dir().join(format!("ghostkeys-core-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let motion = MotionInfo { accelerometer: accel, gyrometer: false, inclinometer: accel, report_interval_ms: if accel { 16 } else { 0 } };
    let (platform, mocks) = test_platform(motion, light, mic);
    let paused = Arc::new(AtomicBool::new(false));
    let approvals = Arc::new(ApprovalStore::load(&dir));
    let executor = ActionExecutor::new(platform.actions.clone(), RunContext { paused: paused.clone(), dry_run: false, approvals: approvals.clone() });
    let (tx, done) = mpsc::channel();
    let tx = std::sync::Mutex::new(tx);
    let core = Core::new(CoreDeps {
        hardware: Hardware {
            device: Some(platform.device.clone()),
            motion,
            light,
            mic,
            camera: false,
            mic_permission: Some("authorized".into()),
            camera_permission: None,
        },
        store: ConfigStore::new(&dir),
        input: platform.input.clone(),
        executor,
        paused,
        approvals,
        notify: Arc::new(move |d| {
            let _ = tx.lock().unwrap().send(d);
        }),
    });
    Rig { core, mocks, done, dir }
}

impl Rig {
    /// Waits for one action to finish and feeds the result back like the server does.
    fn finish_action(&mut self) -> Vec<Outgoing> {
        let d = self.done.recv_timeout(Duration::from_secs(3)).expect("an action finished");
        self.core.action_done(d)
    }

    fn send(&mut self, client: u64, v: Value) -> Vec<Outgoing> {
        self.core.message(client, &v.to_string())
    }

    /// 60 Hz resting accelerometer from `from` to `to`, with one-sample knocks at `knocks`.
    fn accel(&mut self, from: f64, to: f64, knocks: &[f64]) -> Vec<Outgoing> {
        let dt = 1.0 / 60.0;
        let mut out = vec![];
        let mut i = 0usize;
        loop {
            let t = from + i as f64 * dt;
            if t >= to {
                break;
            }
            let wobble = [0.002, -0.002, 0.0][i % 3];
            let mut a = [wobble, 0.0, -1.0 + wobble];
            if knocks.iter().any(|k| (t - k).abs() < dt / 2.0) {
                a[2] += 0.08;
            }
            out.extend(self.core.sensor(SensorEvent::Accel { t, a }));
            i += 1;
        }
        out
    }
}

fn gestures(out: &[Outgoing]) -> Vec<String> {
    out.iter()
        .filter_map(|o| match &o.msg {
            OutMsg::Gesture { gesture, .. } => Some(gesture.clone()),
            _ => None,
        })
        .collect()
}

fn rejections(out: &[Outgoing]) -> Vec<String> {
    out.iter()
        .filter_map(|o| match &o.msg {
            OutMsg::Rejected { reason, .. } => Some(reason.clone()),
            _ => None,
        })
        .collect()
}

fn errors(out: &[Outgoing]) -> Vec<String> {
    out.iter()
        .filter_map(|o| match &o.msg {
            OutMsg::Error { message } => Some(message.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn hello_reports_hardware_honestly() {
    let mut r = rig("hello-none", false, false, false);
    let out = r.core.connect(1);
    assert_eq!(out.len(), 5, "hello, status, config, sound and air session state");
    assert!(matches!(&out[3].msg, OutMsg::Session { kind, active: false, .. } if kind == "sound"));
    let OutMsg::Hello { sensors, permissions, .. } = &out[0].msg else { panic!() };
    assert!(!sensors.imu && !sensors.gyro && !sensors.lid && !sensors.light);
    assert_eq!((sensors.inclinometer, sensors.sound, sensors.camera), (Some(false), Some(false), Some(false)));
    assert!(permissions.accessibility);
    let OutMsg::Status { calibrated, zones, paused_reason, .. } = &out[1].msg else { panic!() };
    assert!(!calibrated, "a clamshell with no accelerometer and sound mode off cannot knock");
    assert!(zones.is_empty());
    assert_eq!(paused_reason, &Some(None), "pausedReason is an explicit null while running");

    let mut r = rig("hello-2in1", true, true, true);
    let OutMsg::Hello { sensors, .. } = &r.core.connect(1)[0].msg else { panic!() };
    assert!(sensors.imu && sensors.light && !sensors.lid);
    assert_eq!(sensors.sound, Some(true));
}

#[test]
fn accelerometer_double_knock_runs_the_default_binding() {
    let mut r = rig("double", true, false, false);
    r.core.connect(1);
    r.send(1, json!({"type":"subscribe","streams":["taps"]}));
    let mut out = r.accel(0.0, 2.0, &[1.0, 1.2]);
    let taps = out.iter().filter(|o| matches!(o.msg, OutMsg::Tap { .. })).count();
    assert_eq!(taps, 2, "{out:?}");
    assert!(out.iter().any(|o| matches!(&o.msg, OutMsg::Tap { source: Some(s), zone, .. } if s == "imu" && zone == "anywhere")));
    out.extend(r.core.tick(2.0));
    assert_eq!(gestures(&out), ["double"]);
    let done = r.finish_action();
    assert!(matches!(&done[0].msg, OutMsg::Action { ok: true, binding_id: Some(b), .. } if b == "b1"));
    assert_eq!(done[0].target, Target::All);
    assert_eq!(r.mocks.actions.take_calls(), ["volume 6"]);
}

#[test]
fn typing_gate_and_pause_reject_knocks() {
    let mut r = rig("gates", true, false, false);
    r.core.connect(1);
    r.accel(0.0, 1.0, &[]);
    r.mocks.input.0.lock().unwrap().idle_seconds = 0.1;
    let out = r.accel(1.0, 1.5, &[1.2]);
    assert_eq!(rejections(&out), ["typing"]);

    r.mocks.input.0.lock().unwrap().idle_seconds = 99.0;
    let out = r.send(1, json!({"type":"pause"}));
    assert!(matches!(&out[0].msg, OutMsg::Status { paused: true, paused_reason: Some(Some(w)), .. } if w == "user"));
    let out = r.accel(1.5, 2.0, &[1.8]);
    assert_eq!(rejections(&out), ["paused"]);
    assert!(r.mocks.actions.take_calls().is_empty());
}

#[test]
fn sound_session_opens_the_mic_and_mic_knocks_count() {
    let mut r = rig("sound", false, false, true);
    r.core.connect(1);
    assert_eq!(r.core.sound_wanted(), None, "the mic is closed by default");
    let out = r.send(1, json!({"type":"sound_session_start","seconds":5}));
    assert!(out.iter().any(|o| matches!(&o.msg, OutMsg::Session { kind, active: true, .. } if kind == "sound")));
    assert!(r.core.sound_wanted().is_some());

    let knock = |t: f64| SensorEvent::Sound(SoundOutput::Knock(Impulse { t, peak: 0.3, strength: 0.7, decay_ratio: 0.05, hf_ratio: 0.4 }));
    let mut out = r.core.sensor(knock(1.0));
    out.extend(r.core.sensor(knock(1.2)));
    out.extend(r.core.tick(1.3));
    assert!(gestures(&out).is_empty(), "the group waits for the double window plus the sound latency");
    out.extend(r.core.tick(1.7));
    assert_eq!(gestures(&out), ["double"]);
    r.finish_action();
    assert_eq!(r.mocks.actions.take_calls(), ["volume 6"]);

    // The session ends by itself.
    let out = r.core.tick(clock_now_plus(10.0));
    assert!(out.iter().any(|o| matches!(&o.msg, OutMsg::Session { active: false, reason: Some(r), .. } if r == "timeout")));
    assert_eq!(r.core.sound_wanted(), None);
    assert!(gestures(&r.core.sensor(knock(20.0))).is_empty(), "late mic events after the session are ignored");
}

fn clock_now_plus(s: f64) -> f64 {
    ghostkeysd_win::clock::now() + s
}

#[test]
fn pause_ends_the_sound_session_and_blocks_new_ones() {
    let mut r = rig("soundpause", false, false, true);
    r.core.connect(1);
    r.send(1, json!({"type":"sound_session_start"}));
    assert!(r.core.sound_wanted().is_some());
    let out = r.send(1, json!({"type":"pause"}));
    assert!(out.iter().any(|o| matches!(&o.msg, OutMsg::Session { active: false, reason: Some(x), .. } if x == "paused")));
    assert_eq!(r.core.sound_wanted(), None);
    let out = r.send(1, json!({"type":"sound_session_start"}));
    assert!(matches!(&out[0].msg, OutMsg::Session { error: Some(e), .. } if e == "paused"));
}

#[test]
fn sound_session_without_a_mic_is_an_error() {
    let mut r = rig("nomic", false, false, false);
    r.core.connect(1);
    let out = r.send(1, json!({"type":"sound_session_start"}));
    assert!(matches!(&out[0].msg, OutMsg::Session { active: false, reason: Some(r), error: Some(e), .. } if r == "error" && e == "no microphone"));
    assert_eq!(out[0].target, Target::Client(1), "a failed start answers only the requester");
}

#[test]
fn covering_the_light_sensor_fires_a_cover_binding() {
    let mut r = rig("cover", false, true, false);
    r.core.connect(1);
    let mut cfg = serde_json::to_value(r.core.config()).unwrap();
    cfg["bindings"] = json!([{ "id": "c1", "gesture": "cover", "action": { "kind": "media", "command": "playpause" } }]);
    let out = r.send(1, json!({"type":"config_set","config":cfg}));
    assert!(out.iter().any(|o| matches!(o.msg, OutMsg::Config { .. })));

    let mut out = vec![];
    let mut t = 0.0;
    while t < 4.0 {
        let lux = if (3.0..3.4).contains(&t) { 2.0 } else { 400.0 };
        out.extend(r.core.sensor(SensorEvent::Light { t, lux }));
        t += 0.05;
    }
    assert_eq!(gestures(&out), ["cover"]);
    r.finish_action();
    assert_eq!(r.mocks.actions.take_calls(), ["media playpause"]);
}

#[test]
fn calibration_is_refused_politely() {
    let mut r = rig("calib", true, false, false);
    r.core.connect(1);
    let out = r.send(1, json!({"type":"calibration_start","zones":["left-palm"],"target":20}));
    assert!(errors(&out)[0].contains("not available on Windows"));
    let out = r.send(1, json!({"type":"calibration_cancel"}));
    assert!(matches!(&out[0].msg, OutMsg::Calibration { phase, .. } if phase == "cancelled"));
}

#[test]
fn shell_needs_approval_and_results_go_only_to_the_requester() {
    let mut r = rig("approve", false, false, false);
    r.core.connect(1);
    r.core.connect(2);
    let action = json!({"kind":"shell","command":"echo hi"});

    assert!(r.send(1, json!({"type":"test_action","action":action})).is_empty());
    let out = r.finish_action();
    assert_eq!(out[0].target, Target::Client(1));
    assert!(matches!(&out[0].msg, OutMsg::Action { ok: false, error: Some(e), .. } if e.contains("not approved")));

    let out = r.send(1, json!({"type":"approve_action","action":action}));
    let OutMsg::Approved { hash, kind } = &out[0].msg else { panic!("{out:?}") };
    assert_eq!(out[0].target, Target::Client(1));
    assert_eq!(kind.as_deref(), Some("shell"));
    let mut stamped = action.clone();
    stamped["approvedHash"] = json!(hash);

    std::thread::sleep(Duration::from_millis(1100)); // test_action is limited to 2 per second
    r.send(1, json!({"type":"test_action","action":stamped}));
    let out = r.finish_action();
    assert!(matches!(&out[0].msg, OutMsg::Action { ok: true, .. }), "{out:?}");
    assert_eq!(r.mocks.actions.take_calls(), ["shell echo hi (10s)"]);

    // Even approved, a refused command never runs.
    let bad = json!({"kind":"shell","command":"reg delete HKCU\\Software\\X /f"});
    let out = r.send(2, json!({"type":"approve_action","action":bad}));
    let OutMsg::Approved { hash, .. } = &out[0].msg else { panic!() };
    let mut bad_stamped = bad.clone();
    bad_stamped["approvedHash"] = json!(hash);
    r.send(2, json!({"type":"test_action","action":bad_stamped}));
    let out = r.finish_action();
    assert!(matches!(&out[0].msg, OutMsg::Action { ok: false, error: Some(e), .. } if e.contains("registry")));
    assert!(r.mocks.actions.take_calls().is_empty());

    let out = r.send(1, json!({"type":"revoke_action","action":action}));
    assert!(matches!(&out[0].msg, OutMsg::Revoked { found: true, .. }));
    let out = r.send(1, json!({"type":"revoke_action"}));
    assert_eq!(errors(&out), ["revoke_action needs a hash or an action"]);
}

#[test]
fn test_actions_are_rate_limited() {
    let mut r = rig("ratelimit", false, false, false);
    for c in 1..=4 {
        r.core.connect(c);
    }
    let mute = json!({"type":"test_action","action":{"kind":"mute"}});
    assert!(r.send(1, mute.clone()).is_empty());
    assert!(r.send(1, mute.clone()).is_empty());
    let out = r.send(1, mute.clone());
    assert!(matches!(&out[0].msg, OutMsg::Action { ok: false, error: Some(e), .. } if e.contains("2 test actions per second")));
    assert_eq!(out[0].target, Target::Client(1));
    // Across clients the global 5 per second limit trips and pauses the daemon.
    r.send(2, mute.clone());
    r.send(2, mute.clone());
    r.send(3, mute.clone());
    let out = r.send(3, mute.clone());
    assert!(out.iter().any(|o| matches!(&o.msg, OutMsg::Status { paused: true, paused_reason: Some(Some(w)), .. } if w == "rate_limit")), "{out:?}");
    assert!(r.core.is_paused());
    let out = r.send(4, json!({"type":"resume"}));
    assert!(matches!(&out[0].msg, OutMsg::Status { paused: false, .. }));
}

#[test]
fn config_set_validates_and_saves() {
    let mut r = rig("configset", false, false, false);
    r.core.connect(1);
    let out = r.send(1, json!({"type":"config_set","config":{"bindings":[{"id":"x"}]}}));
    assert!(errors(&out)[0].starts_with("invalid config"), "a binding needs a gesture");
    let out = r.send(1, json!({"type":"config_set","config":"nope"}));
    assert_eq!(errors(&out), ["config_set needs a config object"]);
    let out = r.send(1, json!({"type":"config_set","config":{"settings":{"sensitivity":0.9}}}));
    assert!(out.iter().any(|o| o.target == Target::All && matches!(o.msg, OutMsg::Config { .. })));
    let saved: Value = serde_json::from_str(&fs::read_to_string(r.dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(saved["settings"]["sensitivity"], 0.9);
}

#[test]
fn streams_go_only_to_subscribers() {
    let mut r = rig("streams", true, false, false);
    r.core.connect(1);
    r.core.connect(2);
    r.send(2, json!({"type":"subscribe","streams":["imu","bogus"]}));
    let out = r.accel(0.0, 0.2, &[]);
    let imu: Vec<_> = out.iter().filter(|o| matches!(o.msg, OutMsg::Imu { .. })).collect();
    assert!(!imu.is_empty());
    assert!(imu.iter().all(|o| o.target == Target::Stream("imu")));
    assert_eq!(r.core.recipients(&Target::Stream("imu")), vec![2]);
    r.send(2, json!({"type":"unsubscribe","streams":["imu"]}));
    assert!(r.accel(0.2, 0.4, &[]).iter().all(|o| !matches!(o.msg, OutMsg::Imu { .. })));
}

#[test]
fn unknown_messages_get_errors() {
    let mut r = rig("unknown", false, false, false);
    r.core.connect(1);
    assert_eq!(errors(&r.core.message(1, "{")), ["invalid JSON"]);
    assert_eq!(errors(&r.send(1, json!({"type":"teleport"}))), ["unknown message type: teleport"]);
    assert!(matches!(&r.send(1, json!({"type":"air_session_start"}))[0].msg, OutMsg::Session { kind, error: Some(e), .. } if kind == "air" && e.contains("camera")));
    let OutMsg::Catalog { catalog } = &r.send(1, json!({"type":"catalog_get"}))[0].msg else { panic!() };
    assert_eq!(catalog["apps"][0]["key"], "excel");
    assert!(matches!(&r.send(1, json!({"type":"request_permission","which":"accessibility"}))[0].msg, OutMsg::Hello { .. }));
}
