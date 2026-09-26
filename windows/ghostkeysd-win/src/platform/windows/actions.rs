//! OS primitives for the action kinds. Runs on the single action thread (see crate::actions),
//! which initializes COM once as a single-threaded apartment (needed for Excel automation; fine
//! for the audio endpoint calls too).
//!
//! UIPI (User Interface Privilege Isolation): a normal-integrity process cannot send input to, or
//! move, windows of an elevated (administrator) app. SendInput then fails without saying why, so
//! the error message names the likely cause.

use std::cell::Cell;
use std::io::Read;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, RECT, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, MonitorFromWindow, HDC, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::Foundation::GlobalFree;
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::Shutdown::LockWorkStation;
use windows::Win32::System::Threading::CREATE_NO_WINDOW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetForegroundWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE, GetShellWindow, GetWindowRect, IsZoomed, PostMessageW, SetWindowPos, ShowWindow, HWND_BROADCAST, SC_MONITORPOWER,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, SW_SHOWNORMAL, WM_CLOSE, WM_SYSCOMMAND,
};

use super::{excel_com, wide};
use crate::keys::{self, VK_LWIN, VK_MENU, VK_SHIFT, VK_SNAPSHOT, VK_TAB};
use crate::platform::ActionRunner;
use crate::window_math::{self, Rect};

pub struct WinActions;

thread_local! {
    static COM_READY: Cell<bool> = const { Cell::new(false) };
}

/// COM for this thread (the action thread), once.
fn ensure_com() {
    COM_READY.with(|ready| {
        if !ready.get() {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ready.set(true);
        }
    });
}

fn key_input(vk: u16, up: bool, scan: u16, unicode: bool) -> INPUT {
    let mut flags = KEYBD_EVENT_FLAGS(0);
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    if unicode {
        flags |= KEYEVENTF_UNICODE;
    } else if keys::is_extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(if unicode { 0 } else { vk }), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn send(inputs: &[INPUT]) -> Result<(), String> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err("Windows blocked the key events (the window in front may be running as administrator)".into())
    }
}

fn chord(vk: u16, modifiers: &[u16]) -> Result<(), String> {
    let inputs: Vec<INPUT> = keys::chord_events(vk, modifiers).into_iter().map(|(k, up)| key_input(k, up, 0, false)).collect();
    send(&inputs)
}

fn endpoint_volume() -> Result<IAudioEndpointVolume, String> {
    ensure_com();
    unsafe {
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let device = e.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| "no audio output device".to_string())?;
        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|e| e.to_string())
    }
}

/// `~` and %VARIABLES% expanded.
fn expand(target: &str) -> String {
    let t = match target.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['\\', '/']) => format!("%USERPROFILE%{rest}"),
        _ => target.to_string(),
    };
    let src = wide(&t);
    unsafe {
        let needed = ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), None);
        if needed == 0 {
            return t;
        }
        let mut buf = vec![0u16; needed as usize];
        let n = ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buf));
        if n == 0 || n as usize > buf.len() {
            return t;
        }
        String::from_utf16_lossy(&buf[..n as usize - 1])
    }
}

/// The foreground window, unless it is the desktop itself.
fn foreground() -> Result<HWND, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() || hwnd == GetShellWindow() {
            return Err("no app window is in front".into());
        }
        Ok(hwnd)
    }
}

fn rect(r: RECT) -> Rect {
    Rect::new(r.left, r.top, r.right, r.bottom)
}

fn work_area(m: HMONITOR) -> Option<Rect> {
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    unsafe { GetMonitorInfoW(m, &mut info).as_bool().then(|| rect(info.rcWork)) }
}

fn all_work_areas() -> Vec<Rect> {
    unsafe extern "system" fn collect(m: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> windows::core::BOOL {
        let v = &mut *(data.0 as *mut Vec<Rect>);
        if let Some(r) = work_area(m) {
            v.push(r);
        }
        true.into()
    }
    let mut v: Vec<Rect> = vec![];
    unsafe {
        let _ = EnumDisplayMonitors(None, None, Some(collect), LPARAM(&mut v as *mut Vec<Rect> as isize));
    }
    v.sort_by_key(|r| (r.left, r.top));
    v
}

/// Runs `cmd.exe /D /S /C "<command>"` hidden, in the user's profile folder, killing the whole
/// process tree (via a job object) if it outlives `timeout`.
fn run_shell(command: &str, timeout: Duration) -> Result<(), String> {
    let home = std::env::var_os("USERPROFILE").unwrap_or_else(|| ".".into());
    let mut child = Command::new("cmd.exe")
        // /S /C "..." makes cmd strip exactly the outer quotes and run the rest verbatim.
        .raw_arg(format!("/D /S /C \"{command}\""))
        .current_dir(home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW.0)
        .spawn()
        .map_err(|e| format!("could not start cmd.exe: {e}"))?;

    let job = unsafe {
        let job = CreateJobObjectW(None, PCWSTR::null()).ok();
        if let Some(j) = job {
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let _ = SetInformationJobObject(
                j,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let _ = AssignProcessToJobObject(j, HANDLE(child.as_raw_handle()));
        }
        job
    };

    let mut stderr = child.stderr.take();
    let err_reader = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            let _ = e.take(64 * 1024).read_to_string(&mut s);
        }
        s
    });
    let mut stdout = child.stdout.take();
    let out_reader = std::thread::spawn(move || {
        let mut sink = Vec::new();
        if let Some(o) = stdout.as_mut() {
            let _ = o.take(64 * 1024).read_to_end(&mut sink);
        }
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) if Instant::now() >= deadline => break None,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => return Err(e.to_string()),
        }
    };
    if status.is_none() {
        let _ = child.kill();
    }
    if let Some(j) = job {
        unsafe {
            let _ = CloseHandle(j); // kills anything the command left running
        }
    }
    let _ = child.wait();
    let _ = out_reader.join();
    let err = err_reader.join().unwrap_or_default();
    match status {
        None => Err(format!("shell command timed out after {} s", timeout.as_secs())),
        Some(s) if s.success() => Ok(()),
        Some(s) => Err(format!("shell exited {}: {}", s.code().unwrap_or(-1), err.trim().chars().take(300).collect::<String>())),
    }
}

/// Brightness of the built-in panel through WMI (root/WMI WmiMonitorBrightness). Best effort:
/// most laptop panels support it, external monitors (DDC/CI) do not.
fn brightness_wmi(step: f64) -> Result<(), String> {
    let step = step.round() as i64;
    let script = format!(
        "$ErrorActionPreference='Stop'; \
         $b=(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1).CurrentBrightness; \
         $n=[Math]::Max(0,[Math]::Min(100,[int]$b+({step}))); \
         Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1 | \
         Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=[uint32]1; Brightness=[byte]$n}} | Out-Null"
    );
    let out = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .map_err(|e| format!("could not start PowerShell: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err("brightness is not adjustable on this display (WMI WmiMonitorBrightness unavailable; external monitors are not supported)".into())
    }
}

impl ActionRunner for WinActions {
    fn keystroke(&self, vk: u16, modifiers: &[u16]) -> Result<(), String> {
        chord(vk, modifiers)
    }

    fn text(&self, text: &str) -> Result<(), String> {
        let mut inputs = Vec::with_capacity(text.len() * 2);
        for c in text.chars() {
            if c == '\n' {
                inputs.push(key_input(keys::VK_RETURN, false, 0, false));
                inputs.push(key_input(keys::VK_RETURN, true, 0, false));
                continue;
            }
            if c == '\r' {
                continue;
            }
            let mut buf = [0u16; 2];
            for unit in c.encode_utf16(&mut buf).iter() {
                inputs.push(key_input(0, false, *unit, true));
                inputs.push(key_input(0, true, *unit, true));
            }
        }
        send(&inputs)
    }

    fn clipboard(&self, text: &str) -> Result<(), String> {
        let data: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            // The clipboard needs an owner window: with a NULL owner, EmptyClipboard leaves the
            // clipboard ownerless and SetClipboardData fails (OpenClipboard docs). A message-only
            // window is invisible and lives only for this call.
            let owner = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                windows::core::w!("STATIC"),
                PCWSTR::null(),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
            .map_err(|e| format!("clipboard: {e}"))?;
            // Another app may hold the clipboard for a moment.
            let mut opened = false;
            for _ in 0..10 {
                if OpenClipboard(Some(owner)).is_ok() {
                    opened = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            if !opened {
                let _ = DestroyWindow(owner);
                return Err("the clipboard is busy".into());
            }
            let result = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| e.to_string())?;
                let mem = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2).map_err(|e| e.to_string())?;
                let ptr = GlobalLock(mem) as *mut u16;
                if ptr.is_null() {
                    let _ = GlobalFree(Some(mem));
                    return Err("could not lock clipboard memory".into());
                }
                std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, data.len());
                let _ = GlobalUnlock(mem);
                // On success the clipboard owns the memory.
                if let Err(e) = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(mem.0))) {
                    let _ = GlobalFree(Some(mem));
                    return Err(e.to_string());
                }
                Ok(())
            })();
            let _ = CloseClipboard();
            let _ = DestroyWindow(owner);
            result
        }
    }

    fn volume(&self, step: f64) -> Result<(), String> {
        let v = endpoint_volume()?;
        unsafe {
            let cur = v.GetMasterVolumeLevelScalar().map_err(|e| e.to_string())?;
            let next = (cur + (step / 100.0) as f32).clamp(0.0, 1.0);
            v.SetMasterVolumeLevelScalar(next, std::ptr::null()).map_err(|e| e.to_string())
        }
    }

    fn mute(&self) -> Result<(), String> {
        let v = endpoint_volume()?;
        unsafe {
            let muted = v.GetMute().map_err(|e| e.to_string())?.as_bool();
            v.SetMute(!muted, std::ptr::null()).map_err(|e| e.to_string())
        }
    }

    fn media(&self, command: &str) -> Result<(), String> {
        let vk = match command {
            "next" => keys::VK_MEDIA_NEXT_TRACK,
            "previous" => keys::VK_MEDIA_PREV_TRACK,
            _ => keys::VK_MEDIA_PLAY_PAUSE,
        };
        chord(vk, &[])
    }

    fn brightness(&self, step: f64) -> Result<(), String> {
        brightness_wmi(step)
    }

    fn open(&self, target: &str) -> Result<(), String> {
        let t = wide(&expand(target));
        let r = unsafe { ShellExecuteW(None, windows::core::w!("open"), PCWSTR(t.as_ptr()), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
        // ShellExecute returns a value greater than 32 on success.
        if r.0 as isize > 32 {
            Ok(())
        } else {
            Err(format!("could not open {target} (ShellExecute error {})", r.0 as isize))
        }
    }

    fn shell(&self, command: &str, timeout: Duration) -> Result<(), String> {
        run_shell(command, timeout)
    }

    fn window(&self, op: &str) -> Result<(), String> {
        let hwnd = foreground()?;
        unsafe {
            match op {
                "minimize" => {
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                    return Ok(());
                }
                "maximize" => {
                    let _ = ShowWindow(hwnd, SW_MAXIMIZE);
                    return Ok(());
                }
                "fullscreen" => {
                    // No system-wide fullscreen on Windows; toggle maximized instead.
                    let _ = ShowWindow(hwnd, if IsZoomed(hwnd).as_bool() { SW_RESTORE } else { SW_MAXIMIZE });
                    return Ok(());
                }
                _ => {}
            }
            if IsZoomed(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let mut wr = RECT::default();
            GetWindowRect(hwnd, &mut wr).map_err(|e| e.to_string())?;
            let mut vis = wr;
            // The visible frame, without the invisible resize borders of Windows 10/11.
            let _ = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut vis as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32);
            let (window_rect, visible) = (rect(wr), rect(vis));
            let current = work_area(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)).ok_or("no monitor")?;
            let mut next = current;
            if op == "next-display" {
                let monitors = all_work_areas();
                match window_math::next_monitor(&monitors, visible.center()) {
                    Some(i) => next = monitors[i],
                    None => return Ok(()), // one monitor: nothing to do, like the Mac
                }
            }
            let target = window_math::snap(op, visible, current, next).ok_or_else(|| format!("unknown window op: {op}"))?;
            let r = window_math::compensate_invisible_border(target, window_rect, visible);
            SetWindowPos(hwnd, None, r.left, r.top, r.width(), r.height(), SWP_NOZORDER | SWP_NOACTIVATE)
                .map_err(|_| "Windows refused to move that window (it may be running as administrator)".to_string())
        }
    }

    fn app(&self, op: &str) -> Result<(), String> {
        match op {
            "hide" => {
                let hwnd = foreground()?;
                unsafe {
                    let _ = ShowWindow(hwnd, SW_MINIMIZE);
                }
                Ok(())
            }
            // WM_CLOSE asks nicely: the app can still prompt to save.
            "quit" => unsafe { PostMessageW(Some(foreground()?), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.to_string()) },
            "switch-next" => chord(VK_TAB, &[VK_MENU]),
            "switch-previous" => chord(VK_TAB, &[VK_MENU, VK_SHIFT]),
            _ => Err(format!("unknown app op: {op}")),
        }
    }

    fn system(&self, op: &str) -> Result<(), String> {
        match op {
            "lock" => unsafe { LockWorkStation().map_err(|e| e.to_string()) },
            // 2 = power the display off; any input turns it back on.
            "sleep-display" => unsafe {
                PostMessageW(Some(HWND_BROADCAST), WM_SYSCOMMAND, WPARAM(SC_MONITORPOWER as usize), LPARAM(2)).map_err(|e| e.to_string())
            },
            "screenshot" => chord(VK_SNAPSHOT, &[VK_LWIN]), // saved to Pictures\Screenshots
            "screenshot-area" => chord(keys::vk_for("s").unwrap_or(0x53), &[VK_LWIN, VK_SHIFT]), // Snipping Tool
            "mission-control" => chord(VK_TAB, &[VK_LWIN]),                                  // Task View
            "launchpad" => chord(VK_LWIN, &[]),                                              // Start
            "show-desktop" => chord(keys::vk_for("d").unwrap_or(0x44), &[VK_LWIN]),
            _ => Err(format!("unsupported on Windows: {op}")),
        }
    }

    fn excel_get(&self, property: &str) -> Result<String, String> {
        ensure_com();
        excel_com::get(property)
    }

    fn excel_set(&self, property: &str, value: &str) -> Result<(), String> {
        ensure_com();
        excel_com::set(property, value)
    }

    fn excel_run_macro(&self, name: &str) -> Result<(), String> {
        ensure_com();
        excel_com::run_macro(name)
    }
}
