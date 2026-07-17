CREATE TABLE IF NOT EXISTS user_totp_credentials (
  user_id VARCHAR(36) PRIMARY KEY,
  secret_ciphertext TEXT NOT NULL,
  secret_iv VARCHAR(32) NOT NULL,
  secret_tag VARCHAR(32) NOT NULL,
  last_used_step BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_user_totp_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_passkeys (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  credential_id VARBINARY(1023) NOT NULL,
  webauthn_user_id VARBINARY(64) NOT NULL,
  public_key BLOB NOT NULL,
  counter BIGINT UNSIGNED NOT NULL DEFAULT 0,
  transports VARCHAR(255) NULL,
  device_type VARCHAR(32) NOT NULL,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  aaguid VARCHAR(36) NULL,
  name VARCHAR(80) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  UNIQUE KEY uq_user_passkeys_credential_id (credential_id),
  KEY idx_user_passkeys_user_id (user_id),
  CONSTRAINT fk_user_passkeys_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mfa_totp_setups (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  secret_iv VARCHAR(32) NOT NULL,
  secret_tag VARCHAR(32) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_mfa_totp_setups_user_id (user_id),
  KEY idx_mfa_totp_setups_expires_at (expires_at),
  CONSTRAINT fk_mfa_totp_setups_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS mfa_login_sessions (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_mfa_login_sessions_user_id (user_id),
  KEY idx_mfa_login_sessions_expires_at (expires_at),
  CONSTRAINT fk_mfa_login_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  token_hash CHAR(64) PRIMARY KEY,
  user_id VARCHAR(36) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  challenge VARCHAR(255) NOT NULL,
  context_hash CHAR(64) NULL,
  metadata LONGTEXT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_webauthn_challenges_user_id (user_id),
  KEY idx_webauthn_challenges_expires_at (expires_at),
  CONSTRAINT fk_webauthn_challenges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
