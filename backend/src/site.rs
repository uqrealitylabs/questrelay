use anyhow::{Context, Result, ensure};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

const SESSION_LIFE: Duration = Duration::from_secs(8 * 60 * 60);
const TICKET_LIFE: Duration = Duration::from_secs(30);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub base: String,
    pub accent: String,
    pub density: String,
    pub motion: String,
    #[serde(default = "default_radius")]
    pub radius: String,
    #[serde(default = "default_surface")]
    pub surface: String,
}

fn default_radius() -> String {
    "rounded".into()
}
fn default_surface() -> String {
    "solid".into()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub id: String,
    pub title: String,
    pub is_public: bool,
    pub access_code: String,
    pub theme: Theme,
    #[serde(default)]
    pub mascot: Mascot,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mascot {
    pub mood: String,
    pub accessory: String,
    pub name: String,
}

impl Default for Mascot {
    fn default() -> Self {
        Self {
            mood: "playful".into(),
            accessory: "leaf".into(),
            name: "Mochi".into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub title: String,
    pub is_public: bool,
    pub access_code: String,
    pub theme: Theme,
    #[serde(default)]
    pub mascot: Mascot,
}

impl Settings {
    fn new() -> Self {
        const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
        let mut bytes = [0u8; 6];
        rand::fill(&mut bytes[..]);
        Self {
            id: bytes
                .iter()
                .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
                .collect(),
            title: "Headset lounge".into(),
            is_public: false,
            access_code: String::new(),
            theme: Theme {
                base: "dark".into(),
                accent: "#5865f2".into(),
                density: "comfortable".into(),
                motion: "subtle".into(),
                radius: default_radius(),
                surface: default_surface(),
            },
            mascot: Mascot::default(),
        }
    }

    fn update(&mut self, input: SettingsInput) -> Result<()> {
        let title = input.title.trim();
        ensure!(
            !title.is_empty() && title.chars().count() <= 60,
            "Title must be 1–60 characters"
        );
        ensure!(
            input.access_code.is_empty() || (10..=64).contains(&input.access_code.len()),
            "Access code must be 10–64 characters"
        );
        ensure!(
            input.is_public || !input.access_code.is_empty(),
            "Set an access code before making this room private"
        );
        ensure!(
            ["light", "ash", "dark", "onyx", "grove", "lagoon", "dusk"]
                .contains(&input.theme.base.as_str()),
            "Invalid base theme"
        );
        ensure!(
            input.theme.accent.len() == 7
                && input.theme.accent.starts_with('#')
                && input.theme.accent[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()),
            "Accent must be a hex colour"
        );
        ensure!(
            ["comfortable", "compact"].contains(&input.theme.density.as_str()),
            "Invalid density"
        );
        ensure!(
            ["subtle", "quiet"].contains(&input.theme.motion.as_str()),
            "Invalid motion setting"
        );
        ensure!(
            ["soft", "rounded", "square"].contains(&input.theme.radius.as_str()),
            "Invalid corner style"
        );
        ensure!(
            ["solid", "translucent"].contains(&input.theme.surface.as_str()),
            "Invalid surface style"
        );
        ensure!(
            ["playful", "gentle", "sleepy"].contains(&input.mascot.mood.as_str()),
            "Invalid capybara mood"
        );
        ensure!(
            ["headphones", "leaf", "crown", "none"].contains(&input.mascot.accessory.as_str()),
            "Invalid capybara accessory"
        );
        let name = input.mascot.name.trim().to_owned();
        ensure!(
            !name.is_empty() && name.chars().count() <= 24,
            "Capybara name must be 1–24 characters"
        );
        self.title = title.into();
        self.is_public = input.is_public;
        self.access_code = input.access_code;
        self.theme = input.theme;
        self.mascot = Mascot {
            name,
            ..input.mascot
        };
        Ok(())
    }

    pub fn public_view(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "isPublic": self.is_public,
            "theme": self.theme,
            "mascot": self.mascot,
        })
    }
}

pub struct Site {
    path: PathBuf,
    rooms_path: PathBuf,
    settings: Mutex<Settings>,
    rooms: Mutex<HashMap<String, FeedRoom>>,
    admin_key: String,
    viewer_key: String,
    sessions: Mutex<HashMap<String, Instant>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    failed_codes: Mutex<Vec<Instant>>,
    revocations: watch::Sender<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct FeedRoom {
    headset_id: String,
    settings: Settings,
}

#[derive(Clone)]
pub enum RoomAccess {
    All,
    Headset(String),
}

struct Ticket {
    expires: Instant,
    access: RoomAccess,
}

impl Site {
    pub fn from_env(viewer_key: &str, publisher_key: &str) -> Result<Self> {
        let admin_key =
            std::env::var("QUESTRELAY_ADMIN_KEY").context("QUESTRELAY_ADMIN_KEY required")?;
        ensure!(
            admin_key.len() >= 32 && admin_key != viewer_key && admin_key != publisher_key,
            "Configure a distinct admin key of at least 32 bytes"
        );
        let path = std::env::var("QUESTRELAY_STATE_PATH")
            .unwrap_or_else(|_| "data/site.json".into())
            .into();
        Self::open(path, admin_key, viewer_key.into())
    }

    fn open(path: PathBuf, admin_key: String, viewer_key: String) -> Result<Self> {
        let settings = if path.exists() {
            serde_json::from_slice(&fs::read(&path).context("Unable to read room settings")?)
                .context("Invalid room settings")?
        } else {
            let settings = Settings::new();
            persist(&path, &settings)?;
            settings
        };
        let rooms_path = path.with_file_name("rooms.json");
        let rooms = if rooms_path.exists() {
            serde_json::from_slice(&fs::read(&rooms_path).context("Unable to read feed rooms")?)
                .context("Invalid feed rooms")?
        } else {
            HashMap::new()
        };
        let (revocations, _) = watch::channel(0);
        Ok(Self {
            path,
            rooms_path,
            settings: Mutex::new(settings),
            rooms: Mutex::new(rooms),
            admin_key,
            viewer_key,
            sessions: Mutex::new(HashMap::new()),
            tickets: Mutex::new(HashMap::new()),
            failed_codes: Mutex::new(Vec::new()),
            revocations,
        })
    }

    pub fn settings(&self) -> Settings {
        self.settings.lock().clone()
    }

    pub fn room_view(&self, id: &str) -> Option<Value> {
        let main = self.settings();
        if main.id == id {
            return Some(main.public_view());
        }
        self.rooms.lock().get(id).map(|room| {
            let mut view = room.settings.public_view();
            view["headsetId"] = json!(room.headset_id);
            view
        })
    }

    pub fn rooms_snapshot(&self) -> Value {
        let mut rooms: Vec<_> = self
            .rooms
            .lock()
            .values()
            .map(|room| json!({"headsetId": room.headset_id, "settings": room.settings}))
            .collect();
        rooms.sort_unstable_by(|a, b| a["headsetId"].as_str().cmp(&b["headsetId"].as_str()));
        json!(rooms)
    }

    pub fn ensure_feed_room(&self, headset_id: &str) -> Result<()> {
        let main = self.settings();
        let mut rooms = self.rooms.lock();
        if rooms.values().any(|room| room.headset_id == headset_id) {
            return Ok(());
        }
        let mut settings = main.clone();
        settings.id = Settings::new().id;
        while rooms.contains_key(&settings.id) || settings.id == main.id {
            settings.id = Settings::new().id;
        }
        settings.title = format!("{headset_id} stream");
        let mut updated = rooms.clone();
        updated.insert(
            settings.id.clone(),
            FeedRoom {
                headset_id: headset_id.into(),
                settings,
            },
        );
        persist(&self.rooms_path, &updated)?;
        *rooms = updated;
        Ok(())
    }

    pub fn update_room(&self, id: &str, input: SettingsInput) -> Result<Settings> {
        if self.settings.lock().id == id {
            return self.update(input);
        }
        let mut rooms = self.rooms.lock();
        let mut updated = rooms.clone();
        let room = updated.get_mut(id).context("Feed room not found")?;
        let old_public = room.settings.is_public;
        let old_code = room.settings.access_code.clone();
        room.settings.update(input)?;
        let settings = room.settings.clone();
        let revoke = old_public != settings.is_public || old_code != settings.access_code;
        persist(&self.rooms_path, &updated)?;
        *rooms = updated;
        self.tickets.lock().clear();
        if revoke {
            self.revocations
                .send_modify(|version| *version = version.wrapping_add(1));
        }
        Ok(settings)
    }

    pub fn update(&self, input: SettingsInput) -> Result<Settings> {
        let mut settings = self.settings.lock();
        let mut updated = settings.clone();
        updated.update(input)?;
        persist(&self.path, &updated)?;
        let revoke =
            settings.is_public != updated.is_public || settings.access_code != updated.access_code;
        *settings = updated.clone();
        self.tickets.lock().clear();
        if revoke {
            self.revocations
                .send_modify(|version| *version = version.wrapping_add(1));
        }
        Ok(updated)
    }

    pub fn subscribe_revocations(&self) -> watch::Receiver<u64> {
        self.revocations.subscribe()
    }

    pub fn login(&self, key: &str) -> Option<String> {
        if key.len() != self.admin_key.len()
            || !bool::from(key.as_bytes().ct_eq(self.admin_key.as_bytes()))
        {
            return None;
        }
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, expires| *expires > Instant::now());
        if sessions.len() >= 32 {
            return None;
        }
        let token = random_token();
        sessions.insert(token.clone(), Instant::now() + SESSION_LIFE);
        Some(token)
    }

    pub fn admin(&self, token: &str) -> bool {
        self.sessions
            .lock()
            .get(token)
            .is_some_and(|expires| *expires > Instant::now())
    }

    pub fn logout(&self, token: &str) {
        self.sessions.lock().remove(token);
    }

    pub fn issue_ticket(&self, id: &str, code: &str) -> Result<String> {
        let main = self.settings();
        let (settings, access) = if main.id == id {
            (main, RoomAccess::All)
        } else {
            let rooms = self.rooms.lock();
            let room = rooms.get(id).context("Room not found")?;
            (
                room.settings.clone(),
                RoomAccess::Headset(room.headset_id.clone()),
            )
        };
        if !settings.is_public {
            let mut attempts = self.failed_codes.lock();
            attempts.retain(|at| at.elapsed() < Duration::from_secs(60));
            ensure!(
                attempts.len() < 20,
                "Too many access attempts; try again shortly"
            );
            let expected = settings.access_code.as_bytes();
            if expected.is_empty()
                || expected.len() != code.len()
                || !bool::from(expected.ct_eq(code.as_bytes()))
            {
                attempts.push(Instant::now());
                anyhow::bail!("Incorrect access code");
            }
        }
        let mut tickets = self.tickets.lock();
        tickets.retain(|_, ticket| ticket.expires > Instant::now());
        ensure!(tickets.len() < 512, "Too many pending viewers");
        let ticket = random_token();
        tickets.insert(
            ticket.clone(),
            Ticket {
                expires: Instant::now() + TICKET_LIFE,
                access,
            },
        );
        Ok(ticket)
    }

    pub fn redeem(&self, key: &mut String) -> Option<RoomAccess> {
        let access = self
            .tickets
            .lock()
            .remove(key)
            .and_then(|ticket| (ticket.expires > Instant::now()).then_some(ticket.access));
        if access.is_some() {
            *key = self.viewer_key.clone();
        }
        access
    }
}

pub(crate) fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::fill(&mut bytes[..]);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn persist<T: Serialize>(path: &PathBuf, settings: &T) -> Result<()> {
    let parent = path
        .parent()
        .context("State path needs a parent directory")?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension(format!("{}.tmp", &random_token()[..12]));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    serde_json::to_writer_pretty(&mut file, settings)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_ticket_is_short_lived_and_single_use() -> Result<()> {
        let path = std::env::temp_dir().join(format!("questrelay-test-{}.json", random_token()));
        let site = Site::open(path.clone(), "a".repeat(32), "v".repeat(32))?;
        let mut settings = site.settings();
        assert!(site.issue_ticket(&settings.id, "guess").is_err());
        settings = site.update(SettingsInput {
            title: "Room".into(),
            is_public: false,
            access_code: "secret-code-123".into(),
            theme: settings.theme,
            mascot: settings.mascot,
        })?;
        let mut ticket = site.issue_ticket(&settings.id, "secret-code-123")?;
        let original = ticket.clone();
        site.redeem(&mut ticket);
        assert_eq!(ticket, "v".repeat(32));
        let mut replay = original.clone();
        site.redeem(&mut replay);
        assert_eq!(replay, original);
        let _ = fs::remove_file(path);
        Ok(())
    }

    #[test]
    fn feed_rooms_keep_distinct_links_and_ticket_scope() -> Result<()> {
        let path = std::env::temp_dir().join(format!("questrelay-rooms-{}.json", random_token()));
        let site = Site::open(path.clone(), "a".repeat(32), "v".repeat(32))?;
        site.ensure_feed_room("quest-a")?;
        site.ensure_feed_room("quest-b")?;
        site.ensure_feed_room("quest-a")?;
        let rooms = site.rooms_snapshot();
        let rooms = rooms.as_array().context("rooms array")?;
        assert_eq!(rooms.len(), 2);
        let id = rooms[0]["settings"]["id"].as_str().context("room id")?;
        assert_ne!(id, site.settings().id);
        assert_eq!(
            site.room_view(id).context("feed room")?["headsetId"],
            "quest-a"
        );
        let code = "private-room-code";
        let mut settings = site.settings();
        settings.access_code = code.into();
        site.update_room(
            id,
            SettingsInput {
                title: "Quest A".into(),
                is_public: false,
                access_code: code.into(),
                theme: settings.theme,
                mascot: settings.mascot,
            },
        )?;
        assert!(site.issue_ticket(id, "wrong").is_err());
        let mut ticket = site.issue_ticket(id, code)?;
        assert!(
            matches!(site.redeem(&mut ticket), Some(RoomAccess::Headset(headset)) if headset == "quest-a")
        );
        assert!(site.redeem(&mut ticket).is_none());
        let _ = fs::remove_file(path.with_file_name("rooms.json"));
        let _ = fs::remove_file(path);
        Ok(())
    }
}
