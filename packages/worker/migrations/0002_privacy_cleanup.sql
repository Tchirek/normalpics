-- Remove stable cross-image/comment viewer identifiers while preserving public counts.

CREATE TABLE IF NOT EXISTS image_like_counts (
  image_id TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0
);

INSERT INTO image_like_counts (image_id, count)
SELECT image_id, COUNT(*)
FROM image_likes
GROUP BY image_id
ON CONFLICT(image_id) DO UPDATE SET
  count = MAX(image_like_counts.count, excluded.count);

DROP TABLE IF EXISTS image_likes_new;
CREATE TABLE image_likes_new (
  image_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (image_id, viewer_key)
);

DROP TABLE image_likes;
ALTER TABLE image_likes_new RENAME TO image_likes;
CREATE INDEX IF NOT EXISTS idx_image_likes_image_id ON image_likes(image_id);

CREATE TABLE IF NOT EXISTS comment_like_counts (
  comment_id TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0
);

INSERT INTO comment_like_counts (comment_id, count)
SELECT comment_id, COUNT(*)
FROM comment_likes
GROUP BY comment_id
ON CONFLICT(comment_id) DO UPDATE SET
  count = MAX(comment_like_counts.count, excluded.count);

DROP TABLE IF EXISTS comment_likes_new;
CREATE TABLE comment_likes_new (
  comment_id TEXT NOT NULL,
  viewer_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (comment_id, viewer_key)
);

DROP TABLE comment_likes;
ALTER TABLE comment_likes_new RENAME TO comment_likes;
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);

DROP TABLE IF EXISTS image_comments_new;
CREATE TABLE image_comments_new (
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

INSERT INTO image_comments_new (
  id, image_id, root_id, parent_id, nickname, markdown, rendered_html, status, created_at, updated_at
)
SELECT id, image_id, root_id, parent_id, nickname, markdown, rendered_html, status, created_at, updated_at
FROM image_comments;

DROP TABLE image_comments;
ALTER TABLE image_comments_new RENAME TO image_comments;
CREATE INDEX IF NOT EXISTS idx_comments_image ON image_comments(image_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_root ON image_comments(root_id, created_at);

DROP TABLE IF EXISTS comment_viewer_profiles;

DROP TABLE IF EXISTS comment_rate_limits_new;
CREATE TABLE comment_rate_limits_new (
  identity_hash TEXT PRIMARY KEY,
  last_post_at INTEGER NOT NULL,
  ten_min_started_at INTEGER NOT NULL,
  ten_min_count INTEGER NOT NULL,
  day_started_at INTEGER NOT NULL,
  day_count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

DROP TABLE IF EXISTS comment_rate_limits;
ALTER TABLE comment_rate_limits_new RENAME TO comment_rate_limits;

CREATE TABLE IF NOT EXISTS comment_nickname_cooldowns (
  identity_hash TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_changed_at INTEGER,
  expires_at INTEGER NOT NULL
);
