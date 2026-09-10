-- Block-create receipts intentionally survive page recreation so a lost response
-- can be reconciled. Bind each receipt to both the actor's workspace generation
-- and the destination owner's generation so stable IDs recreated by restore cannot
-- be mistaken for the block produced by a pre-restore mutation. Existing receipts
-- fail closed because the new lineage columns are nullable during migration.
ALTER TABLE block_create_mutations
  ADD COLUMN IF NOT EXISTS workspace_generation BIGINT UNSIGNED NULL AFTER request_hash,
  ADD COLUMN IF NOT EXISTS workspace_owner_id VARCHAR(64) NULL AFTER workspace_generation,
  ADD COLUMN IF NOT EXISTS owner_workspace_generation BIGINT UNSIGNED NULL AFTER workspace_owner_id;
