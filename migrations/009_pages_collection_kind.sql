ALTER TABLE users
  ADD COLUMN IF NOT EXISTS default_collection_icon VARCHAR(32) NULL AFTER preferred_language;

-- DDL implicitly commits in MariaDB, so persist whether this was a legacy
-- schema before adding the column. If startup stops after ALTER TABLE, the
-- marker survives and the intended backfill is completed on the next run.
INSERT IGNORE INTO schema_migrations (id)
SELECT '009_pages_collection_kind.sql:legacy-backfill-required'
WHERE NOT EXISTS (
  SELECT 1
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'pages'
    AND COLUMN_NAME = 'is_collection'
);

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS is_collection TINYINT(1) NOT NULL DEFAULT 0 AFTER is_archived;

UPDATE pages
SET is_collection = 1
WHERE EXISTS (
  SELECT 1
  FROM schema_migrations
  WHERE id = '009_pages_collection_kind.sql:legacy-backfill-required'
)
  AND parent_page_id IS NULL
  AND icon = '📁';

DELETE FROM schema_migrations
WHERE id = '009_pages_collection_kind.sql:legacy-backfill-required';

CREATE INDEX IF NOT EXISTS idx_pages_owner_collection
  ON pages (owner_id, is_collection, is_archived);
