//! Config load/save through ConfigStore, including the lenient decoding the Mac daemon has.

use std::fs;
use std::path::PathBuf;

use ghostkeysd_win::config::{Config, ANYWHERE};
use ghostkeysd_win::store::ConfigStore;
use serde_json::json;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ghostkeys-config-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
}

#[test]
fn missing_file_writes_defaults() {
    let d = dir("missing");
    let store = ConfigStore::new(&d);
    let c = store.load();
    assert_eq!(c, Config::default());
    assert!(store.config_path().exists(), "defaults are written so the app can show them");
    assert_eq!(c.zones[0].id, ANYWHERE);
    assert_eq!(c.bindings.len(), 2);
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn save_then_load_round_trips() {
    let d = dir("roundtrip");
    let store = ConfigStore::new(&d);
    let mut c = Config::default();
    c.settings.sensitivity = 0.8;
    c.bindings[0].action = json!({"kind":"keystroke","key":"v","modifiers":["command"]});
    c.bindings[0].app = "excel.exe".into();
    store.save(&c).unwrap();
    assert_eq!(store.load(), c);
    assert!(!d.join("config.json.tmp").exists(), "atomic write leaves no temp file");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn lenient_decoding_fills_defaults() {
    let c: Config = serde_json::from_value(json!({
        "bindings": [ { "id": "b9", "gesture": "cover" } ],
        "settings": { "sensitivity": 0.2 }
    }))
    .unwrap();
    assert_eq!(c.version, 1);
    assert_eq!(c.zones, Config::default_zones());
    let b = &c.bindings[0];
    assert!(b.enabled);
    assert_eq!(b.app, "*");
    assert_eq!(b.zone, None);
    assert!(b.modifiers.is_empty());
    assert_eq!(b.action, json!({}));
    assert_eq!(c.settings.sensitivity, 0.2);
    assert_eq!(c.settings.typing_gate_ms, 450.0);
    assert_eq!(c.settings.double_window_ms, 350.0);
}

#[test]
fn unknown_keys_survive_a_round_trip() {
    let v = json!({
        "version": 1, "zones": [], "bindings": [ { "id": "b1", "gesture": "tap", "zone": "anywhere", "futureField": [1, 2] } ],
        "settings": { "sound": { "enabled": true, "sessionSeconds": 20, "alwaysOn": true }, "somethingNew": "x" },
        "presets": { "layout": "grid" }
    });
    let c: Config = serde_json::from_value(v).unwrap();
    assert!(c.settings.sound_always_on());
    assert_eq!(c.settings.sound_session_seconds(), 20.0);
    let back = serde_json::to_value(&c).unwrap();
    assert_eq!(back["presets"], json!({ "layout": "grid" }));
    assert_eq!(back["settings"]["somethingNew"], "x");
    assert_eq!(back["settings"]["sound"]["enabled"], true);
    assert_eq!(back["bindings"][0]["futureField"], json!([1, 2]));
}

#[test]
fn a_mac_config_loads_unchanged() {
    // What the Swift daemon writes: Mac zones, bundle-id apps, explicit nulls.
    let text = r##"{
      "bindings" : [ { "action" : { "kind" : "volume", "step" : 6 }, "app" : "com.microsoft.Excel", "enabled" : true,
                       "gesture" : "double", "id" : "b1", "label" : "Volume up", "modifiers" : [ ], "zone" : "right-grille", "zones" : null } ],
      "settings" : { "doubleWindowMs" : 350, "haptics" : false, "hud" : true, "minConfidence" : 0.8, "sensitivity" : 0.5, "typingGateMs" : 450 },
      "version" : 1,
      "zones" : [ { "color" : "#7C5CFF", "id" : "right-grille", "name" : "Right grille", "rect" : { "h" : 0.45, "w" : 0.1, "x" : 0.88, "y" : 0.08 }, "surface" : "base" } ]
    }"##;
    let c: Config = serde_json::from_str(text).unwrap();
    assert_eq!(c.zones[0].id, "right-grille");
    assert_eq!(c.bindings[0].app, "com.microsoft.Excel");
    let again: Config = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
    assert_eq!(again, c);
}

#[test]
fn corrupt_file_is_kept_aside_and_defaults_used() {
    let d = dir("corrupt");
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("config.json"), "{ this is not json").unwrap();
    let store = ConfigStore::new(&d);
    assert_eq!(store.load(), Config::default());
    assert_eq!(fs::read_to_string(d.join("config.json.bad")).unwrap(), "{ this is not json");
    assert_eq!(fs::read_to_string(d.join("config.json")).unwrap(), "{ this is not json", "the original is not overwritten");
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn zones_needing_multi_tap() {
    let mut c = Config::default();
    assert_eq!(c.zones_needing_multi_tap().into_iter().collect::<Vec<_>>(), vec![ANYWHERE.to_string()]);
    for b in &mut c.bindings {
        b.gesture = "tap".into();
    }
    assert!(c.zones_needing_multi_tap().is_empty());
}

#[test]
fn default_directory_is_appdata_ghostkeys() {
    // Only meaningful where APPDATA is set (Windows); elsewhere the override and HOME fallback apply.
    if std::env::var_os("GHOSTKEYS_CONFIG_DIR").is_none() {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            assert_eq!(ConfigStore::default_directory(), PathBuf::from(appdata).join("Ghostkeys"));
        }
    }
}
