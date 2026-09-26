//! Authentication, approval of powerful actions, and action rate limits. Ports of the Swift
//! daemon's SessionToken.swift, ApprovalStore.swift and ActionLimiter.swift (PROTOCOL.md
//! "Authentication").
//!
//! File permissions: the Mac writes `token` and `approved.json` with mode 0600. On Windows both live
//! in `%APPDATA%\Ghostkeys\`, which inherits the user profile's ACL (the user, SYSTEM and
//! Administrators only), the Windows equivalent of a 0600 file in the home folder.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use crate::log;

// ---------------------------------------------------------------- session token

/// Per-launch secret for the WebSocket handshake (`X-Ghostkeys-Token`).
pub struct SessionToken {
    file_token: String,
    env_token: Option<String>,
    pub path: PathBuf,
}

pub const TOKEN_HEADER: &str = "x-ghostkeys-token";

impl SessionToken {
    /// 32 random bytes, hex encoded, written to `<dir>/token` (replacing the previous one).
    /// `env` is the parent's GHOSTKEYS_TOKEN, accepted too when at least 32 characters long.
    pub fn create(dir: &Path, env: Option<String>) -> io::Result<SessionToken> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|e| io::Error::other(format!("could not generate a session token: {e}")))?;
        let file_token = hex(&bytes);
        let env = env.map(|s| s.trim().to_string());
        let env_token = env.clone().filter(|s| s.chars().count() >= 32);
        if env.is_some() && env_token.is_none() {
            log::error("ignoring GHOSTKEYS_TOKEN: shorter than 32 characters");
        }
        let path = dir.join("token");
        fs::create_dir_all(dir)?;
        let _ = fs::remove_file(&path);
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path)?;
        f.write_all(format!("{file_token}\n").as_bytes())?;
        Ok(SessionToken { file_token, env_token, path })
    }

    /// A token that only accepts `token` (tests).
    pub fn fixed(token: &str) -> SessionToken {
        SessionToken { file_token: token.to_string(), env_token: None, path: PathBuf::new() }
    }

    pub fn file_token(&self) -> &str {
        &self.file_token
    }

    /// Constant-time comparison against both accepted tokens.
    pub fn accepts(&self, candidate: Option<&str>) -> bool {
        let Some(c) = candidate.map(str::trim).filter(|c| !c.is_empty()) else { return false };
        let mut ok = constant_time_eq(c, &self.file_token);
        if let Some(e) = &self.env_token {
            ok |= constant_time_eq(c, e);
        }
        ok
    }
}

pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (x, y) = (a.as_bytes(), b.as_bytes());
    let mut diff: u8 = if x.len() == y.len() { 0 } else { 1 };
    for i in 0..x.len().max(y.len()) {
        diff |= x.get(i).copied().unwrap_or(0) ^ y.get(i).copied().unwrap_or(0);
    }
    diff == 0
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------- approvals

/// `shell` and `open` (plus the Mac-only `applescript` and `shortcut`) run only if the action
/// carries `approvedHash`, the hash matches the action, and the hash is in approved.json.
pub struct ApprovalStore {
    pub path: PathBuf,
    hashes: Mutex<BTreeSet<String>>,
}

pub const GATED_KINDS: [&str; 4] = ["shell", "applescript", "shortcut", "open"];
/// Fields that do not change what an action does and are left out of the hash.
pub const UNHASHED_FIELDS: [&str; 3] = ["approvedHash", "label", "delayMs"];
pub const MAX_APPROVALS: usize = 1000;

impl ApprovalStore {
    pub fn load(dir: &Path) -> ApprovalStore {
        let path = dir.join("approved.json");
        let hashes = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v.get("hashes").and_then(Value::as_array).cloned())
            .map(|a| a.iter().filter_map(Value::as_str).filter(|h| h.len() == 64).map(String::from).collect())
            .unwrap_or_default();
        ApprovalStore { path, hashes: Mutex::new(hashes) }
    }

    /// Canonical form: the action object without `approvedHash`, `label` and `delayMs`, keys
    /// sorted, no whitespace, slashes not escaped (serde_json's compact output with its sorted map
    /// is exactly that).
    pub fn canonical_json(action: &Value) -> Option<String> {
        let mut o: Map<String, Value> = action.as_object()?.clone();
        for f in UNHASHED_FIELDS {
            o.remove(f);
        }
        serde_json::to_string(&sort_keys(&Value::Object(o))).ok()
    }

    pub fn hash(action: &Value) -> Option<String> {
        let c = Self::canonical_json(action)?;
        Some(hex(&Sha256::digest(c.as_bytes())))
    }

    pub fn needs_approval(action: &Value) -> bool {
        GATED_KINDS.contains(&action.get("kind").and_then(Value::as_str).unwrap_or(""))
    }

    /// Ok if the action may run, otherwise the reason it may not.
    pub fn check(&self, action: &Value) -> Result<(), String> {
        if !Self::needs_approval(action) {
            return Ok(());
        }
        let Some(claimed) = action.get("approvedHash").and_then(Value::as_str) else {
            return Err("not approved: this action needs approval in the app first".into());
        };
        let actual = Self::hash(action).unwrap_or_default();
        if !constant_time_eq(claimed, &actual) {
            return Err("not approved: the action changed since it was approved".into());
        }
        if self.hashes.lock().unwrap().contains(&actual) {
            Ok(())
        } else {
            Err("not approved: approval was revoked or never given".into())
        }
    }

    pub fn approve(&self, action: &Value) -> Result<String, String> {
        if !Self::needs_approval(action) {
            return Err("only shell, applescript, shortcut and open actions need approval".into());
        }
        let h = Self::hash(action).ok_or("invalid action")?;
        let mut hashes = self.hashes.lock().unwrap();
        if hashes.len() >= MAX_APPROVALS && !hashes.contains(&h) {
            return Err("too many approved actions".into());
        }
        hashes.insert(h.clone());
        self.save(&hashes).map_err(|e| e.to_string())?;
        Ok(h)
    }

    /// Revokes by hash. Returns whether it was present.
    pub fn revoke(&self, hash: &str) -> Result<bool, String> {
        let mut hashes = self.hashes.lock().unwrap();
        let had = hashes.remove(hash);
        if had {
            self.save(&hashes).map_err(|e| e.to_string())?;
        }
        Ok(had)
    }

    fn save(&self, hashes: &BTreeSet<String>) -> io::Result<()> {
        let dir = self.path.parent().ok_or_else(|| io::Error::other("no directory"))?;
        fs::create_dir_all(dir)?;
        let text = serde_json::to_string_pretty(&json!({ "version": 1, "hashes": hashes }))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &self.path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

/// serde_json's default Map is a BTreeMap (sorted); rebuilding guarantees it even if a
/// dependency turns on `preserve_order`.
fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            let mut m = Map::new();
            for k in keys {
                m.insert(k.clone(), sort_keys(&o[k]));
            }
            Value::Object(m)
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

// ---------------------------------------------------------------- rate limits

/// Per binding: a cooldown after each run (300 ms; 1.5 s for cover, cover_hold, lid_nudge, tilt,
/// and the Mac's sound and palm-swipe gestures)
/// and at most one run waiting or in progress. Globally: at most 5 actions per second and 60 per
/// minute; tripping a global limit auto-pauses the daemon.
#[derive(Debug, Default)]
pub struct ActionLimiter {
    last_run: std::collections::HashMap<String, f64>,
    running: BTreeSet<String>,
    recent: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Ok,
    Cooldown,
    Tripped(String),
}

pub const DEFAULT_COOLDOWN: f64 = 0.300;
pub const SLOW_GESTURE_COOLDOWN: f64 = 1.5;
pub const SLOW_GESTURES: [&str; 13] = [
    "cover", "cover_hold", "lid_nudge", "tilt_left", "tilt_right", "rub", "rub_left", "rub_right", "wave_toward", "wave_away", "wave_sweep",
    "palm_swipe_left", "palm_swipe_right",
];
pub const PER_SECOND: usize = 5;
pub const PER_MINUTE: usize = 60;

impl ActionLimiter {
    pub fn admit(&mut self, binding_id: &str, gesture: &str, now: f64) -> Verdict {
        let cooldown = if SLOW_GESTURES.contains(&gesture) { SLOW_GESTURE_COOLDOWN } else { DEFAULT_COOLDOWN };
        if self.running.contains(binding_id) {
            return Verdict::Cooldown;
        }
        if let Some(last) = self.last_run.get(binding_id) {
            if now - last < cooldown {
                return Verdict::Cooldown;
            }
        }
        let g = self.admit_global(now);
        if g != Verdict::Ok {
            return g;
        }
        self.last_run.insert(binding_id.to_string(), now);
        self.running.insert(binding_id.to_string());
        Verdict::Ok
    }

    /// Counts one action against the global limits.
    pub fn admit_global(&mut self, now: f64) -> Verdict {
        self.recent.retain(|t| now - t < 60.0);
        if self.recent.iter().filter(|t| now - **t < 1.0).count() >= PER_SECOND {
            return Verdict::Tripped(format!("more than {PER_SECOND} actions per second"));
        }
        if self.recent.len() >= PER_MINUTE {
            return Verdict::Tripped(format!("more than {PER_MINUTE} actions per minute"));
        }
        self.recent.push(now);
        Verdict::Ok
    }

    pub fn finished(&mut self, binding_id: &str) {
        self.running.remove(binding_id);
    }

    /// On resume: start counting afresh (running bindings stay tracked until they finish).
    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ghostkeys-sec-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn token_is_fresh_hex_and_written() {
        let d = tmp("token");
        let a = SessionToken::create(&d, None).unwrap();
        assert_eq!(a.file_token().len(), 64);
        assert!(a.file_token().chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(fs::read_to_string(&a.path).unwrap().trim(), a.file_token());
        let b = SessionToken::create(&d, None).unwrap();
        assert_ne!(a.file_token(), b.file_token(), "a new token every launch");
        assert!(b.accepts(Some(b.file_token())));
        assert!(!b.accepts(Some(a.file_token())));
        assert!(!b.accepts(None));
        assert!(!b.accepts(Some("")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&b.path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn env_token_needs_32_characters() {
        let d = tmp("env");
        let long = "x".repeat(40);
        let t = SessionToken::create(&d, Some(long.clone())).unwrap();
        assert!(t.accepts(Some(&long)));
        let t = SessionToken::create(&d, Some("short".into())).unwrap();
        assert!(!t.accepts(Some("short")));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn canonical_json_ignores_label_and_order() {
        let a = json!({"kind":"shell","command":"echo hi","label":"Hi","approvedHash":"x","delayMs":5});
        let b = json!({"command":"echo hi","kind":"shell"});
        assert_eq!(ApprovalStore::canonical_json(&a).unwrap(), r#"{"command":"echo hi","kind":"shell"}"#);
        assert_eq!(ApprovalStore::hash(&a), ApprovalStore::hash(&b));
        assert_ne!(ApprovalStore::hash(&b), ApprovalStore::hash(&json!({"kind":"shell","command":"echo ho"})));
        // Slashes stay unescaped (the Mac uses .withoutEscapingSlashes).
        assert_eq!(ApprovalStore::canonical_json(&json!({"kind":"open","target":"https://a/b"})).unwrap(), r#"{"kind":"open","target":"https://a/b"}"#);
        // Known vector: SHA-256 of {"command":"echo hi","kind":"shell"}.
        assert_eq!(ApprovalStore::hash(&b).unwrap(), hex(&Sha256::digest(br#"{"command":"echo hi","kind":"shell"}"#)));
    }

    #[test]
    fn approval_lifecycle() {
        let d = tmp("approve");
        let store = ApprovalStore::load(&d);
        let action = json!({"kind":"shell","command":"echo hi"});
        assert!(store.check(&action).unwrap_err().contains("needs approval"));
        assert!(store.check(&json!({"kind":"mute"})).is_ok(), "ungated kinds need nothing");
        assert!(store.approve(&json!({"kind":"mute"})).is_err());

        let h = store.approve(&action).unwrap();
        let mut stamped = action.clone();
        stamped["approvedHash"] = json!(h);
        stamped["label"] = json!("renamed later");
        assert!(store.check(&stamped).is_ok());

        let mut edited = stamped.clone();
        edited["command"] = json!("echo pwned");
        assert!(store.check(&edited).unwrap_err().contains("changed"));

        // Survives a restart.
        let again = ApprovalStore::load(&d);
        assert!(again.check(&stamped).is_ok());
        assert_eq!(again.revoke(&h), Ok(true));
        assert_eq!(again.revoke(&h), Ok(false));
        assert!(again.check(&stamped).unwrap_err().contains("revoked"));
        assert!(ApprovalStore::load(&d).check(&stamped).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn limiter_cooldowns_and_global_trip() {
        let mut l = ActionLimiter::default();
        assert_eq!(l.admit("b1", "double", 0.0), Verdict::Ok);
        assert_eq!(l.admit("b1", "double", 0.5), Verdict::Cooldown, "still running");
        l.finished("b1");
        assert_eq!(l.admit("b1", "double", 0.2), Verdict::Cooldown, "300 ms cooldown");
        assert_eq!(l.admit("b1", "double", 0.4), Verdict::Ok);
        l.finished("b1");
        assert_eq!(l.admit("c", "cover", 1.0), Verdict::Ok);
        l.finished("c");
        assert_eq!(l.admit("c", "cover", 2.0), Verdict::Cooldown, "1.5 s for slow gestures");

        let mut g = ActionLimiter::default();
        for i in 0..5 {
            assert_eq!(g.admit_global(10.0 + i as f64 * 0.01), Verdict::Ok);
        }
        assert!(matches!(g.admit_global(10.1), Verdict::Tripped(_)));
        g.reset();
        assert_eq!(g.admit_global(10.2), Verdict::Ok);
    }
}
