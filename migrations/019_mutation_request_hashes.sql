ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS last_mutation_hash CHAR(64) NULL AFTER last_mutation_id;

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS last_mutation_hash CHAR(64) NULL AFTER last_mutation_id;

ALTER TABLE block_order_mutations
  ADD COLUMN IF NOT EXISTS request_hash CHAR(64) NULL AFTER page_id;
