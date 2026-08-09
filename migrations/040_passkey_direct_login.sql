-- Anonymous, one-time WebAuthn ceremonies for discoverable passkey login.
-- The browser binding is stored only as SHA-256 so a database disclosure does
-- not reveal the HttpOnly ceremony cookie value.
CREATE TABLE IF NOT EXISTS passkey_login_challenges (
  token_hash CHAR(64) PRIMARY KEY,
  binding_hash CHAR(64) NOT NULL,
  challenge VARCHAR(255) NOT NULL,
  source_ip VARCHAR(45) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_passkey_login_challenges_binding (binding_hash),
  KEY idx_passkey_login_challenges_expires_at (expires_at),
  KEY idx_passkey_login_challenges_source_ip (source_ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
