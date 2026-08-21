-- Bind idempotent delete retries to the attachment-storage generation that
-- authorized the original destructive transaction. A workspace restore advances
-- users.attachment_generation and replaces the attachment directory, so a delayed
-- receipt replay must never adopt that newer generation for filesystem cleanup.
--
-- NULL is intentional for receipts created before this migration: the SQL delete
-- may still be acknowledged idempotently, but legacy receipts have no authority
-- to remove files from the current workspace generation.
ALTER TABLE page_delete_mutations
  ADD COLUMN IF NOT EXISTS attachment_generation BIGINT UNSIGNED NULL AFTER attachment_ids;

ALTER TABLE block_delete_mutations
  ADD COLUMN IF NOT EXISTS attachment_generation BIGINT UNSIGNED NULL AFTER attachment_ids;
