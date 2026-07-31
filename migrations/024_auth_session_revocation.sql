-- Bind every authentication token and collaboration ticket to a mutable
-- account generation. Incrementing this value invalidates every older session
-- without storing bearer tokens in the database.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS auth_version BIGINT UNSIGNED NOT NULL DEFAULT 1;
