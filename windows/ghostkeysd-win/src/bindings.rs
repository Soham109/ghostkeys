//! Which binding fires for a gesture. Port of BindingResolver.swift, plus app-id matching that
//! understands Windows exe names.

use std::collections::BTreeSet;

use crate::config::Binding;
use crate::detection::GestureEvent;

/// Gestures that are not tied to a tap zone.
pub const ZONELESS_GESTURES: [&str; 11] =
    ["lid_nudge", "cover", "cover_hold", "tilt_left", "tilt_right", "rub", "rub_left", "rub_right", "wave_toward", "wave_away", "wave_sweep"];

/// Mac bundle ids that a config shared with a Mac may carry, and the Windows exe they mean.
const BUNDLE_TO_EXE: [(&str, &str); 12] = [
    ("com.microsoft.excel", "excel.exe"),
    ("com.microsoft.word", "winword.exe"),
    ("com.microsoft.powerpoint", "powerpnt.exe"),
    ("com.microsoft.outlook", "outlook.exe"),
    ("com.google.chrome", "chrome.exe"),
    ("com.microsoft.edgemac", "msedge.exe"),
    ("org.mozilla.firefox", "firefox.exe"),
    ("com.spotify.client", "spotify.exe"),
    ("us.zoom.xos", "zoom.exe"),
    ("com.microsoft.vscode", "code.exe"),
    ("com.tinyspeck.slackmacgap", "slack.exe"),
    ("company.thebrowser.browser", "arc.exe"),
];

/// Does a binding's `app` match the foreground app? `app` is the lowercased exe name on Windows.
/// Accepts the exe with or without `.exe`, any case, or a known Mac bundle id.
pub fn app_matches(binding_app: &str, foreground: Option<&str>) -> bool {
    if binding_app == "*" {
        return true;
    }
    let Some(fg) = foreground else { return false };
    let fg = fg.to_ascii_lowercase();
    let want = binding_app.to_ascii_lowercase();
    if want == fg || format!("{want}.exe") == fg {
        return true;
    }
    BUNDLE_TO_EXE.iter().any(|(bundle, exe)| *bundle == want && *exe == fg)
}

/// The enabled binding for this gesture: same gesture, same zone (both zones in order for
/// `sequence`), exactly the same set of held modifiers, and an app that matches. A binding for the
/// foreground app wins over "*".
pub fn resolve<'a>(g: &GestureEvent, bindings: &'a [Binding], app: Option<&str>) -> Option<&'a Binding> {
    let held: BTreeSet<String> = g.modifiers.iter().map(|m| m.to_lowercase()).collect();
    let matches: Vec<&Binding> = bindings
        .iter()
        .filter(|b| {
            if !b.enabled || b.gesture != g.gesture {
                return false;
            }
            let want: BTreeSet<String> = b.modifiers.iter().map(|m| m.to_lowercase()).collect();
            if want != held {
                return false;
            }
            if !app_matches(&b.app, app) {
                return false;
            }
            if g.gesture == "sequence" {
                return b.zones.clone().unwrap_or_default() == g.zones;
            }
            if ZONELESS_GESTURES.contains(&g.gesture.as_str()) {
                return b.zone.is_none() || g.zone.is_none() || b.zone == g.zone;
            }
            b.zone.is_some() && b.zone == g.zone
        })
        .collect();
    matches.iter().find(|b| b.app != "*").or(matches.first()).copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    fn b(id: &str, gesture: &str, zone: Option<&str>, app: &str, mods: &[&str]) -> Binding {
        Binding {
            id: id.into(),
            enabled: true,
            gesture: gesture.into(),
            zone: zone.map(String::from),
            zones: None,
            modifiers: mods.iter().map(|s| s.to_string()).collect(),
            app: app.into(),
            action: json!({"kind": "mute"}),
            label: None,
            extra: Map::new(),
        }
    }

    fn g(gesture: &str, zone: Option<&str>, mods: &[&str]) -> GestureEvent {
        GestureEvent {
            t: 0.0,
            gesture: gesture.into(),
            zone: zone.map(String::from),
            zones: zone.map(|z| vec![z.to_string()]).unwrap_or_default(),
            modifiers: mods.iter().map(|s| s.to_string()).collect(),
            confidence: 1.0,
        }
    }

    #[test]
    fn app_specific_wins_over_star() {
        let bs = vec![b("any", "double", Some("anywhere"), "*", &[]), b("xl", "double", Some("anywhere"), "excel.exe", &[])];
        assert_eq!(resolve(&g("double", Some("anywhere"), &[]), &bs, Some("excel.exe")).unwrap().id, "xl");
        assert_eq!(resolve(&g("double", Some("anywhere"), &[]), &bs, Some("notepad.exe")).unwrap().id, "any");
    }

    #[test]
    fn mac_bundle_id_matches_windows_exe() {
        let bs = vec![b("xl", "double", Some("anywhere"), "com.microsoft.Excel", &[])];
        assert!(resolve(&g("double", Some("anywhere"), &[]), &bs, Some("EXCEL.EXE")).is_some());
        assert!(app_matches("excel", Some("excel.exe")));
        assert!(!app_matches("excel.exe", None));
    }

    #[test]
    fn modifiers_must_match_exactly() {
        let bs = vec![b("s", "tap", Some("anywhere"), "*", &["Shift"])];
        assert!(resolve(&g("tap", Some("anywhere"), &[]), &bs, None).is_none());
        assert!(resolve(&g("tap", Some("anywhere"), &["shift"]), &bs, None).is_some());
        assert!(resolve(&g("tap", Some("anywhere"), &["shift", "control"]), &bs, None).is_none());
    }

    #[test]
    fn zoneless_gestures_ignore_zone() {
        let bs = vec![b("c", "cover", None, "*", &[])];
        assert!(resolve(&g("cover", None, &[]), &bs, None).is_some());
        let bs = vec![b("t", "tilt_left", Some("lid"), "*", &[])];
        assert!(resolve(&g("tilt_left", None, &[]), &bs, None).is_some());
    }

    #[test]
    fn disabled_and_wrong_zone_do_not_fire() {
        let mut off = b("off", "tap", Some("anywhere"), "*", &[]);
        off.enabled = false;
        let bs = vec![off, b("other", "tap", Some("left-palm"), "*", &[])];
        assert!(resolve(&g("tap", Some("anywhere"), &[]), &bs, None).is_none());
    }

    #[test]
    fn sequence_needs_both_zones_in_order() {
        let mut s = b("seq", "sequence", None, "*", &[]);
        s.zones = Some(vec!["a".into(), "b".into()]);
        let bs = vec![s];
        let mut ev = g("sequence", None, &[]);
        ev.zones = vec!["a".into(), "b".into()];
        assert!(resolve(&ev, &bs, None).is_some());
        ev.zones = vec!["b".into(), "a".into()];
        assert!(resolve(&ev, &bs, None).is_none());
    }
}
