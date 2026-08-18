-- Forge VR Asset Store — PostgreSQL schema (Vercel / Neon).
-- Run this once against your database before the first deploy.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL DEFAULT '',
  username      TEXT NOT NULL DEFAULT '',
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  provider      TEXT NOT NULL DEFAULT 'password',
  google_id     TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users (LOWER(username));
CREATE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL DEFAULT '',
  hash         TEXT NOT NULL,
  hint         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS packs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  section         TEXT NOT NULL DEFAULT 'props',
  description     TEXT NOT NULL DEFAULT '',
  cover_asset_ids JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_packs_user ON packs (user_id);

CREATE TABLE IF NOT EXISTS assets (
  id         TEXT PRIMARY KEY,
  pack_id    TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  file_name  TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  triangles  INTEGER NOT NULL DEFAULT 0,
  category   TEXT NOT NULL DEFAULT 'prop',
  source_id  TEXT NOT NULL DEFAULT '',
  has_thumb  BOOLEAN NOT NULL DEFAULT false,
  file_url   TEXT NOT NULL DEFAULT '',
  thumb_url  TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_pack ON assets (pack_id);
CREATE INDEX IF NOT EXISTS idx_assets_source ON assets (pack_id, source_id);
