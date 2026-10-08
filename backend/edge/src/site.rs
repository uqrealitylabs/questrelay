use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use worker::{D1Database, Response, Result, wasm_bindgen::JsValue};

use crate::{auth, fail, now};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    base: String,
    accent: String,
    density: String,
    motion: String,
    radius: String,
    surface: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Mascot {
    name: String,
    mood: String,
    accessory: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub id: String,
    title: String,
    is_public: bool,
    access_code: String,
    theme: Theme,
    mascot: Mascot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headset_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    title: String,
    is_public: bool,
    access_code: String,
    theme: Theme,
    mascot: Mascot,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            id: "lounge".into(),
            title: "Headset lounge".into(),
            is_public: true,
            access_code: String::new(),
            theme: Theme {
                base: "dark".into(),
                accent: "#5865f2".into(),
                density: "comfortable".into(),
                motion: "subtle".into(),
                radius: "rounded".into(),
                surface: "solid".into(),
            },
            mascot: Mascot {
                name: "Mochi".into(),
                mood: "playful".into(),
                accessory: "leaf".into(),
            },
            headset_id: None,
        }
    }
}

impl Settings {
    pub fn public(&self) -> Value {
        let mut value = json!({
            "id": self.id,
            "title": self.title,
            "isPublic": self.is_public,
            "theme": self.theme,
            "mascot": self.mascot,
        });
        if let Some(id) = &self.headset_id {
            value["headsetId"] = json!(id)
        }
        value
    }

    fn apply(&mut self, input: SettingsInput) -> std::result::Result<(), &'static str> {
        let title = input.title.trim();
        if title.is_empty() || title.chars().count() > 60 {
            return Err("Title must be 1–60 characters");
        }
        if !input.is_public && !(10..=64).contains(&input.access_code.len()) {
            return Err("Set an access code of 10–64 characters for a private room");
        }
        if !input.access_code.is_empty() && !(10..=64).contains(&input.access_code.len()) {
            return Err("Access code must be 10–64 characters");
        }
        if !["light", "ash", "dark", "onyx", "grove", "lagoon", "dusk"]
            .contains(&input.theme.base.as_str())
        {
            return Err("Invalid base theme");
        }
        if input.theme.accent.len() != 7
            || !input.theme.accent.starts_with('#')
            || !input.theme.accent[1..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Accent must be a hex colour");
        }
        if !["comfortable", "compact"].contains(&input.theme.density.as_str())
            || !["subtle", "quiet"].contains(&input.theme.motion.as_str())
            || !["soft", "rounded", "square"].contains(&input.theme.radius.as_str())
            || !["solid", "translucent"].contains(&input.theme.surface.as_str())
        {
            return Err("Invalid appearance setting");
        }
        if !["playful", "gentle", "sleepy"].contains(&input.mascot.mood.as_str())
            || !["headphones", "leaf", "crown", "none"].contains(&input.mascot.accessory.as_str())
            || input.mascot.name.trim().is_empty()
            || input.mascot.name.chars().count() > 24
        {
            return Err("Invalid capybara setting");
        }
        self.title = title.into();
        self.is_public = input.is_public;
        self.access_code = input.access_code;
        self.theme = input.theme;
        self.mascot = input.mascot;
        Ok(())
    }
}

#[derive(Deserialize)]
struct Row {
    body: String,
}

pub async fn site(db: &D1Database) -> Result<Settings> {
    let row = db
        .prepare("SELECT body FROM state WHERE name = 'site'")
        .first::<Row>(None)
        .await?;
    match row {
        Some(row) => serde_json::from_str(&row.body).map_err(Into::into),
        None => Ok(Settings::default()),
    }
}

pub async fn room(db: &D1Database, id: &str) -> Result<Option<Settings>> {
    let main = site(db).await?;
    if id == main.id {
        return Ok(Some(main));
    }
    let row = db
        .prepare("SELECT body FROM rooms WHERE room_id = ?1")
        .bind(&[JsValue::from_str(id)])?
        .first::<Row>(None)
        .await?;
    row.map(|item| serde_json::from_str(&item.body).map_err(Into::into))
        .transpose()
}

pub async fn rooms(db: &D1Database) -> Result<Vec<Value>> {
    let rows = db
        .prepare("SELECT body FROM rooms ORDER BY headset_id")
        .all()
        .await?
        .results::<Row>()?;
    rows.into_iter()
        .map(|row| {
            let settings: Settings = serde_json::from_str(&row.body)?;
            Ok(json!({"headsetId": settings.headset_id, "settings": settings}))
        })
        .collect()
}

pub async fn ensure_room(db: &D1Database, headset: &str) -> Result<()> {
    let row = db
        .prepare("SELECT body FROM rooms WHERE headset_id = ?1")
        .bind(&[JsValue::from_str(headset)])?
        .first::<Row>(None)
        .await?;
    if row.is_some() {
        return Ok(());
    }
    let mut settings = site(db).await?;
    settings.id = auth::token()?[..8].into();
    settings.title = format!("{headset} stream");
    settings.headset_id = Some(headset.into());
    db.prepare("INSERT OR IGNORE INTO rooms (headset_id, room_id, body) VALUES (?1, ?2, ?3)")
        .bind(&[
            JsValue::from_str(headset),
            JsValue::from_str(&settings.id),
            JsValue::from_str(&serde_json::to_string(&settings)?),
        ])?
        .run()
        .await?;
    Ok(())
}

pub async fn update(db: &D1Database, id: Option<&str>, input: SettingsInput) -> Result<Response> {
    let mut settings = match id {
        Some(id) => match room(db, id).await? {
            Some(settings) if settings.headset_id.is_some() => settings,
            _ => return fail(404, "Room not found"),
        },
        None => site(db).await?,
    };
    if let Err(message) = settings.apply(input) {
        return fail(400, message);
    }
    let body = serde_json::to_string(&settings)?;
    match &settings.headset_id {
        Some(headset) => {
            db.prepare("UPDATE rooms SET body = ?1 WHERE headset_id = ?2")
                .bind(&[JsValue::from_str(&body), JsValue::from_str(headset)])?
                .run()
                .await?;
        }
        None => {
            db.prepare("INSERT INTO state (name, body) VALUES ('site', ?1) ON CONFLICT(name) DO UPDATE SET body = excluded.body")
                .bind(&[JsValue::from_str(&body)])?.run().await?;
        }
    }
    Response::from_json(&json!({"settings": settings}))
}

#[derive(Deserialize)]
struct Attempts {
    count: i64,
}

pub async fn ticket(
    db: &D1Database,
    id: &str,
    access_code: &str,
    address: &str,
) -> Result<Response> {
    let Some(settings) = room(db, id).await? else {
        return fail(404, "Room not found");
    };
    let interval = now() / 600_000;
    let key = auth::hash(&format!("{id}:{address}:{interval}"));
    db.prepare("INSERT INTO ticket_attempts (key, count, expires_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET count = count + 1")
        .bind(&[JsValue::from_str(&key), JsValue::from_f64(((interval + 1) * 600_000) as f64)])?
        .run().await?;
    let attempts = db
        .prepare("SELECT count FROM ticket_attempts WHERE key = ?1")
        .bind(&[JsValue::from_str(&key)])?
        .first::<Attempts>(None)
        .await?
        .map_or(0, |row| row.count);
    if attempts > if settings.is_public { 60 } else { 5 } {
        return fail(429, "Too many joins; try again shortly");
    }
    if !settings.is_public {
        let valid = access_code.len() == settings.access_code.len()
            && access_code
                .as_bytes()
                .ct_eq(settings.access_code.as_bytes())
                .into();
        if !valid {
            return fail(403, "Invalid access code");
        }
    }
    let ticket = auth::token()?;
    db.prepare("INSERT INTO viewers (token_hash, room_id, expires_at) VALUES (?1, ?2, ?3)")
        .bind(&[
            JsValue::from_str(&auth::hash(&ticket)),
            JsValue::from_str(id),
            JsValue::from_f64((now() + 30_000) as f64),
        ])?
        .run()
        .await?;
    Response::from_json(&json!({"ticket": ticket}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_room_needs_a_long_code_and_public_settings_hide_it() {
        let mut room = Settings::default();
        let theme = room.theme.clone();
        let mascot = room.mascot.clone();
        let input = |code: &str| SettingsInput {
            title: "Quest demo".into(),
            is_public: false,
            access_code: code.into(),
            theme: theme.clone(),
            mascot: mascot.clone(),
        };
        assert!(room.apply(input("short")).is_err());
        assert!(room.is_public);
        assert!(room.apply(input("longer-code-123")).is_ok());
        assert!(!room.is_public);
        assert!(room.public().get("accessCode").is_none());
    }
}
