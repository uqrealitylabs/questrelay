mod auth;
mod config;
mod relay;
mod site;

use anyhow::{Context, Result};
use auth::Auth;
use axum::Json;
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, post, put};
use relay::{Action, Relay, Request, Role};
use serde::Deserialize;
use serde_json::{Value, json};
use site::{RoomAccess, SettingsInput, Site};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::net::TcpListener;
use tokio::time::{interval, timeout};
use webauthn_rs::prelude::{PublicKeyCredential, RegisterPublicKeyCredential, Uuid};

#[tokio::main]
async fn main() -> Result<()> {
    let config = config::Config::from_env()?;
    let signal = config.signal;
    let site = Site::from_env(&config.viewer_key, &config.publisher_key)?;
    let auth_path =
        std::env::var("QUESTRELAY_STATE_PATH").unwrap_or_else(|_| "data/site.json".into());
    let auth_path = std::path::Path::new(&auth_path).with_file_name("auth.json");
    let auth = Auth::open(auth_path, std::env::var("QUESTRELAY_WEBAUTHN_ORIGIN").ok())?;
    let relay = Relay::start(config).await?;
    let state = Arc::new(AppState { relay, site, auth });
    let app = Router::new()
        .route("/health", get(health))
        .route("/ws/relay", get(upgrade))
        .route("/api/site", get(site_info))
        .route("/api/livestream/{id}", get(room))
        .route("/api/livestream/{id}/ticket", post(ticket))
        .route("/api/admin/login", post(login))
        .route("/api/admin/logout", post(logout))
        .route("/api/admin/state", get(admin_state))
        .route("/api/admin/publisher-key", get(publisher_key))
        .route("/api/admin/settings", put(update_settings))
        .route("/api/admin/rooms/{id}", put(update_room))
        .route("/api/admin/headsets/{id}/media", put(update_media))
        .route("/api/admin/auth", get(auth_state))
        .route("/api/admin/passkeys/login/start", post(passkey_login_start))
        .route(
            "/api/admin/passkeys/login/finish",
            post(passkey_login_finish),
        )
        .route(
            "/api/admin/passkeys/register/start",
            post(passkey_register_start),
        )
        .route(
            "/api/admin/passkeys/register/finish",
            post(passkey_register_finish),
        )
        .route(
            "/api/admin/passkeys/{id}",
            axum::routing::delete(remove_passkey),
        )
        .route("/api/admin/accounts", post(add_admin))
        .route(
            "/api/admin/accounts/{id}",
            put(rename_admin).delete(remove_admin),
        )
        .route("/api/admin/accounts/{id}/invite", post(invite_admin))
        .with_state(state);
    let listener = TcpListener::bind(signal)
        .await
        .with_context(|| format!("Unable to bind signalling at {signal}"))?;
    println!("QuestRelay signalling on {signal}");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

struct AppState {
    relay: Arc<Relay>,
    site: Site,
    auth: Auth,
}

type ApiError = (StatusCode, Json<Value>);

fn api_error(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error": message})))
}

fn admin_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|cookie| cookie.strip_prefix("qr_admin="))
}

fn require_admin<'a>(state: &AppState, headers: &'a HeaderMap) -> Result<&'a str, ApiError> {
    let token = admin_token(headers).unwrap_or_default();
    if state.site.admin(token) || state.auth.identity(token).is_some() {
        Ok(token)
    } else {
        Err(api_error(
            StatusCode::UNAUTHORIZED,
            "Admin sign-in required",
        ))
    }
}

fn admin_identity(state: &AppState, headers: &HeaderMap) -> Result<(Uuid, bool), ApiError> {
    let token = require_admin(state, headers)?;
    let id = if state.site.admin(token) {
        Uuid::nil()
    } else {
        state
            .auth
            .identity(token)
            .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Admin sign-in required"))?
    };
    Ok((id, id == Uuid::nil()))
}

fn require_owner(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if admin_identity(state, headers)?.1 {
        Ok(())
    } else {
        Err(api_error(StatusCode::FORBIDDEN, "Owner access required"))
    }
}

fn session_cookie(headers: &HeaderMap, token: &str) -> String {
    let secure = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("https://"));
    format!(
        "qr_admin={token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800{}",
        if secure { "; Secure" } else { "" }
    )
}

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let healthy = state.relay.healthy();
    (
        if healthy {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(json!({ "ok": healthy })),
    )
}

async fn room(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> Result<Json<Value>, ApiError> {
    state
        .site
        .room_view(&id)
        .map(Json)
        .ok_or_else(|| api_error(StatusCode::NOT_FOUND, "Room not found"))
}

async fn site_info(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(state.site.settings().public_view())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TicketInput {
    access_code: Option<String>,
}

async fn ticket(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(input): Json<TicketInput>,
) -> Result<Json<Value>, ApiError> {
    let ticket = state
        .site
        .issue_ticket(&id, input.access_code.as_deref().unwrap_or_default())
        .map_err(|error| api_error(StatusCode::FORBIDDEN, &error.to_string()))?;
    Ok(Json(json!({"ticket": ticket})))
}

#[derive(Deserialize)]
struct LoginInput {
    key: String,
}

async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<LoginInput>,
) -> Result<impl IntoResponse, ApiError> {
    let token = state
        .site
        .login(&input.key)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Invalid admin key"))?;
    let cookie = session_cookie(&headers, &token);
    Ok(([(header::SET_COOKIE, cookie)], Json(json!({"ok": true}))))
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> impl IntoResponse {
    if let Some(token) = admin_token(&headers) {
        state.site.logout(token);
        state.auth.logout(token);
    }
    (
        [(
            header::SET_COOKIE,
            "qr_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0",
        )],
        Json(json!({"ok": true})),
    )
}

async fn admin_state(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_admin(&state, &headers)?;
    Ok(Json(json!({
        "settings": state.site.settings(),
        "rooms": state.site.rooms_snapshot(),
        "relay": state.relay.admin_snapshot(),
    })))
}

async fn publisher_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_admin(&state, &headers)?;
    Ok(Json(json!({"key": state.relay.publisher_key()})))
}

async fn update_settings(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&state, &headers)?;
    let settings = state
        .site
        .update(input)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"settings": settings})))
}

async fn update_room(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<SettingsInput>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&state, &headers)?;
    let settings = state
        .site
        .update_room(&id, input)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"settings": settings})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaInput {
    video_enabled: bool,
    audio_enabled: bool,
}

async fn update_media(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<MediaInput>,
) -> Result<Json<Value>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .relay
        .set_media(&id, input.video_enabled, input.audio_enabled)
        .map_err(|error| api_error(StatusCode::NOT_FOUND, &error.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn auth_state(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Json<Value> {
    match admin_identity(&state, &headers) {
        Ok((id, owner)) => Json(state.auth.snapshot(id, owner)),
        Err(_) => Json(json!({"enabled": state.auth.enabled()})),
    }
}

#[derive(Deserialize)]
struct PasskeyName {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationInput {
    label: String,
    invite_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialInput {
    challenge_id: String,
    credential: Value,
}

async fn passkey_login_start(
    State(state): State<Arc<AppState>>,
    Json(input): Json<PasskeyName>,
) -> Result<Json<Value>, ApiError> {
    state.auth.start_login(&input.name).map(Json).map_err(|_| {
        api_error(
            StatusCode::BAD_REQUEST,
            "No passkey available for this admin",
        )
    })
}

async fn passkey_login_finish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CredentialInput>,
) -> Result<impl IntoResponse, ApiError> {
    let credential: PublicKeyCredential = serde_json::from_value(input.credential)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "Invalid passkey response"))?;
    let token = state
        .auth
        .finish_login(&input.challenge_id, credential)
        .map_err(|_| api_error(StatusCode::UNAUTHORIZED, "Passkey verification failed"))?;
    Ok((
        [(header::SET_COOKIE, session_cookie(&headers, &token))],
        Json(json!({"ok": true})),
    ))
}

async fn passkey_register_start(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<RegistrationInput>,
) -> Result<Json<Value>, ApiError> {
    let current = if input.invite_token.is_some() {
        None
    } else {
        Some(admin_identity(&state, &headers)?.0)
    };
    state
        .auth
        .start_register(current, input.invite_token.as_deref(), &input.label)
        .map(Json)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))
}

async fn passkey_register_finish(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<CredentialInput>,
) -> Result<impl IntoResponse, ApiError> {
    let credential: RegisterPublicKeyCredential = serde_json::from_value(input.credential)
        .map_err(|_| api_error(StatusCode::BAD_REQUEST, "Invalid passkey response"))?;
    let current = admin_identity(&state, &headers)
        .ok()
        .map(|identity| identity.0);
    let token = state
        .auth
        .finish_register(current, &input.challenge_id, credential)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok((
        [(header::SET_COOKIE, session_cookie(&headers, &token))],
        Json(json!({"ok": true})),
    ))
}

async fn remove_passkey(
    Path(id): Path<String>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let (current, _) = admin_identity(&state, &headers)?;
    state
        .auth
        .remove_key(current, &id)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn add_admin(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PasskeyName>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers)?;
    let (id, invite) = state
        .auth
        .add_admin(&input.name)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"id": id, "inviteToken": invite})))
}

async fn rename_admin(
    Path(id): Path<Uuid>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<PasskeyName>,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers)?;
    state
        .auth
        .rename_admin(id, &input.name)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn remove_admin(
    Path(id): Path<Uuid>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers)?;
    state
        .auth
        .remove_admin(id)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"ok": true})))
}

async fn invite_admin(
    Path(id): Path<Uuid>,
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    require_owner(&state, &headers)?;
    let invite = state
        .auth
        .invite(id)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, &error.to_string()))?;
    Ok(Json(json!({"inviteToken": invite})))
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| async move {
            if let Err(error) = session(socket, state).await {
                eprintln!("Signalling connection ended: {error}");
            }
        })
}

async fn send(socket: &mut WebSocket, value: Value) -> Result<()> {
    socket.send(Message::Text(value.to_string().into())).await?;
    Ok(())
}

async fn session(mut socket: WebSocket, state: Arc<AppState>) -> Result<()> {
    let Some(Ok(Message::Text(first))) = timeout(Duration::from_secs(5), socket.recv()).await?
    else {
        return Ok(());
    };
    let mut request: Request = match serde_json::from_str(first.as_str()) {
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
    let is_viewer = matches!(
        &request.action,
        Action::Join {
            role: Role::Viewer,
            ..
        }
    );
    let published_headset = match &request.action {
        Action::Join {
            role: Role::Publisher,
            headset_id,
            ..
        } => headset_id.clone(),
        _ => None,
    };
    let mut allowed_feed = None;
    if let Action::Join {
        role: Role::Viewer,
        key,
        ..
    } = &mut request.action
    {
        allowed_feed = state.site.redeem(key).and_then(|access| match access {
            RoomAccess::All => None,
            RoomAccess::Headset(id) => Some(id),
        });
    }
    let mut updates = state.relay.subscribe();
    let mut revocations = state.site.subscribe_revocations();
    let joined = state
        .relay
        .join_scoped(request.action, allowed_feed)
        .and_then(|joined| {
            if let Some(id) = &published_headset {
                state.site.ensure_feed_room(id)?;
            }
            Ok(joined)
        });
    let (mut peer, data) = match joined {
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
    if let Some(control) = peer.capture_control() {
        send(&mut socket, control).await?;
    }

    let mut heartbeat = interval(Duration::from_secs(30));
    heartbeat.tick().await;
    let mut awaiting_pong = false;
    let mut ping_sent_at = None;
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
                Some(Ok(Message::Pong(_))) => {
                    awaiting_pong = false;
                    if let Some(sent_at) = ping_sent_at.take() {
                        peer.record_control_rtt(Instant::now() - sent_at);
                    }
                }
                Some(Ok(Message::Ping(payload))) => socket.send(Message::Pong(payload)).await?,
                Some(Ok(Message::Binary(packet))) => peer.ingest_rtp(packet.to_vec())?,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            },
            changed = updates.changed() => {
                if changed.is_err() {
                    break;
                }
                peer.handle_closed();
                send(&mut socket, json!({"event": "feeds", "feeds": peer.feeds()})).await?;
                if let Some(control) = peer.capture_control() {
                    send(&mut socket, control).await?;
                }
            }
            _ = revocations.changed(), if is_viewer => {
                break;
            }
            _ = heartbeat.tick() => {
                if awaiting_pong {
                    break;
                }
                socket.send(Message::Ping(Vec::new().into())).await?;
                awaiting_pong = true;
                ping_sent_at = Some(Instant::now());
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
