//! The loopback WebSocket server and the event loop that drives `Core`.
//!
//! One task owns `Core`. Sockets, sensor callbacks, the audio thread and the action thread all send
//! `Input`s to it over one channel, so `Core` never needs a lock and events are handled in order.
//!
//! Security, as PROTOCOL.md "Authentication" and the Mac's WebSocketServer.swift:
//! - bound to 127.0.0.1 only;
//! - a handshake with any `Origin` header is refused (browsers always send one, the app never does);
//! - a handshake without the right `X-Ghostkeys-Token` is refused;
//! - at most 8 clients; more than 200 messages per second from one client disconnects it;
//!   messages over 1 MB are refused;
//! - a client that stops reading first misses stream frames (imu, light, lid, taps) once 64 KB are
//!   waiting, then is disconnected once 1 MB is waiting.

use std::collections::HashMap;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::actions::{ActionExecutor, RunContext};
use crate::clock;
use crate::core::{ActionDone, ClientId, Core, CoreDeps, Hardware, Target};
use crate::detection::sound::SoundDetector;
use crate::log;
use crate::platform::{Platform, SensorEvent, SensorSink};
use crate::protocol::OutMsg;
use crate::security::{ApprovalStore, SessionToken, TOKEN_HEADER};
use crate::store::ConfigStore;

pub const MAX_CLIENTS: usize = 8;
pub const MAX_MESSAGES_PER_SECOND: u32 = 200;
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;
pub const STREAM_BACKLOG_BYTES: usize = 64 * 1024;
pub const MAX_BACKLOG_BYTES: usize = 1 << 20;

pub enum Input {
    Connect(ClientId, ClientHandle),
    Disconnect(ClientId),
    Message(ClientId, String),
    RateLimited(ClientId),
    Sensor(SensorEvent),
    ActionDone(ActionDone),
}

/// The core's side of one connection: a frame queue and how many bytes in it are unsent.
pub struct ClientHandle {
    tx: mpsc::UnboundedSender<String>,
    pending: Arc<AtomicUsize>,
}

pub struct ServerOptions {
    pub dry_run: bool,
}

/// Binds to 127.0.0.1 only, never to all interfaces.
pub async fn bind(port: u16) -> std::io::Result<TcpListener> {
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await
}

/// Handshake check. Returns the reason for a refusal.
pub fn authorize(headers: &tokio_tungstenite::tungstenite::http::HeaderMap, token: &SessionToken) -> Result<(), &'static str> {
    if headers.contains_key("origin") {
        return Err("a handshake with an Origin header (a browser page?)");
    }
    let presented = headers.get(TOKEN_HEADER).and_then(|v| v.to_str().ok());
    if !token.accepts(presented) {
        return Err("a handshake without a valid X-Ghostkeys-Token");
    }
    Ok(())
}

/// Runs until `shutdown` resolves. Starts the sensors, serves clients, stops the sensors.
pub async fn run(
    listener: TcpListener,
    mut platform: Platform,
    store: ConfigStore,
    token: SessionToken,
    opts: ServerOptions,
    shutdown: impl Future<Output = ()>,
) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Input>();

    let paused = Arc::new(AtomicBool::new(false));
    let approvals = Arc::new(ApprovalStore::load(&store.directory));
    let executor = ActionExecutor::new(
        platform.actions.clone(),
        RunContext { paused: paused.clone(), dry_run: opts.dry_run, approvals: approvals.clone() },
    );
    let notify_tx = tx.clone();
    let notify = Arc::new(move |d: ActionDone| {
        let _ = notify_tx.send(Input::ActionDone(d));
    });

    let motion = platform.motion.info();
    let hardware = Hardware {
        device: Some(platform.device.clone()),
        motion,
        light: platform.light.present(),
        mic: platform.audio.present(),
        camera: platform.camera_present,
        mic_permission: platform.mic_permission.clone(),
        camera_permission: platform.camera_permission.clone(),
    };
    log::info(&format!(
        "ghostkeysd-win {} on {} ({}): accelerometer {} ({} ms), gyrometer {}, inclinometer {}, light {}, mic {}, camera {}{}; config in {}",
        crate::protocol::VERSION,
        platform.device.model,
        platform.device.chip,
        motion.accelerometer,
        motion.report_interval_ms,
        motion.gyrometer,
        motion.inclinometer,
        hardware.light,
        hardware.mic,
        hardware.camera,
        if opts.dry_run { " [dry-run]" } else { "" },
        store.directory.display()
    ));
    let mut core = Core::new(CoreDeps { hardware, store, input: platform.input.clone(), executor, paused, approvals, notify });

    let sensor_tx = tx.clone();
    let sink: SensorSink = Arc::new(move |ev| {
        let _ = sensor_tx.send(Input::Sensor(ev));
    });
    if motion.accelerometer || motion.inclinometer || motion.gyrometer {
        if let Err(e) = platform.motion.start(sink.clone()) {
            log::error(&format!("motion sensors: {e}"));
        }
    }
    if platform.light.present() {
        if let Err(e) = platform.light.start(sink.clone()) {
            log::error(&format!("light sensor: {e}"));
        }
    }
    let mut audio_sensitivity: Option<f64> = None;
    let _ = sync_audio(&core, &mut platform, &tx, &mut audio_sensitivity);

    // Accept loop.
    let token = Arc::new(token);
    let accept_tx = tx.clone();
    let next_id = Arc::new(AtomicU64::new(1));
    let live = Arc::new(AtomicUsize::new(0));
    let accept = tokio::spawn(async move {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(x) => x,
                Err(e) => {
                    log::error(&format!("accept failed: {e}"));
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            if !peer.ip().is_loopback() {
                continue; // cannot happen when bound to 127.0.0.1; belt and braces
            }
            if live.fetch_add(1, Ordering::SeqCst) >= MAX_CLIENTS {
                live.fetch_sub(1, Ordering::SeqCst);
                log::info(&format!("refusing a connection: already {MAX_CLIENTS} clients"));
                continue; // dropping the stream closes it
            }
            let id = next_id.fetch_add(1, Ordering::Relaxed);
            let (tx, token, live) = (accept_tx.clone(), token.clone(), live.clone());
            tokio::spawn(async move {
                serve_client(stream, id, tx, token).await;
                live.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });

    let mut clients: HashMap<ClientId, ClientHandle> = HashMap::new();
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tokio::pin!(shutdown);

    loop {
        let mut out = tokio::select! {
            _ = &mut shutdown => break,
            _ = ticker.tick() => core.tick(clock::now()),
            input = rx.recv() => match input {
                None => break,
                Some(Input::Connect(id, handle)) => {
                    log::debug(&format!("client {id} connected"));
                    clients.insert(id, handle);
                    core.connect(id)
                }
                Some(Input::Disconnect(id)) => {
                    log::debug(&format!("client {id} disconnected"));
                    clients.remove(&id);
                    core.disconnect(id);
                    vec![]
                }
                Some(Input::RateLimited(id)) => {
                    log::info(&format!("client {id} exceeded {MAX_MESSAGES_PER_SECOND} messages/s; disconnecting"));
                    if let Some(c) = clients.remove(&id) {
                        // The writer sends this, then closes because its queue sender is gone.
                        let _ = c.tx.send(OutMsg::error("rate limit exceeded; disconnecting").to_json());
                    }
                    core.disconnect(id);
                    vec![]
                }
                Some(Input::Message(id, text)) => core.message(id, &text),
                Some(Input::Sensor(ev)) => core.sensor(ev),
                Some(Input::ActionDone(d)) => core.action_done(d),
            },
        };
        // Open or close the microphone when a message or a tick changed what the core wants.
        if let Some(err) = sync_audio(&core, &mut platform, &tx, &mut audio_sensitivity) {
            out.extend(core.sound_failed(err));
        }
        for o in out {
            let json = o.msg.to_json();
            let droppable = matches!(o.target, Target::Stream(_));
            for id in core.recipients(&o.target) {
                let Some(c) = clients.get(&id) else { continue };
                let waiting = c.pending.load(Ordering::SeqCst);
                if droppable && waiting > STREAM_BACKLOG_BYTES {
                    continue;
                }
                if waiting + json.len() > MAX_BACKLOG_BYTES {
                    log::info(&format!("client {id} is not reading; disconnecting"));
                    clients.remove(&id); // its writer ends and closes the socket
                    core.disconnect(id);
                    continue;
                }
                c.pending.fetch_add(json.len(), Ordering::SeqCst);
                let _ = c.tx.send(json.clone());
            }
        }
    }

    log::info("shutting down");
    accept.abort();
    platform.audio.stop();
    platform.light.stop();
    platform.motion.stop();
}

/// Starts, restarts (sensitivity changed) or stops microphone capture to match the core's wishes.
/// Returns an error when the microphone should be open but could not be opened.
fn sync_audio(core: &Core, platform: &mut Platform, tx: &mpsc::UnboundedSender<Input>, current: &mut Option<f64>) -> Option<String> {
    let wanted = core.sound_wanted();
    if wanted == *current && platform.audio.running() == wanted.is_some() {
        return None;
    }
    let was_on = platform.audio.running();
    platform.audio.stop();
    *current = None;
    let Some(sensitivity) = wanted else {
        if was_on {
            log::info("sound mode off: microphone closed");
        }
        return None;
    };
    let tx = tx.clone();
    let detector: Arc<Mutex<Option<SoundDetector>>> = Arc::new(Mutex::new(None));
    let result = platform.audio.start(Box::new(move |samples, t_first, rate| {
        let mut guard = detector.lock().unwrap();
        let d = guard.get_or_insert_with(|| {
            let mut d = SoundDetector::new(rate);
            d.sensitivity = sensitivity;
            d
        });
        for o in d.process(samples, t_first) {
            let _ = tx.send(Input::Sensor(SensorEvent::Sound(o)));
        }
    }));
    match result {
        Ok(()) => {
            *current = Some(sensitivity);
            log::info("sound mode on: listening for knocks on the default microphone");
            None
        }
        Err(e) => {
            log::error(&format!("sound mode: could not open the microphone: {e}"));
            Some(e)
        }
    }
}

// The handshake callback's signature is fixed by tungstenite.
#[allow(clippy::result_large_err)]
async fn serve_client(stream: TcpStream, id: ClientId, tx: mpsc::UnboundedSender<Input>, token: Arc<SessionToken>) {
    let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        match authorize(req.headers(), &token) {
            Ok(()) => Ok(resp),
            Err(why) => {
                log::info(&format!("rejected {why}"));
                let mut r = ErrorResponse::new(None);
                *r.status_mut() = StatusCode::FORBIDDEN;
                Err(r)
            }
        }
    };
    let config = WebSocketConfig::default().max_message_size(Some(MAX_MESSAGE_BYTES)).max_frame_size(Some(MAX_MESSAGE_BYTES));
    let ws = match tokio_tungstenite::accept_hdr_async_with_config(stream, check, Some(config)).await {
        Ok(ws) => ws,
        Err(e) => {
            log::debug(&format!("handshake failed: {e}"));
            return;
        }
    };
    let (mut write, mut read) = ws.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let pending = Arc::new(AtomicUsize::new(0));
    if tx.send(Input::Connect(id, ClientHandle { tx: out_tx, pending: pending.clone() })).is_err() {
        return;
    }
    let writer = tokio::spawn(async move {
        while let Some(text) = out_rx.recv().await {
            let n = text.len();
            let ok = write.send(Message::text(text)).await.is_ok();
            pending.fetch_sub(n.min(pending.load(Ordering::SeqCst)), Ordering::SeqCst);
            if !ok {
                break;
            }
        }
        let _ = write.close().await;
    });
    let mut window_start = Instant::now();
    let mut window_count = 0u32;
    while let Some(msg) = read.next().await {
        let text = match msg {
            Ok(Message::Text(t)) => t.to_string(),
            Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(_) => continue, // ping/pong are answered by tungstenite
        };
        if window_start.elapsed() >= Duration::from_secs(1) {
            window_start = Instant::now();
            window_count = 0;
        }
        window_count += 1;
        if window_count > MAX_MESSAGES_PER_SECOND {
            let _ = tx.send(Input::RateLimited(id));
            // Let the error frame go out before the socket closes.
            let _ = tokio::time::timeout(Duration::from_millis(500), writer).await;
            return;
        }
        let _ = tx.send(Input::Message(id, text));
    }
    let _ = tx.send(Input::Disconnect(id));
    writer.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::http::{HeaderMap, HeaderValue};

    #[test]
    fn handshake_rules() {
        let token = SessionToken::fixed(&"a".repeat(64));
        let mut h = HeaderMap::new();
        assert!(authorize(&h, &token).is_err(), "no token");
        h.insert("x-ghostkeys-token", HeaderValue::from_str(&"a".repeat(64)).unwrap());
        assert!(authorize(&h, &token).is_ok());
        h.insert("origin", HeaderValue::from_static("file://"));
        assert!(authorize(&h, &token).is_err(), "any Origin is refused, even file://");
        let mut h = HeaderMap::new();
        h.insert("x-ghostkeys-token", HeaderValue::from_static("wrong"));
        assert!(authorize(&h, &token).is_err());
    }
}
