mod auth;
mod media;
mod site;

use serde_json::{Value, json};
use worker::{Context, Env, Method, Request, Response, Result};

fn now() -> i64 {
    worker::js_sys::Date::now() as i64
}

fn fail(status: u16, message: &str) -> Result<Response> {
    Ok(Response::from_json(&json!({"error": message}))?.with_status(status))
}

async fn read_json(req: &mut Request) -> Result<Value> {
    if req
        .headers()
        .get("content-length")?
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > 65_536)
    {
        return Err(worker::Error::RustError(
            "Invalid request: body too large".into(),
        ));
    }
    let body = req.text().await?;
    if body.len() > 65_536 {
        return Err(worker::Error::RustError(
            "Invalid request: body too large".into(),
        ));
    }
    serde_json::from_str(&body)
        .map_err(|_| worker::Error::RustError("Invalid request: expected JSON".into()))
}

async fn route(mut req: Request, env: Env) -> Result<Response> {
    let path = req.path();
    if path == "/health" {
        let ready = env.d1("DB").is_ok()
            && env.secret("SFU_APP_SECRET").is_ok()
            && env.secret("PUBLISHER_KEY").is_ok()
            && env.secret("ADMIN_KEY").is_ok();
        return Ok(Response::from_json(&json!({
            "ok": ready, "media": "Cloudflare Realtime"
        }))?
        .with_status(if ready { 200 } else { 503 }));
    }
    let db = env.d1("DB")?;
    let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
    match (req.method(), parts.as_slice()) {
        (Method::Get, ["api", "site"]) => Response::from_json(&site::site(&db).await?.public()),
        (Method::Get, ["api", "livestream", id]) => match site::room(&db, id).await? {
            Some(room) => Response::from_json(&room.public()),
            None => fail(404, "Room not found"),
        },
        (Method::Post, ["api", "livestream", id, "ticket"]) => {
            let body = read_json(&mut req).await?;
            let address = req.headers().get("CF-Connecting-IP")?.unwrap_or_default();
            site::ticket(
                &db,
                id,
                body["accessCode"].as_str().unwrap_or_default(),
                &address,
            )
            .await
        }
        (Method::Post, ["api", "publisher", "start"]) => media::start(req, &env, &db).await,
        (Method::Post, ["api", "publisher", "heartbeat"]) => media::heartbeat(req, &env, &db).await,
        (Method::Post, ["api", "publisher", "stop"]) => media::stop(req, &env, &db).await,
        (Method::Post, ["api", "viewer", "join"]) => media::join(req, &db).await,
        (Method::Post, ["api", "viewer", "feeds"]) => media::feeds(req, &db).await,
        (Method::Post, ["api", "viewer", "watch"]) => media::watch(req, &env, &db).await,
        (Method::Post, ["api", "viewer", "answer"]) => media::answer(req, &env, &db).await,
        (Method::Post, ["api", "viewer", "leave"]) => media::leave(req, &env, &db).await,
        (Method::Post, ["api", "admin", "login"]) => auth::login(req, &env, &db).await,
        (Method::Post, ["api", "admin", "logout"]) => auth::logout(req, &db).await,
        (Method::Get, ["api", "admin", "auth"]) => Response::from_json(&json!({
            "enabled": false,
            "message": "Passkeys are not available on the Cloudflare test relay yet. Use the admin key"
        })),
        (method, ["api", "admin", ..]) => {
            if !auth::admin(&req, &db).await? {
                return fail(401, "Admin sign-in required");
            }
            if method != Method::Get
                && req.headers().get("sec-fetch-site")?.as_deref() == Some("cross-site")
            {
                return fail(403, "Cross-site request rejected");
            }
            match (method, parts.as_slice()) {
                (Method::Get, ["api", "admin", "state"]) => Response::from_json(&json!({
                    "settings": site::site(&db).await?,
                    "rooms": site::rooms(&db).await?,
                    "relay": media::snapshot(&env, &db).await?,
                })),
                (Method::Get, ["api", "admin", "publisher-key"]) => {
                    Response::from_json(&json!({"key": env.secret("PUBLISHER_KEY")?.to_string()}))
                }
                (Method::Put, ["api", "admin", "settings"]) => {
                    let input =
                        serde_json::from_value(read_json(&mut req).await?).map_err(|_| {
                            worker::Error::RustError("Invalid request: room settings".into())
                        })?;
                    site::update(&db, None, input).await
                }
                (Method::Put, ["api", "admin", "rooms", id]) => {
                    let input =
                        serde_json::from_value(read_json(&mut req).await?).map_err(|_| {
                            worker::Error::RustError("Invalid request: room settings".into())
                        })?;
                    site::update(&db, Some(id), input).await
                }
                (Method::Put, ["api", "admin", "headsets", id, "media"]) => {
                    let input = read_json(&mut req).await?;
                    match (
                        input["videoEnabled"].as_bool(),
                        input["audioEnabled"].as_bool(),
                    ) {
                        (Some(video), Some(audio)) => media::toggle(&db, id, video, audio).await,
                        _ => fail(400, "Invalid media settings"),
                    }
                }
                _ => fail(404, "Admin endpoint not found"),
            }
        }
        _ => fail(404, "API endpoint not found"),
    }
}

#[worker::event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    match route(req, env).await {
        Ok(mut response) => {
            response.headers_mut().set("Cache-Control", "no-store")?;
            Ok(response)
        }
        Err(error) => {
            worker::console_error!("QuestRelay edge error: {error}");
            let message = error.to_string();
            if message.starts_with("Invalid request:") {
                fail(400, &message)
            } else {
                fail(500, "QuestRelay edge request failed")
            }
        }
    }
}

#[worker::event(scheduled)]
pub async fn cleanup(_event: worker::ScheduledEvent, env: Env, _ctx: worker::ScheduleContext) {
    let result = async {
        let db = env.d1("DB")?;
        let expired = worker::wasm_bindgen::JsValue::from_f64(now() as f64);
        for table in ["ticket_attempts", "viewers", "subscriptions", "admins"] {
            db.prepare(format!("DELETE FROM {table} WHERE expires_at < ?1"))
                .bind(std::slice::from_ref(&expired))?
                .run()
                .await?;
        }
        db.prepare("DELETE FROM headset_history WHERE at < ?1")
            .bind(&[worker::wasm_bindgen::JsValue::from_f64(
                (now() - 86_400_000) as f64,
            )])?
            .run()
            .await?;
        db.prepare("DELETE FROM relay_history WHERE at < ?1")
            .bind(&[worker::wasm_bindgen::JsValue::from_f64(
                (now() - 86_400_000) as f64,
            )])?
            .run()
            .await?;
        Ok::<(), worker::Error>(())
    }
    .await;
    if let Err(error) = result {
        worker::console_error!("QuestRelay cleanup failed: {error}")
    }
}
