ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50);
UPDATE users SET username = LOWER(CONCAT('user_', REPLACE(SUBSTRING(id, 1, 12), '-', ''))) WHERE username IS NULL;
ALTER TABLE users MODIFY username VARCHAR(50) NOT NULL;
ALTER TABLE users ADD UNIQUE INDEX IF NOT EXISTS uq_users_username (username);
