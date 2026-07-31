CREATE TABLE IF NOT EXISTS user_login_attempts (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  outcome ENUM('SUCCESS', 'FAILURE') NOT NULL,
  attempted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_user_login_attempts_user_time (user_id, attempted_at, id),
  CONSTRAINT fk_user_login_attempts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Preserve the originating address while a password-authenticated login waits
-- for its second factor. Existing sessions receive a harmless local fallback.
ALTER TABLE mfa_login_sessions
  ADD COLUMN IF NOT EXISTS source_ip VARCHAR(45) NOT NULL DEFAULT 'unknown';
