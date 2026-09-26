//! Late-bound COM automation of a running Excel (IDispatch), the Windows counterpart of the Mac's
//! AppleScript integration. Only an already running Excel is used (GetActiveObject); the daemon
//! never starts Excel.
//!
//!   Application.ActiveCell.Formula        read / write (always en-US syntax)
//!   Application.ActiveCell.NumberFormat   read / write
//!   Application.Run(name)                 run a macro that is already in an open workbook
//!
//! Must be called on a thread that has initialized COM (the action thread does, see actions.rs).

use std::mem::ManuallyDrop;

use windows::core::{Interface, BSTR, GUID, HRESULT, PCWSTR};
use windows::Win32::System::Com::{CLSIDFromProgID, IDispatch, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPPARAMS};
use windows::Win32::System::Ole::{GetActiveObject, DISPID_PROPERTYPUT};
use windows::Win32::System::Variant::{VariantChangeType, VariantClear, VARIANT, VAR_CHANGE_FLAGS, VT_BSTR, VT_DISPATCH, VT_EMPTY};

use super::wide;

const LOCALE_USER_DEFAULT: u32 = 0x400;
const RPC_E_CALL_REJECTED: HRESULT = HRESULT(0x8001_0001u32 as i32);
const MK_E_UNAVAILABLE: HRESULT = HRESULT(0x8004_01E3u32 as i32);

fn explain(e: windows::core::Error) -> String {
    match e.code() {
        MK_E_UNAVAILABLE => "Excel is not running".into(),
        RPC_E_CALL_REJECTED => "Excel is busy (a cell is being edited or a dialog is open)".into(),
        _ => format!("Excel: {}", e.message()),
    }
}

/// A VARIANT holding a BSTR copy of `s`. Free with VariantClear.
fn bstr_variant(s: &str) -> VARIANT {
    let mut v = VARIANT::default();
    unsafe {
        let inner = &mut *v.Anonymous.Anonymous;
        inner.vt = VT_BSTR;
        inner.Anonymous.bstrVal = ManuallyDrop::new(BSTR::from(s));
    }
    v
}

unsafe fn dispid(obj: &IDispatch, name: &str) -> windows::core::Result<i32> {
    let w = wide(name);
    let names = [PCWSTR(w.as_ptr())];
    let mut id = 0i32;
    obj.GetIDsOfNames(&GUID::zeroed(), names.as_ptr(), 1, LOCALE_USER_DEFAULT, &mut id)?;
    Ok(id)
}

/// Invoke with positional `args` (given in natural order; COM wants them reversed).
unsafe fn invoke(obj: &IDispatch, name: &str, flags: DISPATCH_FLAGS, mut args: Vec<VARIANT>) -> windows::core::Result<VARIANT> {
    let id = dispid(obj, name)?;
    args.reverse();
    let mut named = [DISPID_PROPERTYPUT];
    let params = DISPPARAMS {
        rgvarg: if args.is_empty() { std::ptr::null_mut() } else { args.as_mut_ptr() },
        rgdispidNamedArgs: if flags == DISPATCH_PROPERTYPUT { named.as_mut_ptr() } else { std::ptr::null_mut() },
        cArgs: args.len() as u32,
        cNamedArgs: if flags == DISPATCH_PROPERTYPUT { 1 } else { 0 },
    };
    let mut result = VARIANT::default();
    let r = obj.Invoke(id, &GUID::zeroed(), LOCALE_USER_DEFAULT, flags, &params, Some(&mut result), None, None);
    for a in args.iter_mut() {
        let _ = VariantClear(a);
    }
    r.map(|_| result)
}

/// The IDispatch inside a VT_DISPATCH result (AddRef'd), releasing the VARIANT.
unsafe fn take_dispatch(mut v: VARIANT, what: &str) -> Result<IDispatch, String> {
    let inner = &*v.Anonymous.Anonymous;
    let d = if inner.vt == VT_DISPATCH { (*inner.Anonymous.pdispVal).clone() } else { None };
    let _ = VariantClear(&mut v);
    d.ok_or_else(|| format!("Excel has no {what} (is a worksheet cell selected?)"))
}

/// Any VARIANT as text (numbers, dates and booleans converted by COM), releasing it.
unsafe fn take_string(mut v: VARIANT) -> Result<String, String> {
    let mut s = VARIANT::default();
    let out = if (*v.Anonymous.Anonymous).vt == VT_EMPTY {
        Ok(String::new())
    } else {
        VariantChangeType(&mut s, &v, VAR_CHANGE_FLAGS(0), VT_BSTR).map_err(explain).map(|_| (*s.Anonymous.Anonymous).Anonymous.bstrVal.to_string())
    };
    let _ = VariantClear(&mut s);
    let _ = VariantClear(&mut v);
    out
}

unsafe fn application() -> Result<IDispatch, String> {
    let clsid = CLSIDFromProgID(windows::core::w!("Excel.Application")).map_err(|_| "Excel is not installed".to_string())?;
    let mut unknown = None;
    GetActiveObject(&clsid, None, &mut unknown).map_err(explain)?;
    unknown.ok_or("Excel is not running")?.cast::<IDispatch>().map_err(explain)
}

unsafe fn active_cell() -> Result<IDispatch, String> {
    let app = application()?;
    let v = invoke(&app, "ActiveCell", DISPATCH_PROPERTYGET, vec![]).map_err(explain)?;
    take_dispatch(v, "active cell")
}

pub fn get(property: &str) -> Result<String, String> {
    unsafe {
        let cell = active_cell()?;
        take_string(invoke(&cell, property, DISPATCH_PROPERTYGET, vec![]).map_err(explain)?)
    }
}

pub fn set(property: &str, value: &str) -> Result<(), String> {
    unsafe {
        let cell = active_cell()?;
        let mut r = invoke(&cell, property, DISPATCH_PROPERTYPUT, vec![bstr_variant(value)]).map_err(explain)?;
        let _ = VariantClear(&mut r);
        Ok(())
    }
}

pub fn run_macro(name: &str) -> Result<(), String> {
    unsafe {
        let app = application()?;
        let mut r = invoke(&app, "Run", DISPATCH_METHOD, vec![bstr_variant(name)]).map_err(explain)?;
        let _ = VariantClear(&mut r);
        Ok(())
    }
}
