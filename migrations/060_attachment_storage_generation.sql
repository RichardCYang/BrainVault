-- Fence deferred attachment cleanup from workspace restores.
-- A restore replaces the complete per-user attachment directory while SQL delete
-- cleanup can run after its destructive transaction commits. Persist a generation
-- on the user row so old cleanup work can prove it still targets the same files.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS attachment_generation BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER updated_at;
