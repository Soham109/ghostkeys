//! Typing gate, held modifiers, and the foreground app.
//!
//! GetLastInputInfo reports the last keyboard *or* mouse input for the session. It cannot tell
//! typing from pointer use, so the Windows typing gate covers both (the Mac's "typing" and
//! "trackpad" reasons collapse into "typing"). It reads no key contents, and no hook is installed.

use std::collections::BTreeSet;

use windows::core::PWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::keys::{VK_CONTROL, VK_LWIN, VK_MENU, VK_SHIFT};
use crate::platform::InputActivity;

const VK_RWIN: u16 = 0x5C;

pub struct WinInput;

fn down(vk: u16) -> bool {
    unsafe { (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 }
}

impl InputActivity for WinInput {
    fn seconds_since_input(&self) -> f64 {
        let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
        unsafe {
            if !GetLastInputInfo(&mut info).as_bool() {
                return 99.0;
            }
            // Both are 32-bit tick counts that wrap every 49.7 days; wrapping_sub handles it.
            GetTickCount().wrapping_sub(info.dwTime) as f64 / 1000.0
        }
    }

    /// Protocol names: Ctrl is "control", Alt is "option", the Windows key is "command".
    fn modifiers(&self) -> BTreeSet<String> {
        let mut m = BTreeSet::new();
        if down(VK_SHIFT) {
            m.insert("shift".to_string());
        }
        if down(VK_CONTROL) {
            m.insert("control".to_string());
        }
        if down(VK_MENU) {
            m.insert("option".to_string());
        }
        if down(VK_LWIN) || down(VK_RWIN) {
            m.insert("command".to_string());
        }
        m
    }

    fn foreground_app(&self) -> Option<String> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let r = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            r.ok()?;
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            path.rsplit('\\').next().map(|exe| exe.to_ascii_lowercase())
        }
    }
}
