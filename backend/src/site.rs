use anyhow::{Context, Result, ensure};
use parking_lot::Mutex;
use rand::RngCore;
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
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub id: String,
    pub title: String,
    pub is_public: bool,
    pub access_code: String,
    pub theme: Theme,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    pub title: String,
    pub is_public: bool,
    pub access_code: String,
    pub theme: Theme,
}

impl Settings {
    fn new() -> Self {
        const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
        let mut bytes = [0u8; 6];
        rand::rng().fill_bytes(&mut bytes);
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
            },
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
        self.title = title.into();
        self.is_public = input.is_public;
        self.access_code = input.access_code;
        self.theme = input.theme;
        Ok(())
    }

    pub fn public_view(&self) -> Value {
        json!({
            "id": self.id,
            "title": self.title,
            "isPublic": self.is_public,
            "theme": self.theme,
        })
    }
}

pub struct Site {
    path: PathBuf,
    settings: Mutex<Settings>,
    admin_key: String,
    viewer_key: String,
    sessions: Mutex<HashMap<String, Instant>>,
    tickets: Mutex<HashMap<String, Instant>>,
    failed_codes: Mutex<Vec<Instant>>,
    revocations: watch::Sender<u64>,
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
        let (revocations, _) = watch::channel(0);
        Ok(Self {
            path,
            settings: Mutex::new(settings),
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
        let settings = self.settings.lock();
        ensure!(settings.id == id, "Room not found");
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
        drop(settings);
        let mut tickets = self.tickets.lock();
        tickets.retain(|_, expires| *expires > Instant::now());
        ensure!(tickets.len() < 512, "Too many pending viewers");
        let ticket = random_token();
        tickets.insert(ticket.clone(), Instant::now() + TICKET_LIFE);
        Ok(ticket)
    }

    pub fn redeem(&self, key: &mut String) {
        let valid = self
            .tickets
            .lock()
            .remove(key)
            .is_some_and(|expires| expires > Instant::now());
        if valid {
            *key = self.viewer_key.clone();
        }
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn persist(path: &PathBuf, settings: &Settings) -> Result<()> {
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
}
