//! Device description for `hello` and camera presence.

use windows::core::PCWSTR;
use windows::Win32::Media::MediaFoundation::{
    IMFActivate, IMFAttributes, MFCreateAttributes, MFEnumDeviceSources, MFShutdown, MFStartup, MFSTARTUP_LITE, MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
    MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID, MF_VERSION,
};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Registry::{RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

use super::wide;
use crate::protocol::Device;

/// A REG_SZ value under HKEY_LOCAL_MACHINE, read-only.
fn reg_string(subkey: &str, value: &str) -> Option<String> {
    reg_string_in(HKEY_LOCAL_MACHINE, subkey, value)
}

fn reg_string_in(root: HKEY, subkey: &str, value: &str) -> Option<String> {
    let (k, v) = (wide(subkey), wide(value));
    let mut buf = vec![0u16; 256];
    let mut size = (buf.len() * 2) as u32;
    let r = unsafe { RegGetValueW(root, PCWSTR(k.as_ptr()), PCWSTR(v.as_ptr()), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size)) };
    if r.is_err() {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buf.len());
    let s = String::from_utf16_lossy(&buf[..len]).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// Whether desktop apps may use a capability ("microphone" or "webcam"), from the consent store
/// behind Settings > Privacy & security. Desktop (non-packaged) apps get no prompt: access is
/// allowed unless the device-wide switch, the per-user switch, or "Let desktop apps access" is off.
pub fn privacy(capability: &str) -> String {
    let base = format!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{capability}");
    let denied = |root: HKEY, key: &str| reg_string_in(root, key, "Value").is_some_and(|v| v.eq_ignore_ascii_case("Deny"));
    if denied(HKEY_LOCAL_MACHINE, &base) || denied(HKEY_CURRENT_USER, &base) || denied(HKEY_CURRENT_USER, &format!(r"{base}\NonPackaged")) {
        "denied".into()
    } else {
        "authorized".into()
    }
}

/// Model from the firmware (e.g. "Microsoft Corporation Surface Pro 9"), chip from the CPU name.
pub fn device() -> Device {
    let bios = r"HARDWARE\DESCRIPTION\System\BIOS";
    let maker = reg_string(bios, "SystemManufacturer").unwrap_or_default();
    let product = reg_string(bios, "SystemProductName").unwrap_or_default();
    let model = format!("{maker} {product}").trim().to_string();
    let chip = reg_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString").unwrap_or_else(|| std::env::consts::ARCH.into());
    Device { model: if model.is_empty() { "Windows PC".into() } else { model }, chip, family: "other".into() }
}

/// Whether any video capture device exists (Media Foundation enumeration; nothing is opened).
pub fn camera_present() -> bool {
    unsafe {
        if MFStartup(MF_VERSION, MFSTARTUP_LITE).is_err() {
            return false;
        }
        let found = (|| -> windows::core::Result<bool> {
            let mut attrs: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attrs, 1)?;
            let attrs = attrs.ok_or_else(windows::core::Error::empty)?;
            attrs.SetGUID(&MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)?;
            let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
            let mut count = 0u32;
            MFEnumDeviceSources(&attrs, &mut list, &mut count)?;
            for i in 0..count as usize {
                drop(std::ptr::read(list.add(i))); // Release each activation object.
            }
            CoTaskMemFree(Some(list as *const _));
            Ok(count > 0)
        })()
        .unwrap_or(false);
        let _ = MFShutdown();
        found
    }
}
