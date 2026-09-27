//! Message types from docs/PROTOCOL.md. One JSON object per WebSocket text frame, tagged by `"type"`.
//!
//! These mirror the Swift daemon field for field so the Electron app cannot tell the two apart.
//! Windows-only additions are optional fields that are left out of the JSON when absent, so a
//! message from the Mac daemon parses here and serializes back unchanged.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::config::Config;

pub const VERSION: &str = "0.1.0";
pub const DEFAULT_PORT: u16 = 47823;
/// "air" is the camera add-on stream; accepted so subscriptions match the Mac, never sent on Windows.
/// "debug" carries `candidate` messages (every knock onset before the gates).
pub const STREAMS: [&str; 6] = ["imu", "lid", "light", "taps", "air", "debug"];

// ---------------------------------------------------------------- daemon -> app

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub model: String,
    pub chip: String,
    pub family: String,
}

/// What hardware exists. The first four keys are the original contract; `sound` and `camera` are
/// the sound-mode / camera add-on keys; `inclinometer` is a Windows addition. Optional keys are left
/// out of the JSON when absent, so a Mac `hello` round-trips unchanged.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sensors {
    pub imu: bool,
    pub gyro: bool,
    pub lid: bool,
    pub light: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inclinometer: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sound: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Permissions {
    pub accessibility: bool,
    /// "authorized" | "denied" | "not_determined" (sound / camera add-ons).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub microphone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<String>,
}

/// Messages the daemon sends. `t` is milliseconds since daemon start.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutMsg {
    Hello {
        version: String,
        device: Device,
        sensors: Sensors,
        permissions: Permissions,
    },
    Status {
        paused: bool,
        calibrated: bool,
        zones: Vec<String>,
        /// Why the daemon is paused ("user" or "rate_limit"), null while running. Same addition as the Mac.
        #[serde(rename = "pausedReason", default, skip_serializing_if = "Option::is_none", deserialize_with = "present")]
        paused_reason: Option<Option<String>>,
        #[serde(rename = "imuHz")]
        imu_hz: i64,
        /// Live knock detector state in milli-g (noiseFloorMg, thresholdMg, level), as the Mac sends.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detector: Option<Map<String, Value>>,
    },
    Imu {
        t: f64,
        a: [f64; 3],
        g: [f64; 3],
    },
    Lid {
        t: f64,
        angle: f64,
    },
    Light {
        t: f64,
        value: f64,
    },
    Tap {
        t: f64,
        zone: String,
        confidence: f64,
        x: f64,
        y: f64,
        strength: f64,
        /// fingertip | knuckle | nail, when sound mode classified it.
        #[serde(rename = "tapType", default, skip_serializing_if = "Option::is_none")]
        tap_type: Option<String>,
        /// What detected it: "imu" (accelerometer), "camera", or on Windows "sound" (microphone only).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        source: Option<String>,
    },
    Rejected {
        t: f64,
        reason: String,
        /// The classifier's best guess for the dropped tap (Mac, when calibrated). Windows sends
        /// `anywhere` for knock rejections, none for motion.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zone: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confidence: Option<f64>,
        /// log10 of the peak in milli-g.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        strength: Option<f64>,
    },
    /// "debug" stream: every onset the detector analysed, before the gates.
    Candidate {
        t: f64,
        zone: Option<String>,
        confidence: f64,
        strength: f64,
        /// "accepted" | a rejection reason | "pending"
        outcome: String,
    },
    /// Reply to feedback_missed / feedback_false, only to the requester.
    Feedback {
        kind: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    /// Reply to diagnostics_export.
    Diagnostics {
        path: String,
        samples: u64,
        seconds: f64,
    },
    Gesture {
        t: f64,
        gesture: String,
        zone: Option<String>,
        zones: Vec<String>,
        modifiers: Vec<String>,
        confidence: f64,
        app: Option<String>,
    },
    Action {
        t: f64,
        #[serde(rename = "bindingId")]
        binding_id: Option<String>,
        label: String,
        ok: bool,
        error: Option<String>,
    },
    /// Every calibration message has a `phase`; the other fields depend on it
    /// (`zone`/`count`/`target`, `secondsLeft`, `accuracy`/`overall`/`confusion`/`labels`, ...).
    Calibration {
        phase: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    Config {
        config: Config,
    },
    Error {
        message: String,
    },
    /// Reply to approve_action, only to the requester.
    Approved {
        hash: String,
        kind: Option<String>,
    },
    /// Reply to revoke_action, only to the requester.
    Revoked {
        hash: String,
        found: bool,
    },
    /// Sound or camera session state (broadcast on change; a failed start goes to the requester).
    Session {
        kind: String,
        active: bool,
        #[serde(rename = "secondsLeft")]
        seconds_left: f64,
        /// Why it ended: requested | timeout | paused | error | ...
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        /// What started it: request | auto (only while active).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
        /// Sound only (Mac): pilot tone playing / tap-type model loaded. Never set on Windows.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sonar: Option<bool>,
        #[serde(rename = "tapTypes", default, skip_serializing_if = "Option::is_none")]
        tap_types: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        simulated: Option<bool>,
        /// Everything else (sonar: enabled, waiting, sonarField, tonesOff, continuous; coveredBy).
        #[serde(flatten)]
        extra: Map<String, Value>,
    },
    /// Continuous camera gestures on the "air" stream (Mac camera add-on; never sent on Windows).
    Air {
        t: f64,
        gesture: String,
        phase: String,
        #[serde(flatten)]
        fields: Map<String, Value>,
    },
    /// Reply to catalog_get: the integration commands this daemon supports.
    Catalog {
        catalog: Value,
    },
}

impl OutMsg {
    pub fn error(message: impl Into<String>) -> Self {
        OutMsg::Error { message: message.into() }
    }

    pub fn to_json(&self) -> String {
        // Serialization of these types cannot fail (no maps with non-string keys, no custom impls).
        serde_json::to_string(self).unwrap_or_else(|_| r#"{"type":"error","message":"encode failed"}"#.into())
    }
}

/// For `Option<Option<T>>` fields: absent stays None, an explicit `null` becomes Some(None).
fn present<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

// ---------------------------------------------------------------- app -> daemon

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InMsg {
    Subscribe {
        #[serde(default)]
        streams: Vec<String>,
    },
    Unsubscribe {
        #[serde(default)]
        streams: Vec<String>,
    },
    Pause,
    Resume,
    CalibrationStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zones: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
    },
    CalibrationZone {
        zone: String,
    },
    CalibrationNegatives {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
    },
    CalibrationFinish,
    CalibrationCancel,
    ConfigGet,
    /// Kept as raw JSON so an invalid config yields a precise error message instead of "unknown message".
    ConfigSet {
        config: Value,
    },
    TestAction {
        action: Value,
    },
    RequestPermission {
        which: String,
    },
    /// Only after the user confirmed the exact action in a native dialog.
    ApproveAction {
        action: Value,
    },
    /// By hash, or by the action itself.
    RevokeAction {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hash: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        action: Option<Value>,
    },
    SoundSessionStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
    },
    SoundSessionStop,
    AirSessionStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        seconds: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        camera: Option<String>,
    },
    AirSessionStop,
    CatalogGet,
    /// Tap-type (fingertip / knuckle / nail) calibration; needs sound mode plus a motion sensor.
    CalibrationTaptypeStart {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        types: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        target: Option<f64>,
    },
    CalibrationTaptypeCancel,
    CalibrationApplyRecommendation,
    CalibrationApplyMerge {
        #[serde(default)]
        zones: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        name: Option<String>,
    },
    SonarSessionStart,
    SonarSessionStop,
    FeedbackMissed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        zone: Option<String>,
    },
    FeedbackFalse,
    DiagnosticsExport,
}

/// Parses one text frame. Errors are phrased for the `error` reply.
pub fn parse_in(text: &str) -> Result<InMsg, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "invalid JSON".to_string())?;
    let obj = v.as_object().ok_or_else(|| "invalid JSON".to_string())?;
    let ty = match obj.get("type").and_then(Value::as_str) {
        Some(t) => t.to_string(),
        None => return Err("message has no type".into()),
    };
    serde_json::from_value::<InMsg>(v).map_err(|e| {
        if e.to_string().contains("unknown variant") {
            format!("unknown message type: {ty}")
        } else {
            format!("invalid {ty} message: {e}")
        }
    })
}
