use serde::Deserialize;
use serde_json::{Value, json};
use worker::{
    D1Database, Env, Fetch, Method, Request, RequestInit, Response, Result, wasm_bindgen::JsValue,
};

use crate::{auth, fail, now, read_json, site};

const LEASE_MS: i64 = 20_000;
const VIEWER_LEASE_MS: i64 = 60_000;

#[derive(Deserialize)]
pub struct Publisher {
    headset_id: String,
    session_id: String,
    video_mid: String,
    audio_mid: String,
    joined_at: i64,
    seen_at: i64,
    video_enabled: i64,
    audio_enabled: i64,
    stats: String,
}

#[derive(Deserialize)]
struct Viewer {
    room_id: String,
    expires_at: i64,
}

#[derive(Deserialize)]
struct Subscription {
    session_id: String,
    mids: String,
}

#[derive(Deserialize)]
struct History {
    at: i64,
    video_bitrate: i64,
}

#[derive(Deserialize)]
struct RelayHistory {
    at: i64,
    headsets: i64,
    viewers: i64,
}

fn field<'a>(body: &'a Value, name: &str) -> &'a str {
    body.get(name).and_then(Value::as_str).unwrap_or_default()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn fresh(publisher: &Publisher) -> bool {
    now() - publisher.seen_at < LEASE_MS
}

async fn publisher(db: &D1Database, id: &str) -> Result<Option<Publisher>> {
    db.prepare("SELECT * FROM publishers WHERE headset_id = ?1")
        .bind(&[JsValue::from_str(id)])?
        .first::<Publisher>(None)
        .await
}

async fn publishers(db: &D1Database) -> Result<Vec<Publisher>> {
    db.prepare("SELECT * FROM publishers WHERE seen_at > ?1 ORDER BY headset_id")
        .bind(&[JsValue::from_f64((now() - LEASE_MS) as f64)])?
        .all()
        .await?
        .results::<Publisher>()
}

async fn viewer(db: &D1Database, token: &str) -> Result<Option<Viewer>> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(None);
    }
    db.prepare("SELECT room_id, expires_at FROM viewers WHERE token_hash = ?1")
        .bind(&[JsValue::from_str(&auth::hash(token))])?
        .first::<Viewer>(None)
        .await
}

async fn allowed(db: &D1Database, room_id: &str, headset: &str) -> Result<bool> {
    Ok(site::room(db, room_id)
        .await?
        .is_some_and(|room| room.headset_id.as_deref().is_none_or(|id| id == headset)))
}

fn clean_sdp(body: &Value, expected: &str) -> bool {
    body["sessionDescription"]["type"] == expected
        && body["sessionDescription"]["sdp"]
            .as_str()
            .is_some_and(|sdp| !sdp.is_empty() && sdp.len() <= 64 * 1024)
}

async fn sfu(env: &Env, method: Method, path: &str, body: Value) -> Result<Value> {
    let app = env.var("SFU_APP_ID")?.to_string();
    let secret = env.secret("SFU_APP_SECRET")?.to_string();
    let mut init = RequestInit::new();
    init.with_method(method);
    if path != "/sessions/new" {
        init.with_body(Some(JsValue::from_str(&body.to_string())));
    }
    let mut request = Request::new_with_init(
        &format!("https://rtc.live.cloudflare.com/v1/apps/{app}{path}"),
        &init,
    )?;
    request
        .headers_mut()?
        .set("Authorization", &format!("Bearer {secret}"))?;
    if path != "/sessions/new" {
        request
            .headers_mut()?
            .set("Content-Type", "application/json")?;
    }
    let mut response = Fetch::Request(request).send().await?;
    let status = response.status_code();
    let result: Value = response.json().await?;
    if !(200..300).contains(&status)
        || result.get("errorCode").is_some()
        || result
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
        || result["tracks"]
            .as_array()
            .is_some_and(|tracks| tracks.iter().any(|track| track.get("errorCode").is_some()))
    {
        return Err(worker::Error::RustError(format!(
            "SFU API rejected {path} with HTTP {status}: {result}"
        )));
    }
    Ok(result)
}

async fn close_tracks(env: &Env, session: &str, mids: &[String]) -> Result<()> {
    if mids.is_empty() {
        return Ok(());
    }
    sfu(
        env,
        Method::Put,
        &format!("/sessions/{session}/tracks/close"),
        json!({
            "tracks": mids.iter().map(|mid| json!({"mid": mid})).collect::<Vec<_>>(),
            "force": true,
        }),
    )
    .await?;
    Ok(())
}

pub async fn start(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    if !auth::same_secret(
        field(&body, "key"),
        &env.secret("PUBLISHER_KEY")?.to_string(),
    ) {
        return fail(401, "Invalid publisher key");
    }
    let headset = field(&body, "headsetId");
    let video_mid = field(&body, "videoMid");
    let audio_mid = field(&body, "audioMid");
    if !valid_id(headset)
        || video_mid.len() > 8
        || audio_mid.len() > 8
        || video_mid.is_empty()
        || audio_mid.is_empty()
        || video_mid == audio_mid
        || !video_mid.bytes().all(|byte| byte.is_ascii_digit())
        || !audio_mid.bytes().all(|byte| byte.is_ascii_digit())
        || !clean_sdp(&body, "offer")
    {
        return fail(400, "Invalid publisher offer");
    }
    let created = sfu(env, Method::Post, "/sessions/new", json!({})).await?;
    let Some(session) = created["sessionId"].as_str() else {
        return fail(502, "SFU did not create a session");
    };
    let published = sfu(
        env,
        Method::Post,
        &format!("/sessions/{session}/tracks/new"),
        json!({
            "sessionDescription": body["sessionDescription"],
            "tracks": [
                {"location": "local", "mid": video_mid, "trackName": "video"},
                {"location": "local", "mid": audio_mid, "trackName": "audio"},
            ],
        }),
    )
    .await?;
    if published["sessionDescription"]["type"] != "answer"
        || published["sessionDescription"]["sdp"].as_str().is_none()
    {
        return fail(502, "SFU did not answer the publisher");
    }
    site::ensure_room(db, headset).await?;
    if let Some(old) = publisher(db, headset).await? {
        let _ = close_tracks(env, &old.session_id, &[old.video_mid, old.audio_mid]).await;
    }
    let at = now();
    db.prepare("INSERT INTO publishers (headset_id, session_id, video_mid, audio_mid, joined_at, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT(headset_id) DO UPDATE SET session_id=excluded.session_id, video_mid=excluded.video_mid, audio_mid=excluded.audio_mid, joined_at=excluded.joined_at, seen_at=excluded.seen_at, stats='{}'")
        .bind(&[JsValue::from_str(headset), JsValue::from_str(session),
            JsValue::from_str(video_mid), JsValue::from_str(audio_mid), JsValue::from_f64(at as f64)])?
        .run().await?;
    Response::from_json(&json!({
        "sessionId": session,
        "sessionDescription": published["sessionDescription"],
    }))
}

pub async fn heartbeat(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    if !auth::same_secret(
        field(&body, "key"),
        &env.secret("PUBLISHER_KEY")?.to_string(),
    ) {
        return fail(401, "Invalid publisher key");
    }
    let id = field(&body, "headsetId");
    let Some(current) = publisher(db, id).await? else {
        return fail(404, "Publisher not found");
    };
    if current.session_id != field(&body, "sessionId") {
        return fail(403, "Publisher session changed");
    }
    let stats = json!({
        "videoPackets": body["videoPackets"].as_u64().unwrap_or(0),
        "audioPackets": body["audioPackets"].as_u64().unwrap_or(0),
        "videoBytes": body["videoBytes"].as_u64().unwrap_or(0),
        "audioBytes": body["audioBytes"].as_u64().unwrap_or(0),
        "videoBitrate": body["videoBitrate"].as_u64().unwrap_or(0),
        "audioBitrate": body["audioBitrate"].as_u64().unwrap_or(0),
        "targetBitrateBps": body["targetBitrateBps"].as_u64().unwrap_or(0),
        "width": body["width"].as_u64().unwrap_or(0),
        "height": body["height"].as_u64().unwrap_or(0),
        "fps": body["fps"].as_u64().unwrap_or(0),
        "encodedFps": body["encodedFps"].as_u64().unwrap_or(0),
        "uplinkLossPercent": body["uplinkLossPercent"].as_i64().unwrap_or(-1),
    });
    let at = now();
    db.prepare(
        "UPDATE publishers SET seen_at = ?1, stats = ?2 WHERE headset_id = ?3 AND session_id = ?4",
    )
    .bind(&[
        JsValue::from_f64(at as f64),
        JsValue::from_str(&stats.to_string()),
        JsValue::from_str(id),
        JsValue::from_str(&current.session_id),
    ])?
    .run()
    .await?;
    db.prepare(
        "INSERT OR IGNORE INTO headset_history (headset_id, at, video_bitrate) VALUES (?1, ?2, ?3)",
    )
    .bind(&[
        JsValue::from_str(id),
        JsValue::from_f64(((at / 10_000) * 10_000) as f64),
        JsValue::from_f64(stats["videoBitrate"].as_u64().unwrap_or(0) as f64),
    ])?
    .run()
    .await?;
    let count = publishers(db).await?.len();
    let viewers = db
        .prepare(
            "SELECT COUNT(*) AS n FROM subscriptions WHERE headset_id = ?1 AND expires_at > ?2",
        )
        .bind(&[JsValue::from_str(id), JsValue::from_f64(at as f64)])?
        .first::<Count>(None)
        .await?
        .map_or(0, |row| row.n);
    Response::from_json(&json!({
        "videoEnabled": current.video_enabled != 0,
        "audioEnabled": current.audio_enabled != 0,
        "publishers": count,
        "viewers": viewers,
        "egressBudgetBps": 200_000_000,
    }))
}

#[derive(Deserialize)]
struct Count {
    n: i64,
}

pub async fn stop(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    if !auth::same_secret(
        field(&body, "key"),
        &env.secret("PUBLISHER_KEY")?.to_string(),
    ) {
        return fail(401, "Invalid publisher key");
    }
    let id = field(&body, "headsetId");
    let Some(current) = publisher(db, id).await? else {
        return Response::from_json(&json!({"ok": true}));
    };
    if current.session_id != field(&body, "sessionId") {
        return fail(403, "Publisher session changed");
    }
    db.prepare("DELETE FROM publishers WHERE headset_id = ?1 AND session_id = ?2")
        .bind(&[
            JsValue::from_str(id),
            JsValue::from_str(&current.session_id),
        ])?
        .run()
        .await?;
    let _ = close_tracks(
        env,
        &current.session_id,
        &[current.video_mid, current.audio_mid],
    )
    .await;
    Response::from_json(&json!({"ok": true}))
}

fn feed(publisher: &Publisher) -> Value {
    json!({
        "headsetId": publisher.headset_id,
        "video": (publisher.video_enabled != 0).then_some("video"),
        "audio": (publisher.audio_enabled != 0).then_some("audio"),
    })
}

async fn visible(db: &D1Database, room_id: &str) -> Result<Vec<Value>> {
    let room = site::room(db, room_id).await?;
    let Some(room) = room else {
        return Ok(Vec::new());
    };
    Ok(publishers(db)
        .await?
        .iter()
        .filter(|publisher| {
            room.headset_id
                .as_deref()
                .is_none_or(|id| id == publisher.headset_id)
        })
        .map(feed)
        .collect())
}

pub async fn join(mut req: Request, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    let token = field(&body, "ticket");
    let Some(viewer) = viewer(db, token).await? else {
        return fail(401, "Viewer ticket invalid");
    };
    if viewer.expires_at <= now() {
        return fail(401, "Viewer ticket expired");
    }
    db.prepare("UPDATE viewers SET expires_at = ?1 WHERE token_hash = ?2")
        .bind(&[
            JsValue::from_f64((now() + 7_200_000) as f64),
            JsValue::from_str(&auth::hash(token)),
        ])?
        .run()
        .await?;
    Response::from_json(&json!({"token": token, "feeds": visible(db, &viewer.room_id).await?}))
}

pub async fn feeds(mut req: Request, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    let token = field(&body, "token");
    let Some(viewer) = viewer(db, token).await? else {
        return fail(401, "Viewer session invalid");
    };
    if viewer.expires_at <= now() {
        return fail(401, "Viewer session expired");
    }
    db.prepare("UPDATE viewers SET expires_at = ?1 WHERE token_hash = ?2 AND expires_at < ?3")
        .bind(&[
            JsValue::from_f64((now() + 7_200_000) as f64),
            JsValue::from_str(&auth::hash(token)),
            JsValue::from_f64((now() + 3_600_000) as f64),
        ])?
        .run()
        .await?;
    db.prepare(
        "UPDATE subscriptions SET expires_at = ?1 WHERE token_hash = ?2 AND expires_at < ?3",
    )
    .bind(&[
        JsValue::from_f64((now() + VIEWER_LEASE_MS) as f64),
        JsValue::from_str(&auth::hash(token)),
        JsValue::from_f64((now() + 20_000) as f64),
    ])?
    .run()
    .await?;
    Response::from_json(&json!({"feeds": visible(db, &viewer.room_id).await?}))
}

pub async fn watch(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    let token = field(&body, "token");
    let headset = field(&body, "headsetId");
    let Some(viewer) = viewer(db, token).await? else {
        return fail(401, "Viewer session invalid");
    };
    if viewer.expires_at <= now() {
        return fail(401, "Viewer session expired");
    }
    if !allowed(db, &viewer.room_id, headset).await? {
        return fail(403, "Feed is outside this room");
    }
    let Some(publisher) = publisher(db, headset).await? else {
        return fail(404, "Feed not live");
    };
    if !fresh(&publisher) {
        return fail(404, "Feed not live");
    }
    let mut tracks = Vec::new();
    if publisher.video_enabled != 0 {
        tracks.push(
            json!({"location": "remote", "sessionId": publisher.session_id, "trackName": "video"}),
        );
    }
    if publisher.audio_enabled != 0 {
        tracks.push(
            json!({"location": "remote", "sessionId": publisher.session_id, "trackName": "audio"}),
        );
    }
    if tracks.is_empty() {
        return fail(409, "Feed is paused");
    }
    let created = sfu(env, Method::Post, "/sessions/new", json!({})).await?;
    let Some(session) = created["sessionId"].as_str() else {
        return fail(502, "SFU did not create a viewer session");
    };
    let response = sfu(
        env,
        Method::Post,
        &format!("/sessions/{session}/tracks/new"),
        json!({"tracks": tracks}),
    )
    .await?;
    if response["sessionDescription"]["type"] != "offer" {
        return fail(502, "SFU did not offer the feed");
    }
    let mids: Vec<String> = response["tracks"].as_array().map_or(Vec::new(), |items| {
        items
            .iter()
            .filter_map(|item| item["mid"].as_str().map(str::to_owned))
            .collect()
    });
    let hash = auth::hash(token);
    if let Some(old) = db
        .prepare(
            "SELECT session_id, mids FROM subscriptions WHERE token_hash = ?1 AND headset_id = ?2",
        )
        .bind(&[JsValue::from_str(&hash), JsValue::from_str(headset)])?
        .first::<Subscription>(None)
        .await?
    {
        let old_mids: Vec<String> = serde_json::from_str(&old.mids).unwrap_or_default();
        let _ = close_tracks(env, &old.session_id, &old_mids).await;
    }
    db.prepare("INSERT INTO subscriptions (token_hash, headset_id, session_id, mids, expires_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(token_hash, headset_id) DO UPDATE SET session_id=excluded.session_id, mids=excluded.mids, expires_at=excluded.expires_at")
        .bind(&[JsValue::from_str(&hash), JsValue::from_str(headset), JsValue::from_str(session),
            JsValue::from_str(&serde_json::to_string(&mids)?), JsValue::from_f64((now() + VIEWER_LEASE_MS) as f64)])?
        .run().await?;
    Response::from_json(
        &json!({"sessionId": session, "sessionDescription": response["sessionDescription"]}),
    )
}

pub async fn answer(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    let token = field(&body, "token");
    let session = field(&body, "sessionId");
    let headset = field(&body, "headsetId");
    let Some(viewer) = viewer(db, token).await? else {
        return fail(401, "Viewer session invalid");
    };
    if viewer.expires_at <= now() || !allowed(db, &viewer.room_id, headset).await? {
        return fail(403, "Viewer session expired or feed denied");
    }
    let registered = db
        .prepare(
            "SELECT session_id, mids FROM subscriptions WHERE token_hash = ?1 AND headset_id = ?2",
        )
        .bind(&[
            JsValue::from_str(&auth::hash(token)),
            JsValue::from_str(headset),
        ])?
        .first::<Subscription>(None)
        .await?;
    if !registered.is_some_and(|row| row.session_id == session) || !clean_sdp(&body, "answer") {
        return fail(400, "Invalid viewer answer");
    }
    sfu(
        env,
        Method::Put,
        &format!("/sessions/{session}/renegotiate"),
        json!({"sessionDescription": body["sessionDescription"]}),
    )
    .await?;
    Response::from_json(&json!({"ok": true}))
}

pub async fn leave(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    let body = read_json(&mut req).await?;
    let token = field(&body, "token");
    let headset = field(&body, "headsetId");
    let session = field(&body, "sessionId");
    let hash = auth::hash(token);
    let registered = db
        .prepare(
            "SELECT session_id, mids FROM subscriptions WHERE token_hash = ?1 AND headset_id = ?2",
        )
        .bind(&[JsValue::from_str(&hash), JsValue::from_str(headset)])?
        .first::<Subscription>(None)
        .await?;
    if let Some(row) = registered.filter(|row| row.session_id == session) {
        db.prepare("DELETE FROM subscriptions WHERE token_hash = ?1 AND headset_id = ?2 AND session_id = ?3")
            .bind(&[JsValue::from_str(&hash), JsValue::from_str(headset),
                JsValue::from_str(session)])?.run().await?;
        let mids: Vec<String> = serde_json::from_str(&row.mids).unwrap_or_default();
        let _ = close_tracks(env, &row.session_id, &mids).await;
    }
    Response::from_json(&json!({"ok": true}))
}

pub async fn toggle(db: &D1Database, id: &str, video: bool, audio: bool) -> Result<Response> {
    let result = db
        .prepare(
            "UPDATE publishers SET video_enabled = ?1, audio_enabled = ?2 WHERE headset_id = ?3",
        )
        .bind(&[
            JsValue::from_f64(i32::from(video) as f64),
            JsValue::from_f64(i32::from(audio) as f64),
            JsValue::from_str(id),
        ])?
        .run()
        .await?;
    if result
        .meta()?
        .is_some_and(|meta| meta.changes.unwrap_or(0) == 0)
    {
        return fail(404, "Headset not found");
    }
    Response::from_json(&json!({"ok": true}))
}

pub async fn snapshot(env: &Env, db: &D1Database) -> Result<Value> {
    let configured = env.secret("SFU_APP_SECRET").is_ok()
        && env.var("SFU_APP_ID").is_ok()
        && env.secret("PUBLISHER_KEY").is_ok();
    let active = publishers(db).await?;
    let subscribers = db
        .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE expires_at > ?1")
        .bind(&[JsValue::from_f64(now() as f64)])?
        .first::<Count>(None)
        .await?
        .map_or(0, |row| row.n);
    let at = (now() / 30_000) * 30_000;
    db.prepare("INSERT OR IGNORE INTO relay_history (at, headsets, viewers) VALUES (?1, ?2, ?3)")
        .bind(&[
            JsValue::from_f64(at as f64),
            JsValue::from_f64(active.len() as f64),
            JsValue::from_f64(subscribers as f64),
        ])?
        .run()
        .await?;
    let history = db
        .prepare("SELECT at, headsets, viewers FROM relay_history WHERE at > ?1 ORDER BY at")
        .bind(&[JsValue::from_f64((now() - 900_000) as f64)])?
        .all()
        .await?
        .results::<RelayHistory>()?
        .into_iter()
        .map(|row| {
            json!({"at": row.at, "healthy": true,
            "headsets": row.headsets, "viewers": row.viewers})
        })
        .collect::<Vec<_>>();
    let first = history
        .first()
        .and_then(|value| value["at"].as_i64())
        .unwrap_or(now());
    let mut headsets = Vec::new();
    for publisher in active {
        let stats: Value = serde_json::from_str(&publisher.stats).unwrap_or(json!({}));
        let trend = db.prepare("SELECT at, video_bitrate FROM headset_history WHERE headset_id = ?1 AND at > ?2 ORDER BY at")
            .bind(&[JsValue::from_str(&publisher.headset_id),
                JsValue::from_f64((now() - 300_000) as f64)])?
            .all().await?.results::<History>()?
            .into_iter().map(|row| json!({"at": row.at, "videoBitrate": row.video_bitrate,
                "queueBytes": null})).collect::<Vec<_>>();
        headsets.push(json!({
            "id": publisher.headset_id,
            "video": (publisher.video_enabled != 0).then_some("video"),
            "audio": (publisher.audio_enabled != 0).then_some("audio"),
            "stats": {
                "video": {"packets": stats["videoPackets"], "bytes": stats["videoBytes"], "bitrate": stats["videoBitrate"]},
                "audio": {"packets": stats["audioPackets"], "bytes": stats["audioBytes"], "bitrate": stats["audioBitrate"]},
            },
            "connectedSeconds": (now() - publisher.joined_at) / 1000,
            "statsAgeMs": now() - publisher.seen_at,
            "controlRttMs": null,
            "videoEnabled": publisher.video_enabled != 0,
            "audioEnabled": publisher.audio_enabled != 0,
            "capture": {"videoEnabled": publisher.video_enabled != 0,
                "audioEnabled": publisher.audio_enabled != 0,
                "queueBytes": null, "targetBitrateBps": stats["targetBitrateBps"],
                "width": stats["width"], "height": stats["height"], "fps": stats["fps"],
                "encodedFps": stats["encodedFps"],
                "uplinkLossPercent": stats["uplinkLossPercent"]},
            "history": trend,
        }));
    }
    Ok(json!({
        "healthy": configured,
        "viewers": subscribers,
        "uptimeSeconds": (now() - first) / 1000,
        "history": history,
        "rtcPort": 0,
        "announcedAddress": "Cloudflare Realtime",
        "headsets": headsets,
    }))
}
