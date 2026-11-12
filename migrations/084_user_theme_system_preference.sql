-- Let accounts follow the operating system's light/dark preference.
-- Existing explicit choices are kept; new accounts follow the system by default.
ALTER TABLE users
  MODIFY COLUMN theme ENUM('light', 'dark', 'system') NOT NULL DEFAULT 'system';
