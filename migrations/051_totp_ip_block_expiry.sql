-- Scope TOTP IP blocks to the owning account in application code and bound their lifetime.
ALTER TABLE user_totp_ip_blocks
  ADD COLUMN IF NOT EXISTS expires_at DATETIME(3) NULL AFTER blocked_at;

UPDATE user_totp_ip_blocks
SET expires_at = DATE_ADD(blocked_at, INTERVAL 24 HOUR)
WHERE expires_at IS NULL;

ALTER TABLE user_totp_ip_blocks
  MODIFY COLUMN expires_at DATETIME(3) NOT NULL;
