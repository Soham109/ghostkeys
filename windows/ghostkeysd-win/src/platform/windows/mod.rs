//! The Windows platform, built on the `windows` crate. Compiled only on Windows.
//!
//! | trait          | implementation                                                                |
//! | -------------- | ----------------------------------------------------------------------------- |
//! | MotionSource   | Windows.Devices.Sensors Accelerometer, Gyrometer, Inclinometer (WinRT)       |
//! | LightSource    | Windows.Devices.Sensors LightSensor (WinRT)                                  |
//! | AudioSource    | WASAPI shared-mode capture on the default microphone                          |
//! | InputActivity  | GetLastInputInfo, GetAsyncKeyState, GetForegroundWindow + process image name |
//! | ActionRunner   | SendInput, IAudioEndpointVolume, ShellExecuteW, SetWindowPos, Excel over COM |

mod actions;
mod audio;
mod devices;
mod excel_com;
mod input;
mod sensors;

use std::sync::Arc;

use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, INFINITE, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};

use super::Platform;
use crate::log;

/// Initializes the process (COM, DPI awareness) and gathers the platform.
pub fn platform() -> Platform {
    unsafe {
        // The main thread joins the multithreaded apartment; WinRT sensor activation and the
        // capture thread rely on it. S_FALSE (already initialized) is fine.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        // Window snapping works in physical pixels on every monitor.
        if let Err(e) = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) {
            log::debug(&format!("DPI awareness not set: {e}"));
        }
    }
    Platform {
        device: devices::device(),
        camera_present: devices::camera_present(),
        mic_permission: Some(devices::privacy("microphone")),
        camera_permission: Some(devices::privacy("webcam")),
        motion: Box::new(sensors::WinMotion::open()),
        light: Box::new(sensors::WinLight::open()),
        audio: Box::new(audio::WinAudio::open()),
        input: Arc::new(input::WinInput),
        actions: Arc::new(actions::WinActions),
    }
}

/// Blocks until process `pid` exits (or returns at once if it cannot be opened: already gone).
pub fn wait_for_process(pid: u32) {
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            WaitForSingleObject(h, INFINITE);
            let _ = CloseHandle(h);
        }
    }
}

/// UTF-16, NUL-terminated.
pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}
