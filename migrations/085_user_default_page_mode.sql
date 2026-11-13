-- Let each account choose whether existing pages open in read or write mode.
-- Read stays the default so a page cannot be changed by accident on open.
ALTER TABLE users
  ADD COLUMN default_page_mode ENUM('read', 'write') NOT NULL DEFAULT 'read' AFTER theme;
