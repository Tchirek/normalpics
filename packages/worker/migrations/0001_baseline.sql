CREATE TABLE IF NOT EXISTS images (
  id           TEXT PRIMARY KEY,
  filename     TEXT NOT NULL,
  ext          TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  size_bytes   INTEGER,
  r2_key_orig  TEXT,
  r2_key_web   TEXT,
  r2_key_thumb TEXT,
  sync_status  TEXT DEFAULT 'pending',
  description  TEXT,
  tags         TEXT,
  metadata_device_id TEXT,
  metadata_model TEXT,
  metadata_at INTEGER,
  metadata_claim_device_id TEXT,
  metadata_claimed_at INTEGER,
  blur_data_url TEXT,
  blur_claim_device_id TEXT,
  blur_claimed_at INTEGER,
  exif_aperture TEXT,
  exif_shutter_speed TEXT,
  exif_iso INTEGER,
  exif_focal_length TEXT,
  exif_metering_mode TEXT,
  exif_matrix_metering TEXT,
  exif_spot_metering TEXT,
  exif_exposure_compensation TEXT,
  exif_flash TEXT,
  uploaded_at  INTEGER NOT NULL,
  uploaded_day TEXT,
  uploaded_day_seq INTEGER,
  synced_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_uploaded_at ON images(uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_status ON images(sync_status);
CREATE INDEX IF NOT EXISTS idx_uploaded_day ON images(uploaded_day, uploaded_day_seq);

CREATE TABLE IF NOT EXISTS upload_days (
  day      TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_likes (
  image_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (image_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_image_likes_image_id ON image_likes(image_id);

CREATE TABLE IF NOT EXISTS image_like_counts (
  image_id TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS runtime_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT,
  tunnel_url   TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_devices_seen ON devices(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS image_devices (
  image_id  TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sha256    TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (image_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_image_devices_device ON image_devices(device_id, synced_at DESC);

CREATE TABLE IF NOT EXISTS image_comments (
  id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  parent_id TEXT,
  nickname TEXT NOT NULL,
  markdown TEXT NOT NULL,
  rendered_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_image ON image_comments(image_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_root ON image_comments(root_id, created_at);

CREATE TABLE IF NOT EXISTS comment_likes (
  comment_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, viewer_key)
);

CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);

CREATE TABLE IF NOT EXISTS comment_like_counts (
  comment_id TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comment_rate_limits (
  identity_hash TEXT PRIMARY KEY,
  last_post_at INTEGER NOT NULL,
  ten_min_started_at INTEGER NOT NULL,
  ten_min_count INTEGER NOT NULL,
  day_started_at INTEGER NOT NULL,
  day_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS comment_nickname_cooldowns (
  identity_hash TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_changed_at INTEGER,
  expires_at INTEGER NOT NULL
);
