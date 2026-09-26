//! Everything the daemon writes lives in one folder: `%APPDATA%\Ghostkeys\` on Windows
//! (the Windows twin of `~/Library/Application Support/Ghostkeys/`). Nothing else on disk is written.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::config::Config;
use crate::log;

pub struct ConfigStore {
    pub directory: PathBuf,
}

impl ConfigStore {
    /// `%APPDATA%\Ghostkeys`. `GHOSTKEYS_CONFIG_DIR` overrides it (tests, portable installs).
    /// Off Windows (development with the mock platform) it falls back to `$HOME/.ghostkeys-win`.
    pub fn default_directory() -> PathBuf {
        if let Some(dir) = std::env::var_os("GHOSTKEYS_CONFIG_DIR") {
            return PathBuf::from(dir);
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("Ghostkeys");
        }
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap_or_else(|| ".".into());
        PathBuf::from(home).join(".ghostkeys-win")
    }

    pub fn new(directory: impl Into<PathBuf>) -> Self {
        ConfigStore { directory: directory.into() }
    }

    pub fn config_path(&self) -> PathBuf {
        self.directory.join("config.json")
    }

    /// Loads config.json, creating it from defaults if missing. A corrupt file is copied to
    /// `config.json.bad` and never overwritten, so the user's work is not lost.
    pub fn load(&self) -> Config {
        let path = self.config_path();
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => {
                let c = Config::default();
                if let Err(e) = self.save(&c) {
                    log::error(&format!("could not write default config: {e}"));
                }
                return c;
            }
        };
        match serde_json::from_str::<Config>(&text) {
            Ok(c) => c,
            Err(e) => {
                log::error(&format!("config.json unreadable ({e}); using defaults, original kept as config.json.bad"));
                let _ = fs::copy(&path, self.directory.join("config.json.bad"));
                Config::default()
            }
        }
    }

    pub fn save(&self, config: &Config) -> io::Result<()> {
        let text = serde_json::to_string_pretty(config).map_err(io::Error::other)?;
        write_atomic(&self.config_path(), text.as_bytes())
    }
}

/// Write to a temp file in the same folder, then rename over the target (MoveFileEx with
/// MOVEFILE_REPLACE_EXISTING on Windows), so a crash never leaves a half-written config.
fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("no parent directory"))?;
    fs::create_dir_all(dir)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}
