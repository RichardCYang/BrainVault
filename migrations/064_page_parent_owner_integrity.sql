-- The legacy page-parent FK validates only parent_page_id. A malformed or
-- legacy cross-owner reference can therefore point a page at another user's
-- page. Its ON DELETE SET NULL action would then modify that unrelated user's
-- hierarchy when the parent is permanently deleted or replaced during restore.
--
-- Match the existing block-parent integrity model: make ownership part of the
-- referential key so database-level cascades cannot cross an ownership boundary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pages_id_owner
  ON pages (id, owner_id);

-- Replace the legacy FK and its SET NULL action in one ALTER TABLE statement.
-- This avoids an intermediate window where incompatible referential actions are
-- both active. If legacy cross-owner rows already exist, ADD CONSTRAINT fails
-- without rewriting them; the migration is not recorded and an operator can
-- repair the corrupt reference explicitly instead of BrainVault mutating data.
SET @brainvault_replace_page_parent_fk = (
  SELECT CASE
    WHEN SUM(CONSTRAINT_NAME = 'fk_pages_parent_owner') > 0
         AND SUM(CONSTRAINT_NAME = 'fk_pages_parent') > 0
      THEN 'ALTER TABLE pages DROP FOREIGN KEY fk_pages_parent'
    WHEN SUM(CONSTRAINT_NAME = 'fk_pages_parent_owner') > 0
      THEN 'DO 0'
    WHEN SUM(CONSTRAINT_NAME = 'fk_pages_parent') > 0
      THEN 'ALTER TABLE pages DROP FOREIGN KEY fk_pages_parent, ADD CONSTRAINT fk_pages_parent_owner FOREIGN KEY (parent_page_id, owner_id) REFERENCES pages(id, owner_id) ON DELETE CASCADE'
    ELSE 'ALTER TABLE pages ADD CONSTRAINT fk_pages_parent_owner FOREIGN KEY (parent_page_id, owner_id) REFERENCES pages(id, owner_id) ON DELETE CASCADE'
  END
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'pages'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
PREPARE brainvault_replace_page_parent_fk_statement FROM @brainvault_replace_page_parent_fk;
EXECUTE brainvault_replace_page_parent_fk_statement;
DEALLOCATE PREPARE brainvault_replace_page_parent_fk_statement;
