-- Scope block-move replay receipts to the workspace whose data was mutated.
-- This prevents a collaborator restoring their own workspace from deleting
-- replay protection that belongs to another owner's workspace.
ALTER TABLE block_move_mutations
  ADD COLUMN IF NOT EXISTS workspace_owner_id VARCHAR(64) NULL AFTER actor_id;

CREATE INDEX IF NOT EXISTS idx_block_move_mutations_workspace_owner
  ON block_move_mutations(workspace_owner_id);

-- Backfill receipts that can still be resolved from their source/target pages.
-- Unresolvable legacy rows remain NULL and are handled conservatively by restore.
UPDATE block_move_mutations bmm
INNER JOIN pages source_page ON source_page.id = bmm.source_page_id
INNER JOIN pages target_page ON target_page.id = bmm.target_page_id
SET bmm.workspace_owner_id = source_page.owner_id
WHERE bmm.workspace_owner_id IS NULL
  AND source_page.owner_id = target_page.owner_id;
