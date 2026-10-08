CREATE TABLE IF NOT EXISTS state (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  headset_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publishers (
  headset_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  video_mid TEXT NOT NULL,
  audio_mid TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  video_enabled INTEGER NOT NULL DEFAULT 1,
  audio_enabled INTEGER NOT NULL DEFAULT 1,
  stats TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS viewers (
  token_hash TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  session_id TEXT,
  headset_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS viewers_room ON viewers(room_id, expires_at);

CREATE TABLE IF NOT EXISTS subscriptions (
  token_hash TEXT NOT NULL,
  headset_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mids TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (token_hash, headset_id)
);

CREATE INDEX IF NOT EXISTS subscriptions_headset ON subscriptions(headset_id, expires_at);

CREATE TABLE IF NOT EXISTS admins (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticket_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS headset_history (
  headset_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  video_bitrate INTEGER NOT NULL,
  PRIMARY KEY (headset_id, at)
);

CREATE TABLE IF NOT EXISTS relay_history (
  at INTEGER PRIMARY KEY,
  headsets INTEGER NOT NULL,
  viewers INTEGER NOT NULL
);
