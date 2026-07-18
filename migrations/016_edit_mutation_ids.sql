ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS last_mutation_id VARCHAR(64) NULL AFTER content_version;

ALTER TABLE blocks
  ADD COLUMN IF NOT EXISTS last_mutation_id VARCHAR(64) NULL AFTER edit_version;
