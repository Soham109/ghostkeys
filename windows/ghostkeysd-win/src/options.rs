//! Command line, same flags as the Mac daemon where they apply.

pub const USAGE: &str = "usage: ghostkeysd-win [--port N] [--parent-pid PID] [--verbose] [--dry-run] [--selftest]
  --port N          WebSocket port on 127.0.0.1 (default 47823)
  --parent-pid PID  exit when this process ends (the Electron app passes its own pid)
  --verbose         debug logging to stderr
  --dry-run         log actions instead of running them
  --selftest        open the sensors for 3 s, print what exists and their rates, exit 0 (ok) or 1
  --restore-sensors accepted for compatibility with the app's crash recovery; nothing to restore on Windows

environment: GHOSTKEYS_TOKEN (at least 32 characters) is accepted as a WebSocket token in addition to
the per-launch token written to %APPDATA%\\Ghostkeys\\token";

#[derive(Debug, Clone, PartialEq)]
pub struct Options {
    pub port: u16,
    pub verbose: bool,
    pub dry_run: bool,
    pub selftest: bool,
    pub restore_sensors: bool,
    pub parent_pid: Option<u32>,
}

impl Default for Options {
    fn default() -> Self {
        Options { port: crate::protocol::DEFAULT_PORT, verbose: false, dry_run: false, selftest: false, restore_sensors: false, parent_pid: None }
    }
}

pub enum Parsed {
    Run(Options),
    Help,
}

/// `args` excludes the program name.
pub fn parse(args: &[String]) -> Result<Parsed, String> {
    let mut o = Options::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut value = || -> Result<&String, String> {
            i += 1;
            args.get(i).ok_or_else(|| format!("missing value for {a}"))
        };
        match a {
            "--port" => o.port = value()?.parse().ok().filter(|p| *p > 0).ok_or("invalid port")?,
            "--parent-pid" => o.parent_pid = Some(value()?.parse().ok().filter(|p| *p > 1).ok_or("invalid parent pid")?),
            "--verbose" | "-v" => o.verbose = true,
            "--dry-run" => o.dry_run = true,
            "--selftest" => o.selftest = true,
            "--restore-sensors" => o.restore_sensors = true,
            "--help" | "-h" => return Ok(Parsed::Help),
            _ => match a.strip_prefix("--port=").and_then(|p| p.parse().ok()).filter(|p: &u16| *p > 0) {
                Some(p) => o.port = p,
                None => return Err(format!("unknown argument {a}")),
            },
        }
        i += 1;
    }
    Ok(Parsed::Run(o))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(v: &[&str]) -> Result<Options, String> {
        match parse(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>())? {
            Parsed::Run(o) => Ok(o),
            Parsed::Help => Err("help".into()),
        }
    }

    #[test]
    fn flags() {
        assert_eq!(p(&[]).unwrap(), Options::default());
        let o = p(&["--port", "5000", "--dry-run", "--parent-pid", "1234", "-v"]).unwrap();
        assert_eq!((o.port, o.dry_run, o.parent_pid, o.verbose), (5000, true, Some(1234), true));
        assert_eq!(p(&["--port=6000"]).unwrap().port, 6000);
        assert!(p(&["--port", "0"]).is_err());
        assert!(p(&["--port"]).is_err());
        assert!(p(&["--bogus"]).is_err());
        assert!(p(&["--help"]).is_err());
    }
}
