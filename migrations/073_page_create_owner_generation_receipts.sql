-- A page-create receipt is actor-scoped, but delegated collection administrators
-- can create pages in another user's workspace. Bind the receipt to that owner's
-- restore generation too so stable IDs recreated by restore cannot be mistaken
-- for the page produced by a pre-restore mutation. Existing receipts fail closed.
ALTER TABLE page_create_mutations
  ADD COLUMN IF NOT EXISTS workspace_owner_id VARCHAR(64) NULL AFTER workspace_generation,
  ADD COLUMN IF NOT EXISTS owner_workspace_generation BIGINT UNSIGNED NULL AFTER workspace_owner_id;
