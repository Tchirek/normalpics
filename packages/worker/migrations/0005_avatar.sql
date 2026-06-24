-- Custom user avatar stored in R2; column holds the R2 object key (NULL = initials avatar).
ALTER TABLE users ADD COLUMN avatar_key TEXT;
