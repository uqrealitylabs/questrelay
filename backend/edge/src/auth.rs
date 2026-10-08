use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use wasm_bindgen::{JsCast, JsValue};
use worker::{D1Database, Env, Request, Response, Result, js_sys, wasm_bindgen};

use crate::{fail, now};

pub fn same_secret(actual: &str, expected: &str) -> bool {
    actual.len() == expected.len() && actual.as_bytes().ct_eq(expected.as_bytes()).into()
}

pub fn token() -> Result<String> {
    let crypto = js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str("crypto"))?;
    let random = js_sys::Reflect::get(&crypto, &JsValue::from_str("getRandomValues"))?
        .dyn_into::<js_sys::Function>()?;
    let array = js_sys::Uint8Array::new_with_length(32);
    random.call1(&crypto, array.as_ref())?;
    let mut bytes = [0u8; 32];
    array.copy_to(&mut bytes);
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cookie(req: &Request) -> Result<Option<String>> {
    Ok(req.headers().get("cookie")?.and_then(|header| {
        header
            .split(';')
            .map(str::trim)
            .find_map(|part| part.strip_prefix("qr_admin=").map(str::to_owned))
    }))
}

#[derive(serde::Deserialize)]
struct Session {
    expires_at: i64,
}

pub async fn admin(req: &Request, db: &D1Database) -> Result<bool> {
    let Some(token) = cookie(req)? else {
        return Ok(false);
    };
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(false);
    }
    let row = db
        .prepare("SELECT expires_at FROM admins WHERE token_hash = ?1")
        .bind(&[JsValue::from_str(&hash(&token))])?
        .first::<Session>(None)
        .await?;
    Ok(row.is_some_and(|session| session.expires_at > now()))
}

fn is_cross_site(req: &Request) -> Result<bool> {
    Ok(req.headers().get("sec-fetch-site")?.as_deref() == Some("cross-site"))
}

pub async fn login(mut req: Request, env: &Env, db: &D1Database) -> Result<Response> {
    if is_cross_site(&req)? {
        return fail(403, "Cross-site sign-in rejected");
    }
    let input = crate::read_json(&mut req).await?;
    let key = input["key"].as_str().unwrap_or_default();
    let expected = env.secret("ADMIN_KEY")?.to_string();
    if expected.len() < 32 || !same_secret(key, &expected) {
        return fail(401, "Invalid admin key");
    }
    let token = token()?;
    db.prepare("INSERT INTO admins (token_hash, expires_at) VALUES (?1, ?2)")
        .bind(&[
            JsValue::from_str(&hash(&token)),
            JsValue::from_f64((now() + 28_800_000) as f64),
        ])?
        .run()
        .await?;
    let mut response = Response::from_json(&serde_json::json!({"ok": true}))?;
    response.headers_mut().set(
        "Set-Cookie",
        &format!(
            "qr_admin={token}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=28800"
        ),
    )?;
    Ok(response)
}

pub async fn logout(req: Request, db: &D1Database) -> Result<Response> {
    if is_cross_site(&req)? {
        return fail(403, "Cross-site request rejected");
    }
    if let Some(token) = cookie(&req)? {
        db.prepare("DELETE FROM admins WHERE token_hash = ?1")
            .bind(&[JsValue::from_str(&hash(&token))])?
            .run()
            .await?;
    }
    let mut response = Response::from_json(&serde_json::json!({"ok": true}))?;
    response.headers_mut().set(
        "Set-Cookie",
        "qr_admin=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0",
    )?;
    Ok(response)
}
