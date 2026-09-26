//! Key names from the protocol (`"v"`, `"f4"`, `"left"`, ...) to Windows virtual-key codes, and
//! modifier names to modifier keys. Same key names as daemon/Sources/ghostkeysd/Actions/KeyCodes.swift.
//!
//! Modifier mapping (a config shared with a Mac should do the same thing on Windows):
//!   shift -> Shift, control/ctrl -> Ctrl, option/alt -> Alt,
//!   command/cmd -> Ctrl (Cmd+C on a Mac is Ctrl+C on Windows),
//!   win/meta/super/windows -> the Windows key, fn -> ignored (not visible to software).

pub const VK_BACK: u16 = 0x08;
pub const VK_TAB: u16 = 0x09;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_ESCAPE: u16 = 0x1B;
pub const VK_SPACE: u16 = 0x20;
pub const VK_PRIOR: u16 = 0x21;
pub const VK_NEXT: u16 = 0x22;
pub const VK_END: u16 = 0x23;
pub const VK_HOME: u16 = 0x24;
pub const VK_LEFT: u16 = 0x25;
pub const VK_UP: u16 = 0x26;
pub const VK_RIGHT: u16 = 0x27;
pub const VK_DOWN: u16 = 0x28;
pub const VK_SNAPSHOT: u16 = 0x2C;
pub const VK_INSERT: u16 = 0x2D;
pub const VK_DELETE: u16 = 0x2E;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_F1: u16 = 0x70;
pub const VK_VOLUME_MUTE: u16 = 0xAD;
pub const VK_VOLUME_DOWN: u16 = 0xAE;
pub const VK_VOLUME_UP: u16 = 0xAF;
pub const VK_MEDIA_NEXT_TRACK: u16 = 0xB0;
pub const VK_MEDIA_PREV_TRACK: u16 = 0xB1;
pub const VK_MEDIA_PLAY_PAUSE: u16 = 0xB3;

/// Virtual-key code for a key name, case-insensitive.
pub fn vk_for(key: &str) -> Option<u16> {
    let k = key.to_lowercase();
    let b = k.as_bytes();
    if b.len() == 1 {
        let c = b[0];
        if c.is_ascii_lowercase() {
            return Some((c - b'a' + 0x41) as u16);
        }
        if c.is_ascii_digit() {
            return Some((c - b'0' + 0x30) as u16);
        }
    }
    if let Some(n) = k.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()) {
        if (1..=24).contains(&n) {
            return Some(VK_F1 + n - 1);
        }
    }
    Some(match k.as_str() {
        // US layout OEM keys.
        ";" | "semicolon" => 0xBA,
        "=" | "equal" => 0xBB,
        "," | "comma" => 0xBC,
        "-" | "minus" => 0xBD,
        "." | "period" => 0xBE,
        "/" | "slash" => 0xBF,
        "`" | "grave" => 0xC0,
        "[" | "leftbracket" => 0xDB,
        "\\" | "backslash" => 0xDC,
        "]" | "rightbracket" => 0xDD,
        "'" | "quote" => 0xDE,
        "return" | "enter" => VK_RETURN,
        "tab" => VK_TAB,
        "space" => VK_SPACE,
        // "delete" is the Mac's backspace key; "forwarddelete" is Windows' Delete.
        "delete" | "backspace" => VK_BACK,
        "forwarddelete" => VK_DELETE,
        "escape" | "esc" => VK_ESCAPE,
        "home" => VK_HOME,
        "end" => VK_END,
        "pageup" => VK_PRIOR,
        "pagedown" => VK_NEXT,
        "insert" => VK_INSERT,
        "printscreen" => VK_SNAPSHOT,
        "left" | "arrowleft" => VK_LEFT,
        "right" | "arrowright" => VK_RIGHT,
        "up" | "arrowup" => VK_UP,
        "down" | "arrowdown" => VK_DOWN,
        _ => return None,
    })
}

/// Keys that need KEYEVENTF_EXTENDEDKEY in SendInput (arrows and the navigation cluster),
/// otherwise some apps see the numeric keypad versions.
pub fn is_extended(vk: u16) -> bool {
    matches!(vk, VK_PRIOR | VK_NEXT | VK_END | VK_HOME | VK_LEFT | VK_UP | VK_RIGHT | VK_DOWN | VK_INSERT | VK_DELETE | VK_LWIN)
        || (0xA6..=0xB7).contains(&vk) // browser, volume and media keys
}

/// Modifier names to virtual keys, deduplicated, in press order. Unknown names are an error.
pub fn modifier_vks(modifiers: &[String]) -> Result<Vec<u16>, String> {
    let mut out: Vec<u16> = Vec::new();
    for m in modifiers {
        let vk = match m.to_lowercase().as_str() {
            "shift" => Some(VK_SHIFT),
            "control" | "ctrl" | "command" | "cmd" => Some(VK_CONTROL),
            "option" | "alt" => Some(VK_MENU),
            "win" | "windows" | "meta" | "super" => Some(VK_LWIN),
            "fn" => None,
            other => return Err(format!("unknown modifier: {other}")),
        };
        if let Some(vk) = vk {
            if !out.contains(&vk) {
                out.push(vk);
            }
        }
    }
    Ok(out)
}

/// One key press as (vk, key_up) events: modifiers down, key down, key up, modifiers up (reverse).
pub fn chord_events(vk: u16, modifiers: &[u16]) -> Vec<(u16, bool)> {
    let mut v: Vec<(u16, bool)> = modifiers.iter().map(|&m| (m, false)).collect();
    v.push((vk, false));
    v.push((vk, true));
    v.extend(modifiers.iter().rev().map(|&m| (m, true)));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_digits_and_function_keys() {
        assert_eq!(vk_for("v"), Some(0x56));
        assert_eq!(vk_for("V"), Some(0x56));
        assert_eq!(vk_for("0"), Some(0x30));
        assert_eq!(vk_for("f4"), Some(0x73));
        assert_eq!(vk_for("F24"), Some(0x87));
        assert_eq!(vk_for("f25"), None);
        assert_eq!(vk_for("left"), Some(VK_LEFT));
        assert_eq!(vk_for("delete"), Some(VK_BACK));
        assert_eq!(vk_for("forwarddelete"), Some(VK_DELETE));
        assert_eq!(vk_for("nonsense"), None);
    }

    #[test]
    fn every_mac_key_name_maps() {
        let mac = [
            "a", "z", "1", "=", "-", "]", "[", "'", ";", "\\", ",", "/", ".", "`", "equal", "minus", "rightbracket",
            "leftbracket", "quote", "semicolon", "backslash", "comma", "slash", "period", "grave", "return", "enter",
            "tab", "space", "delete", "backspace", "escape", "esc", "forwarddelete", "home", "end", "pageup",
            "pagedown", "left", "right", "down", "up", "f1", "f20", "arrowleft", "arrowright", "arrowdown", "arrowup",
        ];
        for k in mac {
            assert!(vk_for(k).is_some(), "{k}");
        }
    }

    #[test]
    fn modifiers_map_mac_names_to_windows_keys() {
        let m = |v: &[&str]| modifier_vks(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(m(&["command", "shift"]).unwrap(), vec![VK_CONTROL, VK_SHIFT]);
        assert_eq!(m(&["cmd", "control"]).unwrap(), vec![VK_CONTROL]);
        assert_eq!(m(&["option", "fn", "win"]).unwrap(), vec![VK_MENU, VK_LWIN]);
        assert!(m(&["hyper"]).is_err());
    }

    #[test]
    fn chord_order_is_press_then_release_reversed() {
        assert_eq!(
            chord_events(0x56, &[VK_CONTROL, VK_SHIFT]),
            vec![(VK_CONTROL, false), (VK_SHIFT, false), (0x56, false), (0x56, true), (VK_SHIFT, true), (VK_CONTROL, true)]
        );
        assert!(is_extended(VK_LEFT) && is_extended(VK_MEDIA_PLAY_PAUSE) && !is_extended(0x56));
    }
}
