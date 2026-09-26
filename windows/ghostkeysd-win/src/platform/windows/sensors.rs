//! Motion and light sensors through Windows.Devices.Sensors (WinRT, usable from desktop apps).
//!
//! `GetDefault()` fails (or returns null) when the hardware is absent, which is the common case on
//! clamshell laptops. ReportInterval is a request: the driver arbitrates between all apps using
//! the sensor and may deliver slower. We ask for MinimumReportInterval (often 16 ms) and read back
//! what was accepted. Setting it back to 0 on stop returns the sensor to its default. The setting is
//! per app and dies with the process, so a crash leaves nothing behind.

use windows::Devices::Sensors::{
    Accelerometer, AccelerometerReadingChangedEventArgs, Gyrometer, GyrometerReadingChangedEventArgs, Inclinometer,
    InclinometerReadingChangedEventArgs, LightSensor, LightSensorReadingChangedEventArgs,
};
use windows::Foundation::TypedEventHandler;

use crate::clock;
use crate::log;
use crate::platform::{LightSource, MotionInfo, MotionSource, SensorEvent, SensorSink};

/// Fastest interval the driver allows; 16 ms when it does not say.
fn fastest(min: windows::core::Result<u32>) -> u32 {
    match min {
        Ok(m) if m > 0 => m,
        _ => 16,
    }
}

pub struct WinMotion {
    accel: Option<Accelerometer>,
    gyro: Option<Gyrometer>,
    incl: Option<Inclinometer>,
    tokens: Vec<(u8, i64)>,
    interval: u32,
}

impl WinMotion {
    pub fn open() -> Self {
        let accel = Accelerometer::GetDefault().ok();
        let gyro = Gyrometer::GetDefault().ok();
        let incl = Inclinometer::GetDefault().ok();
        let interval = accel.as_ref().map(|a| fastest(a.MinimumReportInterval())).unwrap_or(0);
        WinMotion { accel, gyro, incl, tokens: vec![], interval }
    }
}

impl MotionSource for WinMotion {
    fn info(&self) -> MotionInfo {
        MotionInfo {
            accelerometer: self.accel.is_some(),
            gyrometer: self.gyro.is_some(),
            inclinometer: self.incl.is_some(),
            report_interval_ms: self.interval,
        }
    }

    fn start(&mut self, sink: SensorSink) -> Result<(), String> {
        self.stop();
        if let Some(a) = &self.accel {
            let _ = a.SetReportInterval(fastest(a.MinimumReportInterval()));
            self.interval = a.ReportInterval().unwrap_or(self.interval);
            let s = sink.clone();
            let handler = TypedEventHandler::<Accelerometer, AccelerometerReadingChangedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let r = args.Reading()?;
                    s(SensorEvent::Accel { t: clock::now(), a: [r.AccelerationX()?, r.AccelerationY()?, r.AccelerationZ()?] });
                }
                Ok(())
            });
            let token = a.ReadingChanged(&handler).map_err(|e| format!("accelerometer: {e}"))?;
            self.tokens.push((0, token));
            log::info(&format!("accelerometer streaming every {} ms", self.interval));
        }
        if let Some(g) = &self.gyro {
            let _ = g.SetReportInterval(fastest(g.MinimumReportInterval()));
            let s = sink.clone();
            let handler = TypedEventHandler::<Gyrometer, GyrometerReadingChangedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let r = args.Reading()?;
                    s(SensorEvent::Gyro { t: clock::now(), g: [r.AngularVelocityX()?, r.AngularVelocityY()?, r.AngularVelocityZ()?] });
                }
                Ok(())
            });
            let token = g.ReadingChanged(&handler).map_err(|e| format!("gyrometer: {e}"))?;
            self.tokens.push((1, token));
        }
        if let Some(i) = &self.incl {
            let _ = i.SetReportInterval(fastest(i.MinimumReportInterval()).max(16));
            let s = sink;
            let handler = TypedEventHandler::<Inclinometer, InclinometerReadingChangedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let r = args.Reading()?;
                    s(SensorEvent::Inclination { t: clock::now(), pitch: r.PitchDegrees()? as f64, roll: r.RollDegrees()? as f64 });
                }
                Ok(())
            });
            let token = i.ReadingChanged(&handler).map_err(|e| format!("inclinometer: {e}"))?;
            self.tokens.push((2, token));
        }
        Ok(())
    }

    fn stop(&mut self) {
        for (which, token) in self.tokens.drain(..) {
            match which {
                0 => {
                    if let Some(a) = &self.accel {
                        let _ = a.RemoveReadingChanged(token);
                        let _ = a.SetReportInterval(0);
                    }
                }
                1 => {
                    if let Some(g) = &self.gyro {
                        let _ = g.RemoveReadingChanged(token);
                        let _ = g.SetReportInterval(0);
                    }
                }
                _ => {
                    if let Some(i) = &self.incl {
                        let _ = i.RemoveReadingChanged(token);
                        let _ = i.SetReportInterval(0);
                    }
                }
            }
        }
    }
}

pub struct WinLight {
    sensor: Option<LightSensor>,
    token: Option<i64>,
}

impl WinLight {
    pub fn open() -> Self {
        WinLight { sensor: LightSensor::GetDefault().ok(), token: None }
    }
}

impl LightSource for WinLight {
    fn present(&self) -> bool {
        self.sensor.is_some()
    }

    fn start(&mut self, sink: SensorSink) -> Result<(), String> {
        self.stop();
        let l = self.sensor.as_ref().ok_or("no light sensor")?;
        // 100 ms is plenty for a cover gesture; many light sensors only report on change anyway,
        // which is why the daemon polls the cover detector on its own timer.
        let _ = l.SetReportInterval(fastest(l.MinimumReportInterval()).max(100));
        // Deliver the current value first so the baseline starts right away.
        if let Ok(r) = l.GetCurrentReading() {
            if let Ok(lux) = r.IlluminanceInLux() {
                sink(SensorEvent::Light { t: clock::now(), lux: lux as f64 });
            }
        }
        let handler = TypedEventHandler::<LightSensor, LightSensorReadingChangedEventArgs>::new(move |_, args| {
            if let Some(args) = args.as_ref() {
                let r = args.Reading()?;
                sink(SensorEvent::Light { t: clock::now(), lux: r.IlluminanceInLux()? as f64 });
            }
            Ok(())
        });
        self.token = Some(l.ReadingChanged(&handler).map_err(|e| format!("light sensor: {e}"))?);
        Ok(())
    }

    fn stop(&mut self) {
        if let (Some(l), Some(t)) = (&self.sensor, self.token.take()) {
            let _ = l.RemoveReadingChanged(t);
            let _ = l.SetReportInterval(0);
        }
    }
}
