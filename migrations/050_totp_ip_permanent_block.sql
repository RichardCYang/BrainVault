-- Optional per-account TOTP failure limit with a server-wide permanent IP deny list.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_ip_block_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER vpn_block_enabled,
  ADD COLUMN IF NOT EXISTS totp_ip_block_threshold TINYINT UNSIGNED NOT NULL DEFAULT 3 AFTER totp_ip_block_enabled;

CREATE TABLE IF NOT EXISTS user_totp_ip_failures (
  user_id VARCHAR(36) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_failed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, ip_address),
  KEY idx_user_totp_ip_failures_last_failed (last_failed_at),
  CONSTRAINT fk_user_totp_ip_failures_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_totp_ip_blocks (
  user_id VARCHAR(36) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  failed_attempts SMALLINT UNSIGNED NOT NULL,
  blocked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, ip_address),
  KEY idx_user_totp_ip_blocks_ip (ip_address),
  KEY idx_user_totp_ip_blocks_user_time (user_id, blocked_at),
  CONSTRAINT fk_user_totp_ip_blocks_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE user_country_login_blocks
  MODIFY COLUMN reason ENUM(
    'NOT_ALLOWLISTED',
    'BLOCKLISTED',
    'COUNTRY_UNRESOLVED',
    'POLICY_INVALID',
    'VPN_DETECTED',
    'VPN_GATE_DETECTED',
    'PROXY_DETECTED',
    'TOR_DETECTED',
    'TOTP_ATTEMPTS_EXCEEDED'
  ) NOT NULL;
