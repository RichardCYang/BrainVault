-- Security assessment remediation (BV-27, BV-28, BV-29).
-- Existing recovery grants receive a bounded compatibility window; old MFA
-- step-up tokens remain unscoped and therefore cannot satisfy the new scoped
-- redemption query.
ALTER TABLE page_recovery_grants
  ADD COLUMN IF NOT EXISTS expires_at DATETIME(6) NULL AFTER updated_at;

UPDATE page_recovery_grants
SET expires_at = DATE_ADD(updated_at, INTERVAL 7 DAY)
WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_page_recovery_grants_expiry
  ON page_recovery_grants (expires_at, purged_at);

ALTER TABLE mfa_step_up_sessions
  ADD COLUMN IF NOT EXISTS action VARCHAR(64) NULL AFTER auth_version,
  ADD COLUMN IF NOT EXISTS resource_id VARCHAR(128) NULL AFTER action;

CREATE INDEX IF NOT EXISTS idx_mfa_step_up_sessions_scope
  ON mfa_step_up_sessions (user_id, session_id, auth_version, action, resource_id, expires_at);

CREATE TABLE IF NOT EXISTS custom_icon_page_publications (
  page_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  file_path VARCHAR(256) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (page_id, file_path),
  KEY idx_custom_icon_page_publications_owner (owner_id, file_path),
  CONSTRAINT fk_custom_icon_page_publications_page
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_custom_icon_page_publications_owner
    FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
