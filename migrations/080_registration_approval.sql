-- Existing accounts remain usable. Public registration must explicitly create
-- pending accounts; activation is a separate, operator-controlled operation.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS registration_approved TINYINT(1) NOT NULL DEFAULT 1;
