-- Per-account country-based login access policy and dedicated block history.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country_login_mode ENUM('OFF', 'ALLOWLIST', 'BLOCKLIST') NOT NULL DEFAULT 'OFF';

CREATE TABLE IF NOT EXISTS user_country_login_countries (
  user_id VARCHAR(36) NOT NULL,
  country_code CHAR(2) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, country_code),
  CONSTRAINT fk_user_country_login_countries_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_country_login_blocks (
  id VARCHAR(36) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  country_code CHAR(2) NULL,
  reason ENUM('NOT_ALLOWLISTED', 'BLOCKLISTED', 'COUNTRY_UNRESOLVED', 'POLICY_INVALID') NOT NULL,
  blocked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_user_country_login_blocks_user_time (user_id, blocked_at, id),
  CONSTRAINT fk_user_country_login_blocks_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
