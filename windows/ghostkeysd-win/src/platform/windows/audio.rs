//! Microphone capture with WASAPI (shared mode, event driven) on the default capture endpoint.
//!
//! Shared mode delivers the engine's mix format, which on current Windows is 32-bit float, usually
//! 48 kHz, often 2 channels; 16-bit PCM is handled too. Frames are downmixed to mono and handed to
//! the callback with the time of their first sample. The time comes from the QPC position WASAPI
//! stamps on each packet, mapped onto the daemon clock, so knock onsets are accurate to well under
//! a millisecond regardless of buffering.
//!
//! While capture runs, Windows shows its microphone-in-use indicator and lists the app under
//! Settings > Privacy & security > Microphone. That is expected; the daemon opens the mic only
//! during a sound session or when the user turned always-on sound mode on.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use windows::core::HRESULT;
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    eCapture, eConsole, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
};
use windows::Win32::Media::KernelStreaming::WAVE_FORMAT_EXTENSIBLE;
use windows::Win32::Media::Multimedia::{KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, WAVE_FORMAT_IEEE_FLOAT};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

use crate::clock;
use crate::log;
use crate::platform::{AudioCallback, AudioSource};

pub struct WinAudio {
    present: bool,
    stop: Option<Arc<AtomicBool>>,
    thread: Option<JoinHandle<()>>,
}

impl WinAudio {
    pub fn open() -> Self {
        WinAudio { present: capture_device_count() > 0, stop: None, thread: None }
    }
}

/// Active capture endpoints (microphones), counted without opening any.
fn capture_device_count() -> u32 {
    unsafe {
        let Ok(e) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return 0 };
        e.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE).and_then(|c| c.GetCount()).unwrap_or(0)
    }
}

impl AudioSource for WinAudio {
    fn present(&self) -> bool {
        self.present
    }

    fn running(&self) -> bool {
        self.thread.as_ref().is_some_and(|t| !t.is_finished())
    }

    fn start(&mut self, on_audio: AudioCallback) -> Result<(), String> {
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let s = stop.clone();
        let thread = std::thread::Builder::new()
            .name("ghostkeys-mic".into())
            .spawn(move || capture_thread(on_audio, s, ready_tx))
            .map_err(|e| e.to_string())?;
        match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => {
                self.stop = Some(stop);
                self.thread = Some(thread);
                Ok(())
            }
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                stop.store(true, Ordering::SeqCst);
                Err("the microphone did not start within 5 s".into())
            }
        }
    }

    fn stop(&mut self) {
        if let Some(s) = self.stop.take() {
            s.store(true, Ordering::SeqCst);
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for WinAudio {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone, Copy)]
enum SampleFormat {
    F32,
    I16,
    I32,
}

fn describe(e: &windows::core::Error) -> String {
    if e.code() == E_ACCESSDENIED {
        "microphone access is off (Windows Settings > Privacy & security > Microphone > Let desktop apps access your microphone)".into()
    } else if e.code() == HRESULT(0x8889_0004u32 as i32) {
        "the microphone was unplugged or disabled (AUDCLNT_E_DEVICE_INVALIDATED)".into()
    } else {
        format!("WASAPI: {e}")
    }
}

fn capture_thread(mut on_audio: AudioCallback, stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), String>>) {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        match open_stream() {
            Err(e) => {
                let _ = ready.send(Err(describe(&e)));
            }
            Ok(stream) => {
                let _ = ready.send(Ok(()));
                if let Err(e) = run_stream(&stream, &mut on_audio, &stop) {
                    log::error(&format!("microphone capture stopped: {}", describe(&e)));
                }
                let _ = stream.client.Stop();
                let _ = CloseHandle(stream.event);
            }
        }
        CoUninitialize();
    }
}

struct Stream {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: windows::Win32::Foundation::HANDLE,
    channels: usize,
    rate: f64,
    format: SampleFormat,
}

unsafe fn open_stream() -> windows::core::Result<Stream> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole)?;
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
    let mix: *mut WAVEFORMATEX = client.GetMixFormat()?;
    let fmt = *mix;
    let tag = fmt.wFormatTag as u32;
    let bits = fmt.wBitsPerSample;
    let is_float = if tag == WAVE_FORMAT_EXTENSIBLE {
        let ext = *(mix as *const WAVEFORMATEXTENSIBLE);
        let sub = ext.SubFormat;
        sub == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
    } else {
        tag == WAVE_FORMAT_IEEE_FLOAT
    };
    let format = match (is_float, bits) {
        (true, 32) => SampleFormat::F32,
        (false, 16) => SampleFormat::I16,
        (false, 32) => SampleFormat::I32,
        _ => {
            CoTaskMemFree(Some(mix as *const _));
            return Err(windows::core::Error::new(HRESULT(0x8889_0008u32 as i32), "unsupported microphone format"));
        }
    };
    // 20 ms buffer, event driven, in the engine's own format (no conversion needed in shared mode).
    let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 200_000, 0, mix, None);
    let channels = fmt.nChannels.max(1) as usize;
    let rate = fmt.nSamplesPerSec as f64;
    CoTaskMemFree(Some(mix as *const _));
    init?;
    let event = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(event)?;
    let capture: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    Ok(Stream { client, capture, event, channels, rate, format })
}

/// Current QPC time in seconds.
unsafe fn qpc_seconds() -> Option<f64> {
    let (mut c, mut f) = (0i64, 0i64);
    QueryPerformanceCounter(&mut c).ok()?;
    QueryPerformanceFrequency(&mut f).ok()?;
    (f > 0).then(|| c as f64 / f as f64)
}

unsafe fn run_stream(s: &Stream, on_audio: &mut AudioCallback, stop: &AtomicBool) -> windows::core::Result<()> {
    let mut mono: Vec<f32> = Vec::with_capacity(4096);
    while !stop.load(Ordering::SeqCst) {
        if WaitForSingleObject(s.event, 200) != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let frames_ready = s.capture.GetNextPacketSize()?;
            if frames_ready == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut qpc_pos = 0u64; // 100 ns units
            s.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc_pos))?;
            let n = frames as usize;
            mono.clear();
            if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                mono.resize(n, 0.0);
            } else {
                let ch = s.channels;
                for i in 0..n {
                    let mut acc = 0.0f32;
                    for c in 0..ch {
                        let idx = i * ch + c;
                        acc += match s.format {
                            SampleFormat::F32 => *(data as *const f32).add(idx),
                            SampleFormat::I16 => *(data as *const i16).add(idx) as f32 / 32768.0,
                            SampleFormat::I32 => *(data as *const i32).add(idx) as f32 / 2_147_483_648.0,
                        };
                    }
                    mono.push(acc / ch as f32);
                }
            }
            s.capture.ReleaseBuffer(frames)?;
            // How long ago the first frame was recorded, from the packet's QPC stamp.
            let age = match qpc_seconds() {
                Some(now) if qpc_pos > 0 => (now - qpc_pos as f64 / 1e7).clamp(0.0, 1.0),
                _ => n as f64 / s.rate,
            };
            on_audio(&mono, clock::now() - age, s.rate);
        }
    }
    Ok(())
}
