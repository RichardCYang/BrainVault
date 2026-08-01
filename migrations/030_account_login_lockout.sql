-- Persist account-level password failure backoff so distributed source IPs
-- cannot bypass per-process request limits.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_login_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS login_locked_until DATETIME(3) NULL;

CREATE INDEX IF NOT EXISTS idx_users_login_locked_until ON users(login_locked_until);
