-- Comment-UI user accounts, OAuth links, and comment ownership.
-- Sessions, email-verification codes and OAuth state live in KV, not D1.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT,
  username_lower TEXT,
  email          TEXT,
  email_lower    TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash  TEXT,
  badge          TEXT NOT NULL DEFAULT 'seal',   -- 'none' | 'cockade' | 'seal'
  display_name   TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower
  ON users(email_lower) WHERE email_lower IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users(username_lower) WHERE username_lower IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_oauth (
  provider            TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  email               TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS idx_user_oauth_user ON user_oauth(user_id);

-- Comment ownership + single-edit accounting. Anonymous comments keep user_id NULL.
ALTER TABLE image_comments ADD COLUMN user_id TEXT;
ALTER TABLE image_comments ADD COLUMN edit_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_comments_user ON image_comments(user_id);
