//! Every JSON example in docs/PROTOCOL.md parses into this daemon's message types and serializes
//! back to the same JSON. Reads the doc itself, so a message added there without a Windows
//! counterpart fails this test instead of failing silently at runtime.

use ghostkeysd_win::config::Config;
use ghostkeysd_win::protocol::{parse_in, InMsg, OutMsg};
use serde_json::Value;

fn protocol_md() -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/PROTOCOL.md");
    std::fs::read_to_string(path).expect("docs/PROTOCOL.md next to windows/")
}

/// Removes // and /* */ comments outside strings, and fills the doc's `[[...]]` / `[...]` placeholders.
fn strip_jsonc(s: &str) -> String {
    let s = s.replace("[[...]]", "[[1, 0], [0, 1]]").replace("[...]", "[]");
    let b: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let (mut i, mut in_str) = (0, false);
    while i < b.len() {
        let c = b[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < b.len() {
                out.push(b[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_str = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            i += 1;
        } else if c == '/' && b.get(i + 1) == Some(&'/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && b.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The first ```jsonc block after `heading`.
fn block_after(doc: &str, heading: &str) -> String {
    let start = doc.find(heading).unwrap_or_else(|| panic!("{heading} not in PROTOCOL.md"));
    let rest = &doc[start..];
    let open = rest.find("```jsonc").expect("jsonc block") + "```jsonc".len();
    let close = rest[open..].find("```").expect("block end");
    rest[open..open + close].to_string()
}

fn objects(block: &str) -> Vec<Value> {
    serde_json::Deserializer::from_str(&strip_jsonc(block))
        .into_iter::<Value>()
        .map(|v| v.expect("valid JSON after stripping comments"))
        .collect()
}

/// JSON equality where 112 == 112.0.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

#[test]
fn every_daemon_to_app_example_round_trips() {
    let doc = protocol_md();
    let examples = objects(&block_after(&doc, "## Daemon to app"));
    assert!(examples.len() >= 15, "found only {} examples", examples.len());
    for v in examples {
        let ty = v["type"].as_str().unwrap().to_string();
        let msg: OutMsg = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{ty}: {e}\n{v}"));
        let back = serde_json::to_value(&msg).unwrap();
        if ty == "config" {
            // The doc's config is a placeholder; parsing fills the defaults. Check it re-parses.
            let again: OutMsg = serde_json::from_value(back).unwrap();
            assert_eq!(again, msg);
        } else {
            assert!(same(&v, &back), "{ty} changed in a round trip:\n  doc:  {v}\n  ours: {back}");
        }
    }
}

#[test]
fn every_app_to_daemon_example_parses() {
    let doc = protocol_md();
    let examples = objects(&block_after(&doc, "## App to daemon"));
    assert!(examples.len() >= 14, "found only {} examples", examples.len());
    for v in examples {
        let text = v.to_string();
        let msg = parse_in(&text).unwrap_or_else(|e| panic!("{e}: {text}"));
        let back = serde_json::to_value(&msg).unwrap();
        assert!(same(&v, &back), "changed in a round trip:\n  doc:  {v}\n  ours: {back}");
        let again: InMsg = serde_json::from_value(back).unwrap();
        assert_eq!(again, msg);
    }
}

#[test]
fn the_config_example_parses_with_every_field() {
    let doc = protocol_md();
    let v = objects(&block_after(&doc, "## Config file")).remove(0);
    let c: Config = serde_json::from_value(v.clone()).unwrap();
    assert_eq!(c.version, 1);
    assert!(c.zones.is_empty(), "the doc lists zones as a comment");
    let b = &c.bindings[0];
    assert_eq!((b.id.as_str(), b.enabled, b.gesture.as_str(), b.zone.as_deref(), b.app.as_str()), ("b1", true, "double", Some("right-grille"), "*"));
    assert_eq!(b.zones, None);
    assert_eq!(b.action["step"], 6);
    assert_eq!(b.label.as_deref(), Some("Volume up"));
    assert_eq!(c.settings.typing_gate_ms, 450.0);
    assert!(!c.settings.haptics);
    // Serializing gives the same JSON back (zone and zones as explicit nulls, as the Mac writes them).
    assert!(same(&serde_json::to_value(&c).unwrap(), &v));
}

#[test]
fn the_zone_example_parses() {
    let doc = protocol_md();
    let start = doc.find("```json\n").unwrap() + "```json\n".len();
    let end = start + doc[start..].find("```").unwrap();
    let z: ghostkeysd_win::config::Zone = serde_json::from_str(&doc[start..end]).unwrap();
    assert_eq!(z.id, "right-grille");
    assert_eq!(z.rect.w, 0.1);
}

#[test]
fn errors_are_phrased_like_the_mac() {
    assert_eq!(parse_in("not json").unwrap_err(), "invalid JSON");
    assert_eq!(parse_in("[1]").unwrap_err(), "invalid JSON");
    assert_eq!(parse_in(r#"{"x":1}"#).unwrap_err(), "message has no type");
    assert_eq!(parse_in(r#"{"type":"fly"}"#).unwrap_err(), "unknown message type: fly");
}

#[test]
fn windows_hello_keeps_the_mac_shape_plus_optional_keys() {
    let v: Value = serde_json::from_str(
        r#"{"type":"hello","version":"0.1.0","device":{"model":"Surface Pro","chip":"x86_64","family":"other"},
            "sensors":{"imu":true,"gyro":true,"lid":false,"light":true,"inclinometer":true,"sound":true,"camera":true},
            "permissions":{"accessibility":true}}"#,
    )
    .unwrap();
    let m: OutMsg = serde_json::from_value(v.clone()).unwrap();
    assert!(same(&serde_json::to_value(&m).unwrap(), &v));
}
