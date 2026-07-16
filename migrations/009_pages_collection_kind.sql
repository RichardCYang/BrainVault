ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_collection_icon VARCHAR(32) NULL AFTER preferred_language;

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS is_collection TINYINT(1) NOT NULL DEFAULT 0 AFTER is_archived;

UPDATE pages
SET is_collection = 1
WHERE parent_page_id IS NULL AND icon = '📁';

CREATE INDEX IF NOT EXISTS idx_pages_owner_collection
  ON pages (owner_id, is_collection, is_archived);
