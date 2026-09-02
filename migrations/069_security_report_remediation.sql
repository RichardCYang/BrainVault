-- Bind replayable page mutation receipts to the workspace generation in which
-- they were created. A workspace restore increments users.attachment_generation,
-- so pre-restore receipts must not acknowledge work against the restored page set.
ALTER TABLE page_create_mutations
  ADD COLUMN IF NOT EXISTS workspace_generation BIGINT UNSIGNED NULL AFTER request_hash;

ALTER TABLE page_version_reset_mutations
  ADD COLUMN IF NOT EXISTS workspace_generation BIGINT UNSIGNED NULL AFTER request_hash;

-- Bind password-login MFA bearer tokens to an HttpOnly browser ceremony cookie.
-- Existing in-flight rows remain NULL and therefore fail closed after deployment.
ALTER TABLE mfa_login_sessions
  ADD COLUMN IF NOT EXISTS binding_hash CHAR(64) NULL AFTER source_ip;
