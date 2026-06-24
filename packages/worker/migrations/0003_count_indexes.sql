CREATE INDEX IF NOT EXISTS idx_image_likes_image_id ON image_likes(image_id);
CREATE INDEX IF NOT EXISTS idx_comment_likes_comment ON comment_likes(comment_id);

CREATE TABLE IF NOT EXISTS image_like_counts (
  image_id TEXT PRIMARY KEY,
  count    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comment_like_counts (
  comment_id TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0
);

DELETE FROM comment_rate_limits WHERE expires_at <= unixepoch('now') * 1000;
DELETE FROM comment_nickname_cooldowns WHERE expires_at <= unixepoch('now') * 1000;
