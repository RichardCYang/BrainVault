-- Persist the country inferred from the login IP and the provider dataset version used for that mapping.
-- Existing login history is preserved and can be backfilled lazily when the user opens it.
ALTER TABLE user_login_attempts
  ADD COLUMN IF NOT EXISTS country_code CHAR(2) NULL AFTER ip_address,
  ADD COLUMN IF NOT EXISTS country_dataset_updated_at DATETIME(3) NULL AFTER country_code;
