//! The daemon's brain, with no I/O: messages and sensor readings go in, protocol messages come out.
//! The server (`server.rs`) owns the sockets and the timers and feeds this one event at a time,
//! which is what makes the whole daemon testable on a Mac.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::actions::ActionExecutor;
use crate::bindings;
use crate::clock;
use crate::config::{Config, ANYWHERE};
use crate::detection::grammar::GestureGrammar;
use crate::detection::knock::{KnockDetector, KnockOutput};
use crate::detection::light::{normalize_lux, LightGestureDetector};
use crate::detection::sound::SoundOutput;
use crate::detection::tilt::{roll_from_accel, TiltDetector};
use crate::detection::{GestureEvent, TapEvent};
use crate::excel;
use crate::log;
use crate::platform::{InputActivity, MotionInfo, SensorEvent};
use crate::protocol::{parse_in, Device, InMsg, OutMsg, Permissions, Sensors, STREAMS, VERSION};
use crate::security::{ActionLimiter, ApprovalStore, Verdict};
use crate::store::ConfigStore;

pub type ClientId = u64;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Target {
    Client(ClientId),
    All,
    /// Only clients subscribed to this stream. Stream frames are the ones a slow client may miss.
    Stream(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outgoing {
    pub target: Target,
    pub msg: OutMsg,
}

fn to(target: Target, msg: OutMsg) -> Outgoing {
    Outgoing { target, msg }
}

/// Result of an action, delivered back to the core by the action thread.
#[derive(Debug, Clone, PartialEq)]
pub struct ActionDone {
    pub t: f64,
    pub binding_id: Option<String>,
    pub label: String,
    pub result: Result<(), String>,
    /// test_action results go only to the client that asked.
    pub reply_to: Option<ClientId>,
}

/// Hardware found at start, for `hello` and to decide which detectors run.
#[derive(Debug, Clone, Default)]
pub struct Hardware {
    pub device: Option<Device>,
    pub motion: MotionInfo,
    pub light: bool,
    pub mic: bool,
    pub camera: bool,
    /// "authorized" | "denied" | "not_determined", from the Windows privacy settings.
    pub mic_permission: Option<String>,
    pub camera_permission: Option<String>,
}

/// Everything `Core` needs from outside.
pub struct CoreDeps {
    pub hardware: Hardware,
    pub store: ConfigStore,
    pub input: Arc<dyn InputActivity>,
    pub executor: ActionExecutor,
    pub paused: Arc<AtomicBool>,
    pub approvals: Arc<ApprovalStore>,
    pub notify: Arc<dyn Fn(ActionDone) + Send + Sync>,
}

/// How long the sound detector watches an impulse before reporting it; the grammar keeps a group
/// open this much longer so a knock heard at the edge of the double window still counts.
const SOUND_LATENCY: f64 = 0.07;
/// Gesture actions that would start more than this late are dropped (stale), as on the Mac.
const GESTURE_MAX_AGE: Duration = Duration::from_secs(1);
/// Sessions last at most this long (the Mac's SessionCoordinator.maxSeconds).
pub const MAX_SESSION_SECONDS: f64 = 120.0;
pub const TEST_ACTIONS_PER_SECOND: usize = 2;

#[derive(Debug, Default)]
struct ClientState {
    streams: BTreeSet<String>,
    test_times: Vec<f64>,
    feedback_times: Vec<f64>,
}

pub struct Core {
    hardware: Hardware,
    store: ConfigStore,
    config: Config,
    paused: Arc<AtomicBool>,
    paused_reason: Option<String>,
    input: Arc<dyn InputActivity>,
    executor: ActionExecutor,
    approvals: Arc<ApprovalStore>,
    limiter: ActionLimiter,
    notify: Arc<dyn Fn(ActionDone) + Send + Sync>,
    clients: BTreeMap<ClientId, ClientState>,
    sound_session_until: Option<f64>,
    sound_last_report: i64,

    grammar: GestureGrammar,
    knock: KnockDetector,
    tilt: TiltDetector,
    light: LightGestureDetector,

    light_value: Option<f64>,
    last_light_sent: f64,
    last_imu_sent: f64,
    gyro: [f64; 3],
    imu_count: u32,
    imu_window_start: f64,
    imu_hz: f64,
    last_status: f64,
}

impl Core {
    pub fn new(d: CoreDeps) -> Core {
        let config = d.store.load();
        let mut core = Core {
            hardware: d.hardware,
            store: d.store,
            config,
            paused: d.paused,
            paused_reason: None,
            input: d.input,
            executor: d.executor,
            approvals: d.approvals,
            limiter: ActionLimiter::default(),
            notify: d.notify,
            clients: BTreeMap::new(),
            sound_session_until: None,
            sound_last_report: -1,
            grammar: GestureGrammar::default(),
            knock: KnockDetector::default(),
            tilt: TiltDetector::default(),
            light: LightGestureDetector::default(),
            light_value: None,
            last_light_sent: f64::NEG_INFINITY,
            last_imu_sent: f64::NEG_INFINITY,
            gyro: [0.0; 3],
            imu_count: 0,
            imu_window_start: -1.0,
            imu_hz: 0.0,
            last_status: 0.0,
        };
        core.apply_config();
        core
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn set_paused(&mut self, paused: bool, reason: Option<&str>) {
        self.paused.store(paused, Ordering::SeqCst);
        self.paused_reason = if paused { Some(reason.unwrap_or("user").to_string()) } else { None };
    }

    /// The microphone is open only during a sound session (`sound_session_start`), or always when
    /// the user opted in with the Windows-only `settings.sound.alwaysOn: true` (for laptops with no
    /// accelerometer, where the mic is the only knock sensor). Never while paused. Returns the
    /// detector sensitivity, or None when capture should be off.
    pub fn sound_wanted(&self) -> Option<f64> {
        let on = !self.is_paused() && (self.sound_session_until.is_some() || self.config.settings.sound_always_on());
        (self.hardware.mic && on).then(|| self.config.settings.sensitivity())
    }

    /// Is any knock source available (accelerometer, or the microphone in sound mode)?
    fn knocks_available(&self) -> bool {
        self.hardware.motion.accelerometer || self.sound_wanted().is_some()
    }

    fn apply_config(&mut self) {
        let s = &self.config.settings;
        self.grammar.double_window = s.double_window_s();
        self.grammar.zones_needing_multi_tap = self.config.zones_needing_multi_tap();
        self.knock.sensitivity = s.sensitivity();
    }

    // ------------------------------------------------------------ snapshots

    pub fn hello(&self) -> OutMsg {
        let m = self.hardware.motion;
        OutMsg::Hello {
            version: VERSION.into(),
            device: self.hardware.device.clone().unwrap_or(Device { model: "unknown".into(), chip: "unknown".into(), family: "other".into() }),
            sensors: Sensors {
                imu: m.accelerometer,
                gyro: m.gyrometer,
                lid: false, // Windows exposes the lid switch, never a lid angle.
                light: self.hardware.light,
                inclinometer: Some(m.inclinometer),
                sound: Some(self.hardware.mic),
                camera: Some(self.hardware.camera),
            },
            // Windows has no Accessibility-style gate for SendInput or SetWindowPos. (UIPI still
            // blocks input into elevated windows; that is reported per action, not here.)
            permissions: Permissions {
                accessibility: true,
                microphone: self.hardware.mic_permission.clone(),
                camera: self.hardware.camera_permission.clone(),
            },
        }
    }

    pub fn status(&self) -> OutMsg {
        let ready = self.knocks_available();
        let detector = self.hardware.motion.accelerometer.then(|| {
            let mut m = Map::new();
            m.insert("noiseFloorMg".into(), json!(r4(self.knock.noise() * 1000.0)));
            m.insert("thresholdMg".into(), json!(r4(self.knock.threshold() * 1000.0)));
            m.insert("level".into(), json!(r4(self.knock.level * 1000.0)));
            m
        });
        OutMsg::Status {
            paused: self.is_paused(),
            // No calibration exists on Windows: "calibrated" means "knocks can be detected now".
            calibrated: ready,
            zones: if ready { vec![ANYWHERE.into()] } else { vec![] },
            paused_reason: Some(self.paused_reason.clone().filter(|_| self.is_paused())),
            imu_hz: self.imu_hz.round() as i64,
            detector,
        }
    }

    fn config_msg(&self) -> OutMsg {
        OutMsg::Config { config: self.config.clone() }
    }

    /// `{type: session}` in the Mac's shape. `reason` when it ended or failed, `error` on failure.
    fn session_msg(&self, kind: &str, now: f64, reason: Option<&str>, error: Option<String>) -> OutMsg {
        let active = kind == "sound" && self.sound_session_until.is_some();
        let left = if active { self.sound_session_until.map(|u| (u - now).max(0.0).ceil()).unwrap_or(0.0) } else { 0.0 };
        OutMsg::Session {
            kind: kind.into(),
            active,
            seconds_left: left,
            reason: reason.map(String::from),
            trigger: active.then(|| "request".to_string()),
            error,
            sonar: None,
            tap_types: None,
            simulated: None,
            extra: Map::new(),
        }
    }

    /// Sonar (Mac: 20 kHz tones through the built-in speakers) is not available on Windows. The
    /// state message still goes out, so the app can show the switch as unavailable.
    fn sonar_msg(&self, reason: Option<&str>, error: Option<String>) -> OutMsg {
        let mut extra = Map::new();
        extra.insert("enabled".into(), json!(self.config.settings.sonar_enabled()));
        extra.insert("continuous".into(), json!(true));
        OutMsg::Session {
            kind: "sonar".into(),
            active: false,
            seconds_left: 0.0,
            reason: reason.map(String::from),
            trigger: None,
            error,
            sonar: None,
            tap_types: None,
            simulated: None,
            extra,
        }
    }

    /// Ends the sound session (if any) and says why.
    fn stop_sound(&mut self, now: f64, reason: &str) -> Vec<Outgoing> {
        if self.sound_session_until.take().is_none() {
            return vec![];
        }
        vec![to(Target::All, self.session_msg("sound", now, Some(reason), None)), to(Target::All, self.status())]
    }

    /// The server could not open the microphone for a session that was just started.
    pub fn sound_failed(&mut self, error: String) -> Vec<Outgoing> {
        let now = clock::now();
        self.sound_session_until = None;
        vec![to(Target::All, self.session_msg("sound", now, Some("error"), Some(error))), to(Target::All, self.status())]
    }

    // ------------------------------------------------------------ clients

    pub fn connect(&mut self, id: ClientId) -> Vec<Outgoing> {
        self.clients.insert(id, ClientState::default());
        let now = clock::now();
        let me = Target::Client(id);
        vec![
            to(me, self.hello()),
            to(me, self.status()),
            to(me, self.config_msg()),
            to(me, self.session_msg("sound", now, None, None)),
            to(me, self.session_msg("air", now, None, None)),
            to(me, self.sonar_msg(None, None)),
        ]
    }

    pub fn disconnect(&mut self, id: ClientId) {
        self.clients.remove(&id);
    }

    pub fn has_subscribers(&self, stream: &str) -> bool {
        self.clients.values().any(|c| c.streams.contains(stream))
    }

    /// Which clients get a message.
    pub fn recipients(&self, target: &Target) -> Vec<ClientId> {
        match target {
            Target::Client(id) => self.clients.contains_key(id).then_some(*id).into_iter().collect(),
            Target::All => self.clients.keys().copied().collect(),
            Target::Stream(s) => self.clients.iter().filter(|(_, c)| c.streams.contains(*s)).map(|(id, _)| *id).collect(),
        }
    }

    pub fn message(&mut self, id: ClientId, text: &str) -> Vec<Outgoing> {
        let msg = match parse_in(text) {
            Ok(m) => m,
            Err(e) => return vec![to(Target::Client(id), OutMsg::error(e))],
        };
        log::debug(&format!("<- {msg:?}"));
        let now = clock::now();
        let me = Target::Client(id);
        let mut out = vec![];
        match msg {
            InMsg::Subscribe { streams } => {
                let wanted: Vec<&'static str> = STREAMS.iter().copied().filter(|s| streams.iter().any(|x| x == s)).collect();
                if let Some(c) = self.clients.get_mut(&id) {
                    c.streams.extend(wanted.iter().map(|s| s.to_string()));
                }
                // Give new subscribers the current value right away.
                if wanted.contains(&"light") {
                    if let Some(v) = self.light_value {
                        out.push(to(me, OutMsg::Light { t: clock::ms(now), value: r4(v) }));
                    }
                }
            }
            InMsg::Unsubscribe { streams } => {
                if let Some(c) = self.clients.get_mut(&id) {
                    for s in streams {
                        c.streams.remove(&s);
                    }
                }
            }
            InMsg::Pause => {
                self.set_paused(true, Some("user"));
                out.extend(self.stop_sound(now, "paused"));
                out.push(to(Target::All, self.status()));
            }
            InMsg::Resume => {
                self.set_paused(false, None);
                self.limiter.reset();
                out.push(to(Target::All, self.status()));
            }
            InMsg::CalibrationStart { .. } | InMsg::CalibrationZone { .. } | InMsg::CalibrationNegatives { .. } | InMsg::CalibrationFinish => {
                out.push(to(
                    me,
                    OutMsg::error("calibration is not available on Windows: knocks are counted, not located, so there are no zones to learn"),
                ));
            }
            InMsg::CalibrationCancel => {
                out.push(to(Target::All, OutMsg::Calibration { phase: "cancelled".into(), fields: Map::new() }));
            }
            InMsg::ConfigGet => out.push(to(me, self.config_msg())),
            InMsg::ConfigSet { config } => {
                if !config.is_object() {
                    out.push(to(me, OutMsg::error("config_set needs a config object")));
                } else {
                    match serde_json::from_value::<Config>(config) {
                        Ok(new) => match self.store.save(&new) {
                            Ok(()) => {
                                self.config = new;
                                self.apply_config();
                                out.push(to(Target::All, self.config_msg()));
                                out.push(to(Target::All, self.status()));
                            }
                            Err(e) => out.push(to(me, OutMsg::error(format!("could not save config: {e}")))),
                        },
                        Err(e) => out.push(to(me, OutMsg::error(format!("invalid config: {e}")))),
                    }
                }
            }
            InMsg::TestAction { action } => {
                let label = action
                    .get("label")
                    .and_then(Value::as_str)
                    .map(String::from)
                    .unwrap_or_else(|| format!("Test: {}", action.get("kind").and_then(Value::as_str).unwrap_or("?")));
                let fail = |label: String, error: String| {
                    action_msg(&ActionDone { t: now, binding_id: None, label, result: Err(error), reply_to: Some(id) })
                };
                let recent = self.clients.get_mut(&id).map(|c| {
                    c.test_times.retain(|t| now - t < 1.0);
                    c.test_times.len()
                });
                if recent.unwrap_or(0) >= TEST_ACTIONS_PER_SECOND {
                    out.push(fail(label, format!("rate limit: at most {TEST_ACTIONS_PER_SECOND} test actions per second")));
                } else {
                    if let Some(c) = self.clients.get_mut(&id) {
                        c.test_times.push(now);
                    }
                    if let Verdict::Tripped(why) = self.limiter.admit_global(now) {
                        out.extend(self.trip_rate_limit(&why));
                        out.push(fail(label, format!("rate limit: {why}; paused")));
                    } else {
                        out.extend(self.run_action(action, None, label, now, None, Some(id)));
                    }
                }
            }
            InMsg::ApproveAction { action } => match self.approvals.approve(&action) {
                Ok(hash) => {
                    log::info(&format!("approved {action}"));
                    let kind = action.get("kind").and_then(Value::as_str).map(String::from);
                    out.push(to(me, OutMsg::Approved { hash, kind }));
                }
                Err(e) => out.push(to(me, OutMsg::error(format!("approve_action: {e}")))),
            },
            InMsg::RevokeAction { hash, action } => {
                match hash.or_else(|| action.as_ref().and_then(ApprovalStore::hash)) {
                    None => out.push(to(me, OutMsg::error("revoke_action needs a hash or an action"))),
                    Some(h) => match self.approvals.revoke(&h) {
                        Ok(found) => out.push(to(me, OutMsg::Revoked { hash: h, found })),
                        Err(e) => out.push(to(me, OutMsg::error(format!("revoke_action: {e}")))),
                    },
                }
            }
            InMsg::RequestPermission { which } => {
                if which == "accessibility" {
                    // Nothing to prompt for on Windows; answer with the current state.
                    out.push(to(me, self.hello()));
                } else {
                    out.push(to(me, OutMsg::error("unknown permission")));
                }
            }
            InMsg::SoundSessionStart { seconds } => {
                let fail = |core: &Core, e: &str| to(me, core.session_msg("sound", now, Some("error"), Some(e.into())));
                if self.is_paused() {
                    out.push(fail(self, "paused"));
                } else if !self.hardware.mic {
                    out.push(fail(self, "no microphone"));
                } else {
                    let requested = seconds.filter(|s| s.is_finite()).unwrap_or(self.config.settings.sound_session_seconds());
                    self.sound_session_until = Some(now + requested.clamp(1.0, MAX_SESSION_SECONDS));
                    self.sound_last_report = -1;
                    out.push(to(Target::All, self.session_msg("sound", now, None, None)));
                    out.push(to(Target::All, self.status()));
                }
            }
            InMsg::SoundSessionStop => out.extend(self.stop_sound(now, "requested")),
            InMsg::AirSessionStart { .. } => {
                out.push(to(me, self.session_msg("air", now, Some("error"), Some("the camera add-on is not available on Windows yet".into()))));
            }
            InMsg::AirSessionStop => {}
            InMsg::CatalogGet => out.push(to(me, OutMsg::Catalog { catalog: excel::catalog() })),
            InMsg::CalibrationTaptypeStart { .. } => {
                let mut fields = Map::new();
                fields.insert("error".into(), json!("tap-type calibration is not available on Windows yet"));
                out.push(to(me, OutMsg::Calibration { phase: "taptype_failed".into(), fields }));
            }
            InMsg::CalibrationTaptypeCancel => {}
            InMsg::CalibrationApplyRecommendation | InMsg::CalibrationApplyMerge { .. } => {
                out.push(to(me, OutMsg::error("calibration is not available on Windows: there are no zones to keep, drop or merge")));
            }
            InMsg::SonarSessionStart => {
                out.push(to(me, self.sonar_msg(Some("error"), Some("sonar is not available on Windows".into()))));
            }
            InMsg::SonarSessionStop => {
                // Turns settings.sonar.enabled off (saved, config broadcast), as on the Mac.
                if self.config.settings.sonar_enabled() {
                    let mut new = self.config.clone();
                    if let Some(Value::Object(sonar)) = new.settings.extra.get_mut("sonar") {
                        sonar.insert("enabled".into(), json!(false));
                    }
                    match self.store.save(&new) {
                        Ok(()) => {
                            self.config = new;
                            out.push(to(Target::All, self.config_msg()));
                        }
                        Err(e) => out.push(to(me, OutMsg::error(format!("could not save config: {e}")))),
                    }
                }
                out.push(to(Target::All, self.sonar_msg(Some("turned_off"), None)));
            }
            InMsg::FeedbackMissed { .. } | InMsg::FeedbackFalse => {
                let (kind, zone) = match &msg_kind_zone(text) {
                    Some((k, z)) => (k.clone(), z.clone()),
                    None => ("false".to_string(), None),
                };
                // At most one every 2 s and 20 per minute, like the Mac.
                let times = self.clients.get_mut(&id).map(|c| {
                    c.feedback_times.retain(|t| now - t < 60.0);
                    let ok = c.feedback_times.len() < 20 && c.feedback_times.last().is_none_or(|l| now - l >= 2.0);
                    if ok {
                        c.feedback_times.push(now);
                    }
                    ok
                });
                if times == Some(false) {
                    out.push(to(me, OutMsg::error("feedback: at most one every 2 s and 20 per minute")));
                } else {
                    let mut f = Map::new();
                    if let Some(z) = zone {
                        f.insert("zone".into(), json!(z));
                    }
                    f.insert("retrained".into(), json!(false));
                    f.insert("reason".into(), json!("not calibrated yet"));
                    f.insert("note".into(), json!("Windows counts knocks without a zone model, so there is nothing to learn from feedback"));
                    out.push(to(me, feedback_msg(&kind, f)));
                }
            }
            InMsg::DiagnosticsExport => {
                out.push(to(me, OutMsg::error("diagnostics export is not available on Windows yet")));
            }
        }
        out
    }

    // ------------------------------------------------------------ sensors

    pub fn sensor(&mut self, ev: SensorEvent) -> Vec<Outgoing> {
        let mut out = vec![];
        match ev {
            SensorEvent::Accel { t, a } => {
                self.count_imu(t);
                if t - self.last_imu_sent >= 1.0 / 60.0 - 0.0005 && self.has_subscribers("imu") {
                    self.last_imu_sent = t;
                    out.push(to(
                        Target::Stream("imu"),
                        OutMsg::Imu { t: clock::ms(t), a: [r4(a[0]), r4(a[1]), r4(a[2])], g: [r4(self.gyro[0]), r4(self.gyro[1]), r4(self.gyro[2])] },
                    ));
                }
                if let Some(name) = self.tilt.process(roll_from_accel(a), t) {
                    out.extend(self.on_gesture(GestureEvent::zoneless(name, t), true));
                }
                match self.knock.process(a, t) {
                    Some(KnockOutput::Knock { t, strength }) => out.extend(self.on_knock(t, strength, "imu")),
                    Some(KnockOutput::Rejected { t, reason }) => out.push(rejected(t, reason)),
                    None => {}
                }
            }
            SensorEvent::Gyro { g, .. } => self.gyro = g,
            SensorEvent::Inclination { t, roll, .. } => {
                // Only used for tilt when there is no accelerometer to derive roll from.
                if !self.hardware.motion.accelerometer {
                    if let Some(name) = self.tilt.process(roll, t) {
                        out.extend(self.on_gesture(GestureEvent::zoneless(name, t), true));
                    }
                }
            }
            SensorEvent::Light { t, lux } => {
                let v = normalize_lux(lux);
                self.light_value = Some(v);
                if t - self.last_light_sent >= 0.09 {
                    self.last_light_sent = t;
                    out.push(to(Target::Stream("light"), OutMsg::Light { t: clock::ms(t), value: r4(v) }));
                }
                if let Some(g) = self.light.ingest(v, t) {
                    out.extend(self.on_gesture(g, true));
                }
            }
            SensorEvent::Sound(SoundOutput::Knock(imp)) => {
                // Late events from a session that just ended are ignored.
                if self.sound_wanted().is_some() {
                    log::debug(&format!("sound knock peak {:.4} decay {:.2} hf {:.2}", imp.peak, imp.decay_ratio, imp.hf_ratio));
                    out.extend(self.on_knock(imp.t, imp.strength, "sound"));
                }
            }
            SensorEvent::Sound(SoundOutput::Burst { t }) => out.push(rejected(t, "burst")),
        }
        out
    }

    fn count_imu(&mut self, t: f64) {
        if self.imu_window_start < 0.0 {
            self.imu_window_start = t;
        }
        self.imu_count += 1;
        if t - self.imu_window_start >= 1.0 {
            self.imu_hz = self.imu_count as f64 / (t - self.imu_window_start);
            self.imu_count = 0;
            self.imu_window_start = t;
        }
    }

    /// A knock from either source: gates, then the grammar.
    fn on_knock(&mut self, t: f64, strength: f64, source: &str) -> Vec<Outgoing> {
        if self.is_paused() {
            return vec![rejected_knock(t, "paused")];
        }
        if self.input.seconds_since_input() < self.config.settings.typing_gate_s() {
            return vec![rejected_knock(t, "typing")];
        }
        if self.tilt.in_excursion() {
            return vec![rejected(t, "motion")];
        }
        // No classifier on Windows: every knock that passes the gates is certain enough to count.
        let confidence = 1.0;
        let tap = TapEvent { t, zone: ANYWHERE.into(), confidence, strength, modifiers: self.input.modifiers() };
        let mut out = vec![to(
            Target::Stream("taps"),
            OutMsg::Tap {
                t: clock::ms(t),
                zone: tap.zone.clone(),
                confidence,
                x: 0.5,
                y: 0.5,
                strength: r4(strength),
                tap_type: None,
                source: Some(source.into()),
            },
        )];
        for g in self.grammar.accept(&tap) {
            out.extend(self.on_gesture(g, false));
        }
        out
    }

    // ------------------------------------------------------------ gestures and actions

    fn on_gesture(&mut self, mut g: GestureEvent, fill_modifiers: bool) -> Vec<Outgoing> {
        if fill_modifiers && g.modifiers.is_empty() {
            g.modifiers = self.input.modifiers();
        }
        if self.is_paused() {
            return vec![rejected(g.t, "paused")];
        }
        let app = self.input.foreground_app();
        let mut out = vec![to(
            Target::All,
            OutMsg::Gesture {
                t: clock::ms(g.t),
                gesture: g.gesture.clone(),
                zone: g.zone.clone(),
                zones: g.zones.clone(),
                modifiers: g.modifiers.iter().cloned().collect(),
                confidence: g.confidence,
                app: app.clone(),
            },
        )];
        let Some(b) = bindings::resolve(&g, &self.config.bindings, app.as_deref()) else { return out };
        let (action, id, label) = (b.action.clone(), b.id.clone(), b.label.clone().unwrap_or_else(|| b.id.clone()));
        match self.limiter.admit(&id, &g.gesture, clock::now()) {
            Verdict::Ok => out.extend(self.run_action(action, Some(id), label, g.t, Some(GESTURE_MAX_AGE), None)),
            Verdict::Cooldown => log::debug(&format!("binding {id} in cooldown or still running; skipped")),
            Verdict::Tripped(why) => {
                out.extend(self.trip_rate_limit(&why));
                out.push(action_msg(&ActionDone { t: g.t, binding_id: Some(id), label, result: Err(format!("rate limit: {why}; paused")), reply_to: None }));
            }
        }
        out
    }

    /// Too many actions: pause everything and tell the app why.
    fn trip_rate_limit(&mut self, why: &str) -> Vec<Outgoing> {
        if self.is_paused() {
            return vec![];
        }
        log::info(&format!("action rate limit tripped ({why}); pausing"));
        self.set_paused(true, Some("rate_limit"));
        vec![to(Target::All, self.status())]
    }

    fn run_action(
        &mut self,
        action: Value,
        binding_id: Option<String>,
        label: String,
        t: f64,
        max_age: Option<Duration>,
        reply_to: Option<ClientId>,
    ) -> Vec<Outgoing> {
        if self.is_paused() {
            if let Some(b) = &binding_id {
                self.limiter.finished(b);
            }
            return vec![action_msg(&ActionDone { t, binding_id, label, result: Err("paused".into()), reply_to })];
        }
        let notify = self.notify.clone();
        self.executor.run(action, max_age, move |result| notify(ActionDone { t, binding_id, label, result, reply_to }));
        vec![]
    }

    pub fn action_done(&mut self, done: ActionDone) -> Vec<Outgoing> {
        if let Some(b) = &done.binding_id {
            self.limiter.finished(b);
        }
        if let Err(e) = &done.result {
            log::info(&format!("action {} failed: {e}", done.label));
        }
        if let Some(id) = done.reply_to {
            if !self.clients.contains_key(&id) {
                return vec![]; // the requester is gone
            }
        }
        vec![action_msg(&done)]
    }

    // ------------------------------------------------------------ time

    /// Called about every 100 ms: closes knock groups, fires cover_hold, ends sound sessions,
    /// sends status every 5 s.
    pub fn tick(&mut self, now: f64) -> Vec<Outgoing> {
        let mut out = vec![];
        if let Some(until) = self.sound_session_until {
            if now >= until {
                out.extend(self.stop_sound(now, "timeout"));
            } else {
                // Like the Mac: a progress report every 5 s.
                let left = (until - now).ceil() as i64;
                if left % 5 == 0 && left != self.sound_last_report {
                    self.sound_last_report = left;
                    out.push(to(Target::All, self.session_msg("sound", now, None, None)));
                }
            }
        }
        // Knocks arrive late (the accelerometer pulse must end; the sound detector watches 60 ms),
        // so judge the double window against a slightly earlier "now".
        let in_flight = self.knock.in_flight();
        let lag = if self.sound_wanted().is_some() { SOUND_LATENCY } else { 0.0 };
        for g in self.grammar.tick(now - lag, in_flight) {
            out.extend(self.on_gesture(g, false));
        }
        if let Some(g) = self.light.poll(now) {
            out.extend(self.on_gesture(g, true));
        }
        if now - self.last_status >= 5.0 {
            self.last_status = now;
            out.push(to(Target::All, self.status()));
        }
        out
    }
}

/// ("missed" | "false", zone) of a feedback message's raw text.
fn msg_kind_zone(text: &str) -> Option<(String, Option<String>)> {
    let v: Value = serde_json::from_str(text).ok()?;
    let kind = match v.get("type")?.as_str()? {
        "feedback_missed" => "missed",
        _ => "false",
    };
    Some((kind.to_string(), v.get("zone").and_then(Value::as_str).map(String::from)))
}

/// A rejection without features (motion, burst): no zone / confidence / strength, as on the Mac.
fn rejected(t: f64, reason: &str) -> Outgoing {
    to(Target::Stream("taps"), OutMsg::Rejected { t: clock::ms(t), reason: reason.into(), zone: None, confidence: None, strength: None })
}

/// A knock dropped by a gate: it would have landed in `anywhere` with confidence 1. No `strength`:
/// the Windows detectors do not measure the peak in milli-g the Mac reports there.
fn rejected_knock(t: f64, reason: &str) -> Outgoing {
    to(
        Target::Stream("taps"),
        OutMsg::Rejected { t: clock::ms(t), reason: reason.into(), zone: Some(ANYWHERE.into()), confidence: Some(1.0), strength: None },
    )
}

fn feedback_msg(kind: &str, fields: Map<String, Value>) -> OutMsg {
    OutMsg::Feedback { kind: kind.into(), fields }
}

fn action_msg(d: &ActionDone) -> Outgoing {
    let target = d.reply_to.map(Target::Client).unwrap_or(Target::All);
    to(
        target,
        OutMsg::Action { t: clock::ms(d.t), binding_id: d.binding_id.clone(), label: d.label.clone(), ok: d.result.is_ok(), error: d.result.clone().err() },
    )
}

fn r4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}
