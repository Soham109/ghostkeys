//! Refusals for the `shell` action, the Windows version of the Mac's "never with sudo" rule.
//!
//! A shell binding runs `cmd.exe /C <command>` as the logged-in user, never elevated. These checks
//! refuse commands that ask for elevation or that wipe things in bulk:
//!   - elevation: `sudo` (Windows 11 has one), `runas`, `Start-Process -Verb RunAs`
//!   - registry: `reg delete`
//!   - disks: `format X:`, `Format-Volume`, `Clear-Disk`, `Initialize-Disk`, `Remove-Partition`,
//!     `diskpart`, `bcdedit`, `vssadmin delete`, `wmic shadowcopy delete`, `cipher /w`
//!   - recursive deletes: `del /s`, `erase /s`, `rd /s`, `rmdir /s`, `rm -rf` (any spelling of
//!     recursive + force), and `Remove-Item -Recurse` (or its aliases ri, rm, rmdir, rd, del, erase)
//!     when any argument is a system path (a drive root, Windows, Program Files, ProgramData,
//!     the Users folder or a whole profile, or the environment variables that point at them).
//!
//! This is a guard rail against a mistaken or malicious binding, not a sandbox: it reads the
//! command text case-insensitively, ignores cmd `^` and PowerShell backtick escapes, splits on
//! `& | ; && || ( ) { }` and newlines outside quotes, and re-checks quoted strings that contain
//! spaces (so `powershell -c "Remove-Item -Recurse C:\Windows"` is caught too).

#[derive(Debug, Clone)]
struct Token {
    text: String,
    quoted: bool,
}

/// Ok if the command may run, Err with the reason otherwise.
pub fn check_shell(command: &str) -> Result<(), String> {
    check_depth(command, 0)
}

fn check_depth(command: &str, depth: usize) -> Result<(), String> {
    // cmd uses ^ as an escape, PowerShell uses `. Neither changes the command's meaning here.
    let s: String = command.to_lowercase().chars().filter(|c| *c != '^' && *c != '`').collect();

    for (word, why) in [
        ("sudo", "uses sudo"),
        ("runas", "asks for administrator rights (runas)"),
        ("diskpart", "runs diskpart"),
        ("bcdedit", "changes boot settings (bcdedit)"),
        ("format-volume", "formats a volume"),
        ("clear-disk", "wipes a disk"),
        ("initialize-disk", "re-initializes a disk"),
        ("remove-partition", "removes a partition"),
    ] {
        if contains_word(&s, word) {
            return Err(format!("refusing a command that {why}"));
        }
    }

    let segments = lex(&s);
    let all: Vec<&Token> = segments.iter().flatten().collect();

    for seg in &segments {
        let words: Vec<&str> = seg.iter().map(|t| t.text.as_str()).collect();
        for (i, w) in words.iter().enumerate() {
            let cmd = strip_exe(w);
            let next = words.get(i + 1).copied().unwrap_or("");
            let rest = &words[i + 1..];
            match cmd {
                "reg" if next == "delete" => return Err("refusing a command that deletes registry keys (reg delete)".into()),
                "format" if is_drive(next) => return Err("refusing a command that formats a drive".into()),
                "vssadmin" if next == "delete" => return Err("refusing a command that deletes shadow copies".into()),
                "wmic" if rest.windows(2).any(|p| p[0] == "shadowcopy" && p[1] == "delete") => {
                    return Err("refusing a command that deletes shadow copies".into())
                }
                "cipher" if rest.iter().any(|a| has_slash_switch(a, "w")) => {
                    return Err("refusing a command that wipes free space (cipher /w)".into())
                }
                "del" | "erase" if rest.iter().any(|a| has_slash_switch(a, "s")) => {
                    return Err("refusing a recursive delete (del /s)".into())
                }
                "rd" | "rmdir" if rest.iter().any(|a| has_slash_switch(a, "s")) => {
                    return Err("refusing a recursive delete (rd /s)".into())
                }
                "rm" if rm_recursive_force(rest) => return Err("refusing rm -rf".into()),
                _ => {}
            }
        }
    }

    // Remove-Item -Recurse on a system path. Checked across the whole command so a pipeline like
    // `gci C:\Windows -Recurse | Remove-Item` counts too.
    let remove_family = ["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"];
    let has_remove = all.iter().any(|t| !t.quoted && remove_family.contains(&strip_exe(&t.text)));
    let has_recurse = all.iter().any(|t| is_recurse_flag(&t.text));
    if has_remove && has_recurse && all.iter().any(|t| is_system_path(&t.text)) {
        return Err("refusing Remove-Item -Recurse on a system path".into());
    }

    // Nested commands: quoted strings with spaces (powershell -c "...", cmd /c "...").
    if depth < 4 {
        for t in all.iter().filter(|t| t.quoted && t.text.contains(' ')) {
            check_depth(&t.text, depth + 1)?;
        }
    }
    Ok(())
}

/// Word match with boundaries: the characters around it are not letters, digits, `_` or `-`.
fn contains_word(s: &str, word: &str) -> bool {
    let is_word = |c: char| c.is_alphanumeric() || c == '_' || c == '-';
    let mut start = 0;
    while let Some(pos) = s[start..].find(word) {
        let a = start + pos;
        let b = a + word.len();
        let before_ok = s[..a].chars().next_back().map(|c| !is_word(c)).unwrap_or(true);
        let after_ok = s[b..].chars().next().map(|c| !is_word(c)).unwrap_or(true);
        if before_ok && after_ok {
            return true;
        }
        start = a + word.len().max(1);
    }
    false
}

/// Quote-aware split into segments of tokens.
fn lex(s: &str) -> Vec<Vec<Token>> {
    let mut segments = vec![];
    let mut seg: Vec<Token> = vec![];
    let mut cur = String::new();
    let mut quoted = false;
    let mut quote: Option<char> = None;
    let flush = |cur: &mut String, quoted: &mut bool, seg: &mut Vec<Token>| {
        if !cur.is_empty() || *quoted {
            seg.push(Token { text: std::mem::take(cur), quoted: *quoted });
        }
        *quoted = false;
    };
    for c in s.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                cur.push(c);
            }
            continue;
        }
        match c {
            '"' | '\'' => {
                quote = Some(c);
                quoted = true;
            }
            '&' | '|' | ';' | '\n' | '\r' | '(' | ')' | '{' | '}' => {
                flush(&mut cur, &mut quoted, &mut seg);
                if !seg.is_empty() {
                    segments.push(std::mem::take(&mut seg));
                }
            }
            c if c.is_whitespace() => flush(&mut cur, &mut quoted, &mut seg),
            c => cur.push(c),
        }
    }
    flush(&mut cur, &mut quoted, &mut seg);
    if !seg.is_empty() {
        segments.push(seg);
    }
    segments
}

fn strip_exe(w: &str) -> &str {
    let base = w.rsplit(['\\', '/']).next().unwrap_or(w);
    base.strip_suffix(".exe").or_else(|| base.strip_suffix(".com")).unwrap_or(base)
}

fn is_drive(w: &str) -> bool {
    let b = w.as_bytes();
    (b.len() == 2 || (b.len() == 3 && (b[2] == b'\\' || b[2] == b'/'))) && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// `/s`, `/S`, `/s/q`, `/q/s` style switches.
fn has_slash_switch(w: &str, letter: &str) -> bool {
    w.starts_with('/') && w.split('/').any(|p| p == letter || p.starts_with(&format!("{letter}:")))
}

fn is_recurse_flag(w: &str) -> bool {
    // PowerShell accepts any unambiguous prefix: -r, -re, ..., -recurse.
    w.len() >= 2 && w.starts_with('-') && !w.starts_with("--") && "-recurse".starts_with(w)
}

fn rm_recursive_force(args: &[&str]) -> bool {
    let mut recursive = false;
    let mut force = false;
    for a in args {
        if *a == "--recursive" || is_recurse_flag(a) {
            recursive = true;
        }
        if *a == "--force" || (a.len() >= 3 && a.starts_with('-') && "-force".starts_with(a)) {
            force = true;
        }
        if a.starts_with('-') && !a.starts_with("--") && a.len() > 1 && a[1..].chars().all(|c| c.is_ascii_alphabetic()) {
            let flags = &a[1..];
            if flags.len() <= 4 {
                if flags.contains('r') {
                    recursive = true;
                }
                if flags.contains('f') {
                    force = true;
                }
            }
        }
    }
    recursive && force
}

/// A path whose recursive removal would break Windows or wipe a user.
pub fn is_system_path(raw: &str) -> bool {
    let mut p = raw.trim().to_lowercase().replace('/', "\\");
    if let Some(rest) = p.strip_prefix("\\\\?\\") {
        p = rest.to_string();
    }
    if let Some(rest) = p.strip_prefix("-path:").or_else(|| p.strip_prefix("-literalpath:")) {
        p = rest.to_string();
    }
    // Drop trailing wildcards and separators: C:\Windows\*, C:\*.*, C:\
    loop {
        let before = p.len();
        for suffix in ["\\*.*", "\\*", "\\"] {
            if p.len() > suffix.len() && p.ends_with(suffix) {
                p.truncate(p.len() - suffix.len());
            }
        }
        if p == "*" || p == "\\" {
            return true;
        }
        if p.len() == before {
            break;
        }
    }
    if p == "\\" || is_drive(&p) {
        return true;
    }
    let vars = [
        "%systemroot%", "%windir%", "%systemdrive%", "%programfiles%", "%programfiles(x86)%", "%programw6432%",
        "%programdata%", "%allusersprofile%", "%userprofile%", "%homedrive%%homepath%", "%public%",
        "$env:systemroot", "$env:windir", "$env:systemdrive", "$env:programfiles", "${env:programfiles(x86)}",
        "$env:programdata", "$env:allusersprofile", "$env:userprofile", "$home", "~", "$env:public",
    ];
    // Variables that are themselves roots of something important: the var alone or anything under
    // it for the Windows / Program Files ones; alone only for the profile ones.
    let under_is_system = [
        "%systemroot%", "%windir%", "%programfiles%", "%programfiles(x86)%", "%programw6432%", "%programdata%",
        "$env:systemroot", "$env:windir", "$env:programfiles", "${env:programfiles(x86)}", "$env:programdata",
    ];
    if vars.contains(&p.as_str()) {
        return true;
    }
    if under_is_system.iter().any(|v| p.starts_with(&format!("{v}\\"))) {
        return true;
    }
    // Absolute paths on any drive letter.
    let b = p.as_bytes();
    if b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
        let rest = &p[3..];
        let first = rest.split('\\').next().unwrap_or("");
        let depth = rest.split('\\').filter(|s| !s.is_empty()).count();
        match first {
            "windows" | "program files" | "program files (x86)" | "programdata" | "$recycle.bin"
            | "system volume information" | "recovery" | "boot" => return true,
            // The Users folder itself, or one whole profile (C:\Users\alice). Deeper is the user's own data.
            "users" if depth <= 2 => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(c: &str) -> bool {
        check_shell(c).is_err()
    }

    #[test]
    fn elevation_is_refused() {
        assert!(refused("sudo notepad"));
        assert!(refused("runas /user:Administrator cmd"));
        assert!(refused("powershell -Command \"Start-Process cmd -Verb RunAs\""));
        assert!(refused("RUNAS.EXE /user:admin x"));
    }

    #[test]
    fn registry_and_disk_wipes_are_refused() {
        assert!(refused("reg delete HKCU\\Software\\Foo /f"));
        assert!(refused("REG.exe DELETE HKLM\\x"));
        assert!(refused("format c:"));
        assert!(refused("format D: /q"));
        assert!(refused("powershell Format-Volume -DriveLetter D"));
        assert!(refused("diskpart /s script.txt"));
        assert!(refused("vssadmin delete shadows /all"));
        assert!(refused("cipher /w:C:\\"));
    }

    #[test]
    fn recursive_deletes_are_refused() {
        assert!(refused("del /s /q C:\\temp\\*.log"));
        assert!(refused("del /S/Q build"));
        assert!(refused("erase /s x"));
        assert!(refused("rd /s /q C:\\stuff"));
        assert!(refused("rmdir /S node_modules"));
        assert!(refused("rm -rf /"));
        assert!(refused("rm -fr build"));
        assert!(refused("rm -r -f build"));
        assert!(refused("rm --recursive --force build"));
        assert!(refused("echo hi && rm -rf ~"));
    }

    #[test]
    fn remove_item_recurse_on_system_paths_is_refused() {
        assert!(refused("powershell -c \"Remove-Item -Recurse -Force C:\\Windows\\System32\""));
        assert!(refused("Remove-Item C:\\ -Recurse"));
        assert!(refused("Remove-Item -Path 'C:\\Program Files' -Recurse"));
        assert!(refused("ri $env:windir -r"));
        assert!(refused("Remove-Item -Recurse $HOME"));
        assert!(refused("Remove-Item -Recurse C:\\Users\\alice"));
        assert!(refused("gci C:\\Windows -Recurse | Remove-Item"));
        assert!(refused("Remove-Item -Rec \"%USERPROFILE%\""));
        assert!(refused("r^m -rf x"), "caret escapes are ignored");
        assert!(refused("Re`move-Item -Recurse C:\\ProgramData"), "backtick escapes are ignored");
    }

    #[test]
    fn ordinary_commands_are_allowed() {
        for ok in [
            "echo hello",
            "start https://example.com",
            "del C:\\temp\\old.log",
            "rd C:\\temp\\empty",
            "rm build.log",
            "rm -r build",
            "Remove-Item -Recurse C:\\Users\\alice\\build",
            "Remove-Item C:\\Windows\\Temp\\x.log",
            "git log --format=%h",
            "notepad pseudo.txt",
            "reg query HKCU\\Software",
            "powershell -c \"Get-ChildItem C:\\Windows\"",
            "python -c \"print('formats: 1')\"",
            "explorer shell:Downloads",
        ] {
            assert!(check_shell(ok).is_ok(), "should allow: {ok}: {:?}", check_shell(ok));
        }
    }

    #[test]
    fn system_path_detection() {
        for p in ["C:\\", "c:", "D:\\*", "C:\\Windows", "c:/windows/system32", "\"C:\\Program Files (x86)\"",
                  "%SystemRoot%\\Temp", "$env:ProgramFiles", "C:\\Users", "C:\\Users\\bob\\", "~", "\\\\?\\C:\\Windows"] {
            assert!(is_system_path(p.trim_matches('"')), "{p}");
        }
        for p in ["C:\\Users\\bob\\Downloads\\old", "D:\\projects\\build", "build", "%TEMP%\\x", ".\\out"] {
            assert!(!is_system_path(p), "{p}");
        }
    }
}
