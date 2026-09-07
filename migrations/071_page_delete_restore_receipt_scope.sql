-- Workspace restore invalidates permanent-delete receipts that either belong to
-- the restoring actor or target the restoring workspace. Index the delegated
-- owner column so restore does not scan every historical delete receipt.
CREATE INDEX IF NOT EXISTS idx_page_delete_mutations_workspace_owner
  ON page_delete_mutations(workspace_owner_id);
