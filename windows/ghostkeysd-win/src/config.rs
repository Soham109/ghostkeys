//! The config schema from docs/PROTOCOL.md, decoded as leniently as the Swift daemon does:
//! missing fields get defaults instead of failing the whole file. Unknown keys are kept and written
//! back, so a config edited by a newer app survives a round trip through this daemon.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The one pseudo zone on Windows. There is no tap localization (no zone classifier), so every
/// knock, from the accelerometer or the microphone, lands here.
pub const ANYWHERE: &str = "anywhere";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZoneRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
    pub surface: String,
    pub rect: ZoneRect,
    pub color: String,
}

fn yes() -> bool {
    true
}
fn star() -> String {
    "*".into()
}
fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub id: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub gesture: String,
    /// Written as an explicit `null` when absent, as in PROTOCOL.md.
    #[serde(default)]
    pub zone: Option<String>,
    #[serde(default)]
    pub zones: Option<Vec<String>>,
    #[serde(default)]
    pub modifiers: Vec<String>,
    /// `"*"` or an app id. On Windows the app id is the lowercased exe name (`excel.exe`); a few Mac
    /// bundle ids are mapped, see `bindings::app_matches`.
    #[serde(default = "star")]
    pub app: String,
    #[serde(default = "empty_object")]
    pub action: Value,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sensitivity: f64,
    pub typing_gate_ms: f64,
    pub double_window_ms: f64,
    pub min_confidence: f64,
    pub hud: bool,
    pub haptics: bool,
    /// Every other key, kept verbatim. Windows reads `sound` (the Mac's sound-mode settings:
    /// `sessionSeconds`, plus the Windows-only `alwaysOn`).
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sensitivity: 0.5,
            typing_gate_ms: 450.0,
            double_window_ms: 350.0,
            min_confidence: 0.8,
            hud: true,
            haptics: false,
            extra: Map::new(),
        }
    }
}

impl Settings {
    /// Same clamping as `AppSettings.detection` in the Swift daemon.
    pub fn sensitivity(&self) -> f64 {
        clamp(self.sensitivity, 0.0, 1.0)
    }
    pub fn typing_gate_s(&self) -> f64 {
        self.typing_gate_ms.max(0.0) / 1000.0
    }
    pub fn double_window_s(&self) -> f64 {
        self.double_window_ms.max(50.0) / 1000.0
    }
    /// `settings.sound.sessionSeconds` (Mac default 30).
    pub fn sound_session_seconds(&self) -> f64 {
        self.extra.get("sound").and_then(|s| s.get("sessionSeconds")).and_then(Value::as_f64).unwrap_or(30.0)
    }

    /// Windows only: `settings.sound.alwaysOn` keeps the microphone open for knocks, for laptops
    /// with no accelerometer. Off by default; the Mac ignores the key.
    pub fn sound_always_on(&self) -> bool {
        self.extra.get("sound").and_then(|s| s.get("alwaysOn")).and_then(Value::as_bool).unwrap_or(false)
    }
}

fn one() -> i64 {
    1
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "one")]
    pub version: i64,
    #[serde(default = "Config::default_zones")]
    pub zones: Vec<Zone>,
    #[serde(default)]
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub settings: Settings,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            version: 1,
            zones: Self::default_zones(),
            bindings: Self::default_bindings(),
            settings: Settings::default(),
            extra: Map::new(),
        }
    }
}

pub const MULTI_TAP_GESTURES: [&str; 3] = ["double", "triple", "rhythm"];

impl Config {
    /// Windows has one zone: the whole machine.
    pub fn default_zones() -> Vec<Zone> {
        vec![Zone {
            id: ANYWHERE.into(),
            name: "Anywhere on the laptop".into(),
            surface: "base".into(),
            rect: ZoneRect { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
            color: "#7C5CFF".into(),
        }]
    }

    /// Two harmless defaults, like the Mac: double knock raises the volume, triple lowers it.
    pub fn default_bindings() -> Vec<Binding> {
        let b = |id: &str, gesture: &str, step: i64, label: &str| Binding {
            id: id.into(),
            enabled: true,
            gesture: gesture.into(),
            zone: Some(ANYWHERE.into()),
            zones: None,
            modifiers: vec![],
            app: "*".into(),
            action: json!({ "kind": "volume", "step": step }),
            label: Some(label.into()),
            extra: Map::new(),
        };
        vec![b("b1", "double", 6, "Volume up"), b("b2", "triple", -6, "Volume down")]
    }

    /// Zones with at least one enabled double / triple / rhythm / sequence binding. Taps in these
    /// zones wait for the double window before firing a plain "tap".
    pub fn zones_needing_multi_tap(&self) -> BTreeSet<String> {
        let mut s = BTreeSet::new();
        for b in self.bindings.iter().filter(|b| b.enabled) {
            if MULTI_TAP_GESTURES.contains(&b.gesture.as_str()) {
                if let Some(z) = &b.zone {
                    s.insert(z.clone());
                }
            }
            if b.gesture == "sequence" {
                s.extend(b.zones.clone().unwrap_or_default());
            }
        }
        s
    }
}

pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    x.max(lo).min(hi)
}
