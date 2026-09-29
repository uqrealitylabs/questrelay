use crate::site::{persist, random_token};
use anyhow::{Context, Result, bail, ensure};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
use webauthn_rs::prelude::*;

const CHALLENGE_LIFE: Duration = Duration::from_secs(300);
const INVITE_LIFE: Duration = Duration::from_secs(900);
const SESSION_LIFE: Duration = Duration::from_secs(8 * 60 * 60);

#[derive(Clone, Serialize, Deserialize)]
struct SavedKey {
    id: String,
    label: String,
    credential: Passkey,
}

#[derive(Clone, Serialize, Deserialize)]
struct Admin {
    id: Uuid,
    name: String,
    owner: bool,
    keys: Vec<SavedKey>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    admins: Vec<Admin>,
}

enum Flow {
    Register {
        state: PasskeyRegistration,
        label: String,
        invite: Option<String>,
    },
    Login(PasskeyAuthentication),
}

struct Pending {
    account: Uuid,
    expires: Instant,
    flow: Flow,
}

pub struct Auth {
    path: PathBuf,
    webauthn: Option<Webauthn>,
    saved: Mutex<Saved>,
    pending: Mutex<HashMap<String, Pending>>,
    invites: Mutex<HashMap<String, (Uuid, Instant)>>,
    sessions: Mutex<HashMap<String, (Uuid, Instant)>>,
}

impl Auth {
    pub fn open(path: PathBuf, origin: Option<String>) -> Result<Self> {
        let webauthn = origin
            .map(|value| -> Result<Webauthn> {
                let url = Url::parse(&value).context("Invalid QUESTRELAY_WEBAUTHN_ORIGIN")?;
                let host = url.host_str().context("WebAuthn origin needs a host")?;
                ensure!(
                    url.scheme() == "https" || host == "localhost" || host == "127.0.0.1",
                    "WebAuthn origin needs HTTPS"
                );
                Ok(WebauthnBuilder::new(host, &url)?
                    .rp_name("QuestRelay")
                    .build()?)
            })
            .transpose()?;
        let saved = if path.exists() {
            serde_json::from_slice(&fs::read(&path).context("Unable to read admin accounts")?)
                .context("Invalid admin accounts")?
        } else {
            let saved = Saved {
                admins: vec![Admin {
                    id: Uuid::nil(),
                    name: "Owner".into(),
                    owner: true,
                    keys: Vec::new(),
                }],
            };
            persist(&path, &saved)?;
            saved
        };
        Ok(Self {
            path,
            webauthn,
            saved: Mutex::new(saved),
            pending: Mutex::new(HashMap::new()),
            invites: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        })
    }

    pub fn enabled(&self) -> bool {
        self.webauthn.is_some()
    }

    pub fn identity(&self, token: &str) -> Option<Uuid> {
        self.sessions
            .lock()
            .get(token)
            .and_then(|(id, expires)| (*expires > Instant::now()).then_some(*id))
    }

    pub fn logout(&self, token: &str) {
        self.sessions.lock().remove(token);
    }

    fn session(&self, id: Uuid) -> Result<String> {
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, (_, expires)| *expires > Instant::now());
        ensure!(sessions.len() < 64, "Too many admin sessions");
        let token = random_token();
        sessions.insert(token.clone(), (id, Instant::now() + SESSION_LIFE));
        Ok(token)
    }

    pub fn snapshot(&self, current: Uuid, owner: bool) -> Value {
        let saved = self.saved.lock();
        json!({
            "enabled": self.enabled(),
            "currentId": current,
            "owner": owner,
            "accounts": saved.admins.iter()
                .filter(|admin| owner || admin.id == current)
                .map(|admin| json!({
                    "id": admin.id, "name": admin.name, "owner": admin.owner,
                    "passkeys": admin.keys.iter().map(|key| json!({"id": key.id, "label": key.label})).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
        })
    }

    pub fn add_admin(&self, name: &str) -> Result<(Uuid, String)> {
        let name = name.trim();
        ensure!(
            (2..=48).contains(&name.chars().count()),
            "Admin name must be 2–48 characters"
        );
        let mut saved = self.saved.lock();
        ensure!(saved.admins.len() < 16, "Admin limit reached");
        ensure!(
            !saved
                .admins
                .iter()
                .any(|admin| admin.name.eq_ignore_ascii_case(name)),
            "Admin name already in use"
        );
        let id = Uuid::new_v4();
        let mut updated = saved.clone();
        updated.admins.push(Admin {
            id,
            name: name.into(),
            owner: false,
            keys: Vec::new(),
        });
        persist(&self.path, &updated)?;
        *saved = updated;
        Ok((id, self.issue_invite(id)))
    }

    pub fn rename_admin(&self, id: Uuid, name: &str) -> Result<()> {
        let name = name.trim();
        ensure!(
            (2..=48).contains(&name.chars().count()),
            "Admin name must be 2–48 characters"
        );
        let mut saved = self.saved.lock();
        ensure!(
            !saved
                .admins
                .iter()
                .any(|admin| admin.id != id && admin.name.eq_ignore_ascii_case(name)),
            "Admin name already in use"
        );
        let mut updated = saved.clone();
        let admin = updated
            .admins
            .iter_mut()
            .find(|admin| admin.id == id)
            .context("Admin not found")?;
        admin.name = name.into();
        persist(&self.path, &updated)?;
        *saved = updated;
        Ok(())
    }

    pub fn remove_admin(&self, id: Uuid) -> Result<()> {
        ensure!(id != Uuid::nil(), "Owner cannot be removed");
        let mut saved = self.saved.lock();
        let mut updated = saved.clone();
        let before = updated.admins.len();
        updated.admins.retain(|admin| admin.id != id);
        ensure!(updated.admins.len() != before, "Admin not found");
        persist(&self.path, &updated)?;
        *saved = updated;
        self.sessions
            .lock()
            .retain(|_, (account, _)| *account != id);
        self.invites.lock().retain(|_, (account, _)| *account != id);
        Ok(())
    }

    fn issue_invite(&self, id: Uuid) -> String {
        let mut invites = self.invites.lock();
        invites.retain(|_, (_, expires)| *expires > Instant::now());
        invites.retain(|_, (account, _)| *account != id);
        let token = random_token();
        invites.insert(token.clone(), (id, Instant::now() + INVITE_LIFE));
        token
    }

    pub fn invite(&self, id: Uuid) -> Result<String> {
        ensure!(
            self.saved
                .lock()
                .admins
                .iter()
                .any(|admin| admin.id == id && !admin.owner),
            "Admin not found"
        );
        Ok(self.issue_invite(id))
    }

    pub fn start_register(
        &self,
        current: Option<Uuid>,
        invite: Option<&str>,
        label: &str,
    ) -> Result<Value> {
        let label = label.trim();
        ensure!(
            (2..=40).contains(&label.chars().count()),
            "Passkey label must be 2–40 characters"
        );
        let account = if let Some(token) = invite {
            self.invites
                .lock()
                .get(token)
                .and_then(|(id, expires)| (*expires > Instant::now()).then_some(*id))
                .context("Invitation expired or invalid")?
        } else {
            current.context("Admin sign-in required")?
        };
        let saved = self.saved.lock();
        let admin = saved
            .admins
            .iter()
            .find(|admin| admin.id == account)
            .context("Admin not found")?;
        ensure!(admin.keys.len() < 10, "Passkey limit reached");
        let exclude = admin
            .keys
            .iter()
            .map(|key| key.credential.cred_id().clone())
            .collect();
        let (options, state) = self
            .webauthn
            .as_ref()
            .context("Passkeys are not configured")?
            .start_passkey_registration(account, &admin.name, &admin.name, Some(exclude))?;
        drop(saved);
        let challenge_id = self.pending(Pending {
            account,
            expires: Instant::now() + CHALLENGE_LIFE,
            flow: Flow::Register {
                state,
                label: label.into(),
                invite: invite.map(str::to_owned),
            },
        })?;
        Ok(json!({"challengeId": challenge_id, "options": options}))
    }

    pub fn finish_register(
        &self,
        current: Option<Uuid>,
        challenge: &str,
        credential: RegisterPublicKeyCredential,
    ) -> Result<String> {
        let pending = self.take_pending(challenge)?;
        let Flow::Register {
            state,
            label,
            invite,
        } = pending.flow
        else {
            bail!("Wrong challenge type")
        };
        if let Some(token) = &invite {
            ensure!(
                self.invites.lock().get(token).is_some_and(
                    |(id, expires)| *id == pending.account && *expires > Instant::now()
                ),
                "Invitation expired or invalid"
            );
        } else {
            ensure!(current == Some(pending.account), "Admin sign-in required");
        }
        let key = self
            .webauthn
            .as_ref()
            .context("Passkeys are not configured")?
            .finish_passkey_registration(&credential, &state)?;
        let mut saved = self.saved.lock();
        ensure!(
            !saved
                .admins
                .iter()
                .flat_map(|admin| &admin.keys)
                .any(|stored| stored.credential.cred_id() == key.cred_id()),
            "Passkey already registered"
        );
        let mut updated = saved.clone();
        let admin = updated
            .admins
            .iter_mut()
            .find(|admin| admin.id == pending.account)
            .context("Admin not found")?;
        admin.keys.push(SavedKey {
            id: random_token()[..16].into(),
            label,
            credential: key,
        });
        persist(&self.path, &updated)?;
        *saved = updated;
        if let Some(token) = invite {
            self.invites.lock().remove(&token);
        }
        self.session(pending.account)
    }

    pub fn start_login(&self, name: &str) -> Result<Value> {
        let saved = self.saved.lock();
        let admin = saved
            .admins
            .iter()
            .find(|admin| admin.name.eq_ignore_ascii_case(name))
            .filter(|admin| !admin.keys.is_empty())
            .context("No passkey for this admin")?;
        let keys = admin
            .keys
            .iter()
            .map(|key| key.credential.clone())
            .collect::<Vec<_>>();
        let account = admin.id;
        drop(saved);
        let (options, state) = self
            .webauthn
            .as_ref()
            .context("Passkeys are not configured")?
            .start_passkey_authentication(&keys)?;
        let challenge_id = self.pending(Pending {
            account,
            expires: Instant::now() + CHALLENGE_LIFE,
            flow: Flow::Login(state),
        })?;
        Ok(json!({"challengeId": challenge_id, "options": options}))
    }

    pub fn finish_login(&self, challenge: &str, credential: PublicKeyCredential) -> Result<String> {
        let pending = self.take_pending(challenge)?;
        let Flow::Login(state) = pending.flow else {
            bail!("Wrong challenge type")
        };
        let result = self
            .webauthn
            .as_ref()
            .context("Passkeys are not configured")?
            .finish_passkey_authentication(&credential, &state)?;
        let mut saved = self.saved.lock();
        let mut updated = saved.clone();
        let admin = updated
            .admins
            .iter_mut()
            .find(|admin| admin.id == pending.account)
            .context("Admin not found")?;
        let key = admin
            .keys
            .iter_mut()
            .find(|key| key.credential.cred_id() == result.cred_id())
            .context("Passkey revoked")?;
        if key.credential.update_credential(&result).unwrap_or(false) {
            persist(&self.path, &updated)?;
            *saved = updated;
        }
        self.session(pending.account)
    }

    pub fn remove_key(&self, current: Uuid, id: &str) -> Result<()> {
        let mut saved = self.saved.lock();
        let mut updated = saved.clone();
        let admin = updated
            .admins
            .iter_mut()
            .find(|admin| admin.id == current)
            .context("Admin not found")?;
        let before = admin.keys.len();
        admin.keys.retain(|key| key.id != id);
        ensure!(admin.keys.len() != before, "Passkey not found");
        ensure!(
            admin.owner || !admin.keys.is_empty(),
            "Enrol another passkey before removing your last one"
        );
        persist(&self.path, &updated)?;
        *saved = updated;
        self.sessions
            .lock()
            .retain(|_, (account, _)| *account != current);
        Ok(())
    }

    fn pending(&self, flow: Pending) -> Result<String> {
        let mut pending = self.pending.lock();
        pending.retain(|_, item| item.expires > Instant::now());
        ensure!(pending.len() < 64, "Too many pending passkey challenges");
        let id = random_token();
        pending.insert(id.clone(), flow);
        Ok(id)
    }

    fn take_pending(&self, id: &str) -> Result<Pending> {
        let pending = self
            .pending
            .lock()
            .remove(id)
            .context("Challenge expired or invalid")?;
        ensure!(
            pending.expires > Instant::now(),
            "Challenge expired or invalid"
        );
        Ok(pending)
    }
}
