//! ghostkeysd-win entry point.

use std::process::ExitCode;
use std::time::Duration;

use ghostkeysd_win::options::{self, Parsed};
use ghostkeysd_win::platform::{Platform, SensorEvent, SensorSink};
use ghostkeysd_win::server::{self, ServerOptions};
use ghostkeysd_win::security::SessionToken;
use ghostkeysd_win::store::ConfigStore;
use ghostkeysd_win::{clock, log};

fn main() -> ExitCode {
    clock::start();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let opts = match options::parse(&args) {
        Ok(Parsed::Run(o)) => o,
        Ok(Parsed::Help) => {
            println!("{}", options::USAGE);
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("{e}\n{}", options::USAGE);
            return ExitCode::from(2);
        }
    };
    log::set_verbose(opts.verbose);
    if opts.restore_sensors {
        // The Mac daemon changes motion-sensor driver properties and restores them here after a
        // crash. The Windows daemon changes no system state (a WinRT ReportInterval is per app and
        // ends with the process), so there is nothing to do.
        return ExitCode::SUCCESS;
    }

    let platform = Platform::native();
    if opts.selftest {
        return selftest(platform);
    }

    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            log::error(&format!("could not start the runtime: {e}"));
            return ExitCode::from(1);
        }
    };
    rt.block_on(async move {
        let listener = match server::bind(opts.port).await {
            Ok(l) => l,
            Err(e) => {
                // Most likely the port is in use; the app sees the exit code.
                log::error(&format!("could not listen on 127.0.0.1:{}: {e}", opts.port));
                return ExitCode::from(3);
            }
        };
        let store = ConfigStore::new(ConfigStore::default_directory());
        let token = match SessionToken::create(&store.directory, std::env::var("GHOSTKEYS_TOKEN").ok()) {
            Ok(t) => t,
            Err(e) => {
                log::error(&format!("could not write the session token: {e}"));
                return ExitCode::from(1);
            }
        };
        log::info(&format!("listening on ws://127.0.0.1:{}/ (token in {})", opts.port, token.path.display()));
        let shutdown = shutdown_signal(opts.parent_pid);
        server::run(listener, platform, store, token, ServerOptions { dry_run: opts.dry_run }, shutdown).await;
        ExitCode::SUCCESS
    })
}

/// Ctrl+C / Ctrl+Break, or the parent process exiting. (Electron's child.kill() on Windows is
/// TerminateProcess, which gives no chance to clean up; that is fine because this daemon changes
/// no system state: sensor report intervals are per-app and released with the process.)
async fn shutdown_signal(parent_pid: Option<u32>) {
    let parent = async move {
        match parent_pid {
            Some(pid) => {
                let _ = tokio::task::spawn_blocking(move || wait_for_process(pid)).await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = parent => log::info("parent process exited"),
    }
}

#[cfg(windows)]
fn wait_for_process(pid: u32) {
    ghostkeysd_win::platform::windows::wait_for_process(pid);
}

#[cfg(not(windows))]
fn wait_for_process(_pid: u32) {
    // Only needed on Windows; elsewhere this daemon is a development tool.
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Opens the sensors for 3 s and prints what exists and how fast it reports.
fn selftest(mut p: Platform) -> ExitCode {
    use std::sync::{Arc, Mutex};
    let counts: Arc<Mutex<[u32; 4]>> = Arc::new(Mutex::new([0; 4]));
    let last_lux: Arc<Mutex<Option<f64>>> = Arc::new(Mutex::new(None));
    let (c, l) = (counts.clone(), last_lux.clone());
    let sink: SensorSink = Arc::new(move |ev| {
        let mut n = c.lock().unwrap();
        match ev {
            SensorEvent::Accel { .. } => n[0] += 1,
            SensorEvent::Gyro { .. } => n[1] += 1,
            SensorEvent::Inclination { .. } => n[2] += 1,
            SensorEvent::Light { lux, .. } => {
                n[3] += 1;
                *l.lock().unwrap() = Some(lux);
            }
            SensorEvent::Sound(_) => {}
        }
    });
    let m = p.motion.info();
    println!("device: {} ({})", p.device.model, p.device.chip);
    println!("accelerometer: {}  gyrometer: {}  inclinometer: {}  report interval: {} ms", m.accelerometer, m.gyrometer, m.inclinometer, m.report_interval_ms);
    println!("light sensor: {}  microphone: {}  camera: {}", p.light.present(), p.audio.present(), p.camera_present);
    if m.accelerometer || m.gyrometer || m.inclinometer {
        if let Err(e) = p.motion.start(sink.clone()) {
            println!("motion start failed: {e}");
        }
    }
    if p.light.present() {
        if let Err(e) = p.light.start(sink) {
            println!("light start failed: {e}");
        }
    }
    let secs = 3.0;
    std::thread::sleep(Duration::from_secs_f64(secs));
    p.motion.stop();
    p.light.stop();
    let n = *counts.lock().unwrap();
    println!(
        "rates over {secs} s: accel {:.1} Hz, gyro {:.1} Hz, inclinometer {:.1} Hz, light {} readings (last {:?} lux)",
        n[0] as f64 / secs,
        n[1] as f64 / secs,
        n[2] as f64 / secs,
        n[3],
        *last_lux.lock().unwrap()
    );
    let ok = !(m.accelerometer && n[0] == 0);
    if ok {
        ExitCode::SUCCESS
    } else {
        println!("FAIL: the accelerometer exists but sent nothing");
        ExitCode::from(1)
    }
}
