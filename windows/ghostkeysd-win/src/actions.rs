//! Runs binding actions (PROTOCOL.md "Action kinds") on one background thread, like the Mac's
//! serial action queue. Validation, the shell refusals, macros and pause handling live here once;
//! the platform's `ActionRunner` only performs primitives.
//!
//! Callers must only run actions for a detected gesture or an explicit `test_action`, never while
//! paused; the executor re-checks the paused flag before every step as a second line of defence.
//!
//! Order of checks for every action and every macro step, as on the Mac: paused, field
//! validation (which includes the shell refusals), approval (`shell` and `open` need an
//! `approvedHash` the user granted), then dry run or the real thing.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::excel;
use crate::keys;
use crate::log;
use crate::platform::ActionRunner;
use crate::safety;
use crate::security::ApprovalStore;
use crate::window_math::WINDOW_OPS;

pub const MAX_MACRO_STEPS: usize = 50;
pub const MAX_MACRO_SECONDS: f64 = 30.0;
pub const SHELL_TIMEOUT: Duration = Duration::from_secs(10);
pub const MAX_TEXT: usize = 5000;
/// At most this many actions waiting or running; more are refused as "busy".
pub const MAX_PENDING: usize = 8;

/// What every action run needs besides the action itself.
pub struct RunContext {
    pub paused: Arc<AtomicBool>,
    pub dry_run: bool,
    pub approvals: Arc<ApprovalStore>,
}

pub const APP_OPS: [&str; 4] = ["hide", "quit", "switch-next", "switch-previous"];
/// `dnd-toggle` has no public Windows API (Focus assist / Do not disturb), so it is not offered.
pub const SYSTEM_OPS: [&str; 7] = ["lock", "sleep-display", "screenshot", "screenshot-area", "mission-control", "launchpad", "show-desktop"];

/// Numbers may arrive as JSON numbers or numeric strings (as the Mac accepts).
fn num(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn string<'a>(a: &'a Value, key: &str) -> Option<&'a str> {
    a.get(key).and_then(Value::as_str)
}

fn strings(a: &Value, key: &str) -> Vec<String> {
    a.get(key)
        .and_then(Value::as_array)
        .map(|v| v.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

/// Checks fields before anything runs, so a dry run reports the same errors a real run would.
pub fn validate(a: &Value) -> Result<(), String> {
    let kind = string(a, "kind").ok_or("action has no kind")?;
    match kind {
        "keystroke" => {
            let key = string(a, "key").unwrap_or("none");
            keys::vk_for(key).ok_or_else(|| format!("unknown key: {key}"))?;
            keys::modifier_vks(&strings(a, "modifiers"))?;
        }
        "volume" | "brightness" => {
            let step = num(a.get("step")).filter(|s| s.is_finite());
            step.ok_or_else(|| format!("{kind} needs a numeric step"))?;
        }
        "mute" => {}
        "media" => {
            if !["playpause", "next", "previous"].contains(&string(a, "command").unwrap_or("")) {
                return Err("unknown media command".into());
            }
        }
        "open" => {
            if string(a, "target").map(str::is_empty).unwrap_or(true) {
                return Err("open needs a target".into());
            }
        }
        "shell" => {
            let c = string(a, "command").filter(|c| !c.is_empty()).ok_or("shell needs a command")?;
            safety::check_shell(c)?;
        }
        "text" | "clipboard" => {
            let t = string(a, "text").ok_or_else(|| format!("{kind} needs text"))?;
            if t.chars().count() > MAX_TEXT {
                return Err(format!("text is too long (max {MAX_TEXT} characters)"));
            }
        }
        "window" => {
            if !WINDOW_OPS.contains(&string(a, "op").unwrap_or("")) {
                return Err("unknown window op".into());
            }
        }
        "app" => {
            if !APP_OPS.contains(&string(a, "op").unwrap_or("")) {
                return Err("unknown app op".into());
            }
        }
        "system" => {
            let op = string(a, "op").unwrap_or("");
            if op == "dnd-toggle" {
                return Err("unsupported on Windows: Do Not Disturb has no public API".into());
            }
            if !SYSTEM_OPS.contains(&op) {
                return Err("unknown system op".into());
            }
        }
        "integration" => {
            let app = string(a, "app").unwrap_or("");
            let cmd = string(a, "command").unwrap_or("");
            if app == "excel" && excel::NOT_YET.contains(&cmd) {
                return Err(format!("unsupported: excel/{cmd} is not available on Windows yet"));
            }
            if app != "excel" || !excel::COMMANDS.contains(&cmd) {
                return Err(format!("unknown integration: {app}/{cmd} (Windows supports excel only for now)"));
            }
            if cmd == "run-macro" && a.get("args").and_then(|x| string(x, "macro")).map(str::is_empty).unwrap_or(true) {
                return Err("run-macro needs args.macro".into());
            }
        }
        "applescript" => return Err("unsupported on Windows: AppleScript is macOS only".into()),
        "shortcut" => return Err("unsupported on Windows: Shortcuts are macOS only".into()),
        "macro" => {}
        other => return Err(format!("unknown action kind: {other}")),
    }
    Ok(())
}

/// Runs one action, synchronously, on the calling thread.
pub fn perform(runner: &dyn ActionRunner, a: &Value, ctx: &RunContext) -> Result<(), String> {
    perform_inner(runner, a, ctx, false)
}

fn perform_inner(runner: &dyn ActionRunner, a: &Value, ctx: &RunContext, in_macro: bool) -> Result<(), String> {
    if ctx.paused.load(Ordering::SeqCst) {
        return Err("paused".into());
    }
    let kind = string(a, "kind").ok_or("action has no kind")?;
    if kind == "macro" {
        if in_macro {
            return Err("a macro cannot contain another macro".into());
        }
        return run_macro(runner, a, ctx);
    }
    validate(a)?;
    ctx.approvals.check(a)?;
    if ctx.dry_run {
        log::info(&format!("dry-run: would run {a}"));
        return Ok(());
    }
    log::debug(&format!("running {a}"));
    execute(runner, kind, a)
}

fn execute(r: &dyn ActionRunner, kind: &str, a: &Value) -> Result<(), String> {
    match kind {
        "keystroke" => {
            let vk = keys::vk_for(string(a, "key").unwrap_or("")).ok_or("unknown key")?;
            r.keystroke(vk, &keys::modifier_vks(&strings(a, "modifiers"))?)
        }
        "volume" => r.volume(num(a.get("step")).unwrap_or(0.0)),
        "mute" => r.mute(),
        "media" => r.media(string(a, "command").unwrap_or("")),
        "brightness" => r.brightness(num(a.get("step")).unwrap_or(0.0)),
        "open" => r.open(string(a, "target").unwrap_or("")),
        "shell" => r.shell(string(a, "command").unwrap_or(""), SHELL_TIMEOUT),
        "text" => r.text(string(a, "text").unwrap_or("")),
        "clipboard" => r.clipboard(string(a, "text").unwrap_or("")),
        "window" => r.window(string(a, "op").unwrap_or("")),
        "app" => r.app(string(a, "op").unwrap_or("")),
        "system" => r.system(string(a, "op").unwrap_or("")),
        "integration" => excel_command(r, string(a, "command").unwrap_or(""), a.get("args").unwrap_or(&Value::Null)),
        other => Err(format!("unknown action kind: {other}")),
    }
}

/// The Excel commands, as read-transform-write on the active cell.
pub fn excel_command(r: &dyn ActionRunner, command: &str, args: &Value) -> Result<(), String> {
    match command {
        "wrap-iferror" => {
            let f = r.excel_get("Formula")?;
            let next = excel::toggle_iferror(&f, args.get("fallback").and_then(Value::as_str))?;
            r.excel_set("Formula", &next)
        }
        "unwrap-iferror" => {
            let f = r.excel_get("Formula")?;
            r.excel_set("Formula", &excel::unwrap_iferror(&f)?)
        }
        "toggle-absolute" => {
            let f = r.excel_get("Formula")?;
            r.excel_set("Formula", &excel::toggle_absolute(&f)?)
        }
        "cycle-number-format" => {
            let cur = r.excel_get("NumberFormat")?;
            r.excel_set("NumberFormat", excel::next_number_format(&cur))
        }
        "run-macro" => r.excel_run_macro(args.get("macro").and_then(Value::as_str).unwrap_or("")),
        other => Err(format!("unknown excel command: {other}")),
    }
}

fn run_macro(r: &dyn ActionRunner, a: &Value, ctx: &RunContext) -> Result<(), String> {
    let steps = a.get("steps").and_then(Value::as_array).filter(|s| !s.is_empty()).ok_or("macro has no steps")?;
    if steps.len() > MAX_MACRO_STEPS {
        return Err(format!("macro has more than {MAX_MACRO_STEPS} steps"));
    }
    // Validate everything up front so a bad step 7 does not leave steps 1-6 half applied.
    for (i, step) in steps.iter().enumerate() {
        let kind = string(step, "kind").ok_or_else(|| format!("macro step {} has no kind", i + 1))?;
        if kind == "macro" {
            return Err("a macro cannot contain another macro".into());
        }
        validate(step).map_err(|e| format!("macro step {}: {e}", i + 1))?;
        ctx.approvals.check(step).map_err(|e| format!("macro step {}: {e}", i + 1))?;
    }
    let deadline = Instant::now() + Duration::from_secs_f64(MAX_MACRO_SECONDS);
    for (i, step) in steps.iter().enumerate() {
        let delay = (num(step.get("delayMs")).unwrap_or(0.0) / 1000.0).max(0.0);
        if delay > 0.0 {
            if Instant::now() + Duration::from_secs_f64(delay.min(MAX_MACRO_SECONDS + 1.0)) >= deadline {
                return Err(format!("macro exceeded {} s", MAX_MACRO_SECONDS as u64));
            }
            thread::sleep(Duration::from_secs_f64(delay));
        }
        if Instant::now() >= deadline {
            return Err(format!("macro exceeded {} s", MAX_MACRO_SECONDS as u64));
        }
        perform_inner(r, step, ctx, true).map_err(|e| format!("macro step {}: {e}", i + 1))?;
    }
    Ok(())
}

type Done = Box<dyn FnOnce(Result<(), String>) + Send>;

struct Job {
    action: Value,
    enqueued: Instant,
    max_age: Option<Duration>,
    done: Done,
}

/// One background thread that runs actions in order.
pub struct ActionExecutor {
    tx: mpsc::Sender<Job>,
    pending: Arc<AtomicUsize>,
}

impl ActionExecutor {
    pub fn new(runner: Arc<dyn ActionRunner>, ctx: RunContext) -> Self {
        let (tx, rx) = mpsc::channel::<Job>();
        let pending = Arc::new(AtomicUsize::new(0));
        let p = pending.clone();
        thread::Builder::new()
            .name("ghostkeys-actions".into())
            .spawn(move || {
                for job in rx {
                    let result = match job.max_age {
                        Some(age) if job.enqueued.elapsed() > age => Err("dropped: waited too long behind another action".into()),
                        _ => perform(runner.as_ref(), &job.action, &ctx),
                    };
                    p.fetch_sub(1, Ordering::SeqCst);
                    (job.done)(result);
                }
            })
            .expect("spawn action thread");
        ActionExecutor { tx, pending }
    }

    /// Queues an action. `max_age`: drop it if it waited longer than this before starting (a stale
    /// gesture). `done` runs on the action thread.
    pub fn run(&self, action: Value, max_age: Option<Duration>, done: impl FnOnce(Result<(), String>) + Send + 'static) {
        if self.pending.fetch_add(1, Ordering::SeqCst) >= MAX_PENDING {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            done(Err("busy: too many actions waiting".into()));
            return;
        }
        let job = Job { action, enqueued: Instant::now(), max_age, done: Box::new(done) };
        if let Err(mpsc::SendError(job)) = self.tx.send(job) {
            self.pending.fetch_sub(1, Ordering::SeqCst);
            (job.done)(Err("action thread is gone".into()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::mock::MockActions;
    use serde_json::json;

    fn ctx(paused: bool, dry_run: bool) -> RunContext {
        let dir = std::env::temp_dir().join(format!("ghostkeys-actions-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::SeqCst)));
        RunContext { paused: Arc::new(AtomicBool::new(paused)), dry_run, approvals: Arc::new(ApprovalStore::load(&dir)) }
    }
    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// Approves gated actions first (as the app would after the native confirmation).
    fn approved(c: &RunContext, mut a: Value) -> Value {
        if ApprovalStore::needs_approval(&a) {
            let h = c.approvals.approve(&a).unwrap();
            a["approvedHash"] = json!(h);
        }
        a
    }

    fn run(a: Value) -> (Result<(), String>, Vec<String>) {
        let m = MockActions::default();
        let c = ctx(false, false);
        let a = approved(&c, a);
        let r = perform(&m, &a, &c);
        (r, m.take_calls())
    }

    #[test]
    fn each_kind_reaches_its_primitive() {
        assert_eq!(run(json!({"kind":"keystroke","key":"v","modifiers":["command"]})).1, ["keystroke 0x56 [17]"]);
        assert_eq!(run(json!({"kind":"volume","step":6})).1, ["volume 6"]);
        assert_eq!(run(json!({"kind":"volume","step":"-6"})).1, ["volume -6"]);
        assert_eq!(run(json!({"kind":"mute"})).1, ["mute"]);
        assert_eq!(run(json!({"kind":"media","command":"next"})).1, ["media next"]);
        assert_eq!(run(json!({"kind":"brightness","step":-10})).1, ["brightness -10"]);
        assert_eq!(run(json!({"kind":"open","target":"https://example.com"})).1, ["open https://example.com"]);
        assert_eq!(run(json!({"kind":"shell","command":"echo hi"})).1, ["shell echo hi (10s)"]);
        assert_eq!(run(json!({"kind":"window","op":"left"})).1, ["window left"]);
        assert_eq!(run(json!({"kind":"system","op":"lock"})).1, ["system lock"]);
        assert_eq!(run(json!({"kind":"text","text":"héllo"})).1, ["text héllo"]);
    }

    #[test]
    fn refusals_and_unsupported_kinds_never_reach_the_os() {
        for a in [
            json!({"kind":"shell","command":"runas /user:admin cmd"}),
            json!({"kind":"shell","command":"rm -rf C:\\"}),
            json!({"kind":"shell","command":"echo hi","approvedHash":"0000"}),
            json!({"kind":"open","target":"calc"}),
            json!({"kind":"shell","command":""}),
            json!({"kind":"applescript","source":"beep"}),
            json!({"kind":"shortcut","name":"x"}),
            json!({"kind":"system","op":"dnd-toggle"}),
            json!({"kind":"keystroke","key":"nope"}),
            json!({"kind":"volume"}),
            json!({"kind":"integration","app":"safari","command":"x"}),
            json!({"kind":"teleport"}),
            json!({"nokind":true}),
        ] {
            let m = MockActions::default();
            let r = perform(&m, &a, &ctx(false, false));
            let calls = m.take_calls();
            assert!(r.is_err(), "{a}");
            assert!(calls.is_empty(), "{a}");
        }
    }

    #[test]
    fn paused_blocks_everything() {
        let m = MockActions::default();
        let r = perform(&m, &json!({"kind":"mute"}), &ctx(true, false));
        assert_eq!(r, Err("paused".into()));
        assert!(m.take_calls().is_empty());
    }

    #[test]
    fn dry_run_validates_but_does_not_run() {
        let m = MockActions::default();
        let c = ctx(false, true);
        assert!(perform(&m, &json!({"kind":"mute"}), &c).is_ok());
        let sudo = approved(&c, json!({"kind":"shell","command":"sudo x"}));
        assert!(perform(&m, &sudo, &c).is_err(), "refused even when approved");
        assert!(m.take_calls().is_empty());
    }

    #[test]
    fn macro_validates_all_steps_first() {
        let (r, calls) = run(json!({"kind":"macro","steps":[{"kind":"mute"},{"kind":"shell","command":"reg delete HKCU\\x"}]}));
        assert!(r.unwrap_err().starts_with("macro step 2"));
        assert!(calls.is_empty());
        // An unapproved shell step stops the macro before step 1 runs.
        let (r, calls) = run(json!({"kind":"macro","steps":[{"kind":"mute"},{"kind":"shell","command":"echo hi"}]}));
        assert!(r.unwrap_err().contains("not approved"));
        assert!(calls.is_empty());
        let m = MockActions::default();
        let c = ctx(false, false);
        let step = approved(&c, json!({"kind":"shell","command":"echo hi"}));
        assert!(perform(&m, &json!({"kind":"macro","steps":[{"kind":"mute"}, step]}), &c).is_ok());
        assert_eq!(m.take_calls(), ["mute", "shell echo hi (10s)"]);
        let (r, calls) = run(json!({"kind":"macro","steps":[{"kind":"mute"},{"kind":"media","command":"next","delayMs":5}]}));
        assert!(r.is_ok());
        assert_eq!(calls, ["mute", "media next"]);
        assert!(run(json!({"kind":"macro","steps":[{"kind":"macro","steps":[]}]})).0.is_err());
        assert!(run(json!({"kind":"macro","steps":[]})).0.is_err());
        let many: Vec<Value> = (0..51).map(|_| json!({"kind":"mute"})).collect();
        assert!(run(json!({"kind":"macro","steps":many})).0.is_err());
        assert!(run(json!({"kind":"macro","steps":[{"kind":"mute","delayMs":31000}]})).0.is_err());
    }

    #[test]
    fn excel_commands_transform_the_active_cell() {
        let m = MockActions::default();
        *m.excel_cell.lock().unwrap() = Some(("=A1/B1".into(), "General".into()));
        let c = ctx(false, false);
        let go = |cmd: &str| perform(&m, &json!({"kind":"integration","app":"excel","command":cmd,"args":{}}), &c);
        go("wrap-iferror").unwrap();
        go("toggle-absolute").unwrap();
        go("cycle-number-format").unwrap();
        let cell = m.excel_cell.lock().unwrap().clone().unwrap();
        assert_eq!(cell, ("=IFERROR($A$1/$B$1,\"\")".to_string(), "#,##0".to_string()));
        *m.excel_cell.lock().unwrap() = None;
        assert_eq!(go("wrap-iferror"), Err("Excel is not running".into()));
    }

    #[test]
    fn executor_runs_in_order_and_reports() {
        let m = Arc::new(MockActions::default());
        let ex = ActionExecutor::new(m.clone(), ctx(false, false));
        let (tx, rx) = mpsc::channel();
        for step in [1, 2, 3] {
            let tx = tx.clone();
            ex.run(json!({"kind":"volume","step":step}), None, move |r| tx.send((step, r)).unwrap());
        }
        let got: Vec<_> = (0..3).map(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap()).collect();
        assert_eq!(got, vec![(1, Ok(())), (2, Ok(())), (3, Ok(()))]);
        assert_eq!(m.take_calls(), ["volume 1", "volume 2", "volume 3"]);
    }
}
