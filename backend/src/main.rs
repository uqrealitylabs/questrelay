mod config;
mod relay;

use anyhow::{Context, Result};
use axum::Json;
use axum::Router;
use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use relay::{Relay, Request};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::time::{interval, timeout};

#[tokio::main]
async fn main() -> Result<()> {
    let config = config::Config::from_env()?;
    let signal = config.signal;
    let relay = Relay::start(config).await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/relay", get(upgrade))
        .with_state(relay);
    let listener = TcpListener::bind(signal)
        .await
        .with_context(|| format!("Unable to bind signalling at {signal}"))?;
    println!("QuestRelay signalling on {signal}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

async fn health(State(relay): State<Arc<Relay>>) -> impl IntoResponse {
    let healthy = relay.healthy();
    (
        if healthy {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "ok": healthy })),
    )
}

async fn upgrade(ws: WebSocketUpgrade, State(relay): State<Arc<Relay>>) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(error) = session(socket, relay).await {
                eprintln!("Signalling connection ended: {error}");
            }
        })
}

async fn send(socket: &mut WebSocket, value: Value) -> Result<()> {
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn session(mut socket: WebSocket, relay: Arc<Relay>) -> Result<()> {
    let Some(Ok(Message::Text(first))) = timeout(Duration::from_secs(5), socket.recv()).await?
    else {
        return Ok(());
    };
    let request: Request = match serde_json::from_str(first.as_str()) {
        Ok(request) => request,
        Err(_) => {
            send(
                &mut socket,
                json!({"id": null, "ok": false, "error": "Invalid signalling request"}),
            )
            .await?;
            return Ok(());
        }
    };
    let id = request.id;
    let mut updates = relay.subscribe();
    let (mut peer, data) = match relay.join(request.action) {
        Ok(joined) => joined,
        Err(error) => {
            send(
                &mut socket,
                json!({"id": id, "ok": false, "error": error.to_string()}),
            )
            .await?;
            return Ok(());
        }
    };
    send(&mut socket, json!({"id": id, "ok": true, "data": data})).await?;

    let mut heartbeat = interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut awaiting_pong = false;
    loop {
        tokio::select! {
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let request: Request = match serde_json::from_str(text.as_str()) {
                        Ok(request) => request,
                        Err(_) => {
                            send(&mut socket, json!({"id": null, "ok": false, "error": "Invalid signalling request"})).await?;
                            continue;
                        }
                    };
                    let id = request.id;
                    let reply = match peer.handle(request.action).await {
                        Ok(data) => json!({"id": id, "ok": true, "data": data}),
                        Err(error) => json!({"id": id, "ok": false, "error": error.to_string()}),
                    };
                    send(&mut socket, reply).await?;
                }
                Some(Ok(Message::Pong(_))) => awaiting_pong = false,
                Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            changed = updates.changed() => {
                if changed.is_err() {
                    break;
                }
                peer.handle_closed();
                send(&mut socket, json!({"event": "feeds", "feeds": relay.feeds()})).await?;
            }
            _ = heartbeat.tick() => {
                if awaiting_pong {
                    break;
                }
                socket.send(Message::Ping(Vec::new().into())).await?;
                awaiting_pong = true;
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
async fn shutdown() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler is available");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {},
        _ = term.recv() => {},
    }
}

#[cfg(not(unix))]
async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}
