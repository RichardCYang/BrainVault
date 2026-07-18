CREATE INDEX IF NOT EXISTS idx_pages_owner_archived_created
  ON pages(owner_id, is_archived, created_at, id);
