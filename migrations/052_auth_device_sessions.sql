CREATE TABLE IF NOT EXISTS user_auth_sessions (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  auth_version BIGINT UNSIGNED NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  browser_name VARCHAR(64) NOT NULL,
  browser_version VARCHAR(32) NULL,
  os_name VARCHAR(64) NOT NULL,
  device_type VARCHAR(16) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  KEY idx_user_auth_sessions_active (user_id, auth_version, revoked_at, expires_at, last_seen_at),
  CONSTRAINT fk_user_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
