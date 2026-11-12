-- Retire the per-account network policy without deleting security audit records.
-- A string preserves historical reasons while current policies record their own codes.
ALTER TABLE user_country_login_blocks
  MODIFY COLUMN reason VARCHAR(64) NOT NULL;

ALTER TABLE users
  DROP COLUMN IF EXISTS vpn_block_enabled;
