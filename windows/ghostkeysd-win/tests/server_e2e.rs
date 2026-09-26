//! A real WebSocket session against the server on 127.0.0.1, with the mock platform.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use ghostkeysd_win::platform::mock::test_platform;
use ghostkeysd_win::platform::MotionInfo;
use ghostkeysd_win::security::SessionToken;
use ghostkeysd_win::server::{self, ServerOptions, MAX_CLIENTS};
use ghostkeysd_win::store::ConfigStore;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn start(name: &str) -> (u16, oneshot::Sender<()>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ghostkeys-e2e-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let listener = server::bind(0).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (platform, _mocks) = test_platform(MotionInfo::default(), false, false);
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let store = ConfigStore::new(&dir);
    tokio::spawn(async move {
        server::run(listener, platform, store, SessionToken::fixed(TOKEN), ServerOptions { dry_run: false }, async {
            let _ = stop_rx.await;
        })
        .await;
    });
    (port, stop_tx, dir)
}

async fn connect(port: u16, token: Option<&str>, origin: Option<&str>) -> Result<Ws, String> {
    let mut req = format!("ws://127.0.0.1:{port}/").into_client_request().unwrap();
    if let Some(t) = token {
        req.headers_mut().insert("X-Ghostkeys-Token", t.parse().unwrap());
    }
    if let Some(o) = origin {
        req.headers_mut().insert("Origin", o.parse().unwrap());
    }
    tokio_tungstenite::connect_async(req).await.map(|(ws, _)| ws).map_err(|e| e.to_string())
}

async fn next_json(ws: &mut Ws) -> Value {
    loop {
        let m = tokio::time::timeout(Duration::from_secs(3), ws.next()).await.expect("a message in time").expect("open").expect("ok");
        if let Message::Text(t) = m {
            return serde_json::from_str(&t).unwrap();
        }
    }
}

/// Next message of the given type, skipping periodic status and others.
async fn next_of(ws: &mut Ws, ty: &str) -> Value {
    loop {
        let v = next_json(ws).await;
        if v["type"] == ty {
            return v;
        }
    }
}

#[tokio::test]
async fn handshake_needs_the_token_and_no_origin() {
    let (port, stop, dir) = start("auth").await;
    assert!(connect(port, None, None).await.is_err(), "no token");
    assert!(connect(port, Some("wrong"), None).await.is_err(), "wrong token");
    assert!(connect(port, Some(TOKEN), Some("https://example.com")).await.is_err(), "browser origin");
    assert!(connect(port, Some(TOKEN), Some("file://")).await.is_err(), "any origin");
    assert!(connect(port, Some(TOKEN), None).await.is_ok());
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn a_session_greets_runs_actions_and_serves_config() {
    let (port, stop, dir) = start("session").await;
    let mut ws = connect(port, Some(TOKEN), None).await.unwrap();
    let hello = next_json(&mut ws).await;
    assert_eq!(hello["type"], "hello");
    assert_eq!(hello["version"], "0.1.0");
    assert_eq!(hello["sensors"]["imu"], false);
    assert_eq!(next_json(&mut ws).await["type"], "status");
    let config = next_json(&mut ws).await;
    assert_eq!(config["type"], "config");
    assert_eq!(config["config"]["zones"][0]["id"], "anywhere");

    ws.send(Message::text(json!({"type":"test_action","action":{"kind":"mute","label":"Mute it"}}).to_string())).await.unwrap();
    let action = next_of(&mut ws, "action").await;
    assert_eq!(action["ok"], true);
    assert_eq!(action["label"], "Mute it");
    assert_eq!(action["bindingId"], Value::Null);
    assert_eq!(action["error"], Value::Null);

    ws.send(Message::text(r#"{"type":"config_get"}"#)).await.unwrap();
    assert_eq!(next_of(&mut ws, "config").await["config"]["version"], 1);

    ws.send(Message::text("{oops")).await.unwrap();
    assert_eq!(next_of(&mut ws, "error").await["message"], "invalid JSON");

    ws.send(Message::text(r#"{"type":"pause"}"#)).await.unwrap();
    let status = next_of(&mut ws, "status").await;
    assert_eq!(status["paused"], true);
    assert_eq!(status["pausedReason"], "user");
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn flooding_client_is_disconnected() {
    let (port, stop, dir) = start("flood").await;
    let mut ws = connect(port, Some(TOKEN), None).await.unwrap();
    for _ in 0..3 {
        next_json(&mut ws).await;
    }
    for _ in 0..260 {
        if ws.send(Message::text(r#"{"type":"unsubscribe","streams":[]}"#)).await.is_err() {
            break;
        }
    }
    let mut saw_error = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(3), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                if t.contains("rate limit exceeded") {
                    saw_error = true;
                }
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) | Ok(None) => break, // closed
            Err(_) => panic!("the server did not close the flooding client"),
        }
    }
    assert!(saw_error);
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn at_most_eight_clients() {
    let (port, stop, dir) = start("max").await;
    let mut open = vec![];
    for _ in 0..MAX_CLIENTS {
        let mut ws = connect(port, Some(TOKEN), None).await.unwrap();
        next_json(&mut ws).await;
        open.push(ws);
    }
    assert!(connect(port, Some(TOKEN), None).await.is_err(), "the ninth is refused");
    drop(open.pop());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(connect(port, Some(TOKEN), None).await.is_ok(), "a slot frees up when one leaves");
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(dir);
}
