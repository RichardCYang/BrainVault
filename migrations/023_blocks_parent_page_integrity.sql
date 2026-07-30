-- A single-column parent FK permits a corrupted block on one page to point
-- at a block on another page. Because the legacy FK cascades deletes, removing
-- that parent could then delete the unrelated child. Enforce page locality in
-- the database as well as in the application.
CREATE UNIQUE INDEX IF NOT EXISTS uq_blocks_id_page
  ON blocks (id, page_id);

SET @brainvault_add_parent_page_fk = (
  SELECT IF(
    COUNT(*) = 0,
    'ALTER TABLE blocks ADD CONSTRAINT fk_blocks_parent_page FOREIGN KEY (parent_block_id, page_id) REFERENCES blocks(id, page_id) ON DELETE CASCADE',
    'DO 0'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blocks'
    AND CONSTRAINT_NAME = 'fk_blocks_parent_page'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
PREPARE brainvault_add_parent_page_fk_statement FROM @brainvault_add_parent_page_fk;
EXECUTE brainvault_add_parent_page_fk_statement;
DEALLOCATE PREPARE brainvault_add_parent_page_fk_statement;

-- Only remove the legacy cascade after the composite FK is durably present.
-- Every statement is idempotent because MariaDB DDL implicitly commits and a
-- stopped migration may be replayed before schema_migrations is updated.
SET @brainvault_drop_legacy_parent_fk = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE blocks DROP FOREIGN KEY fk_blocks_parent',
    'DO 0'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blocks'
    AND CONSTRAINT_NAME = 'fk_blocks_parent'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
PREPARE brainvault_drop_legacy_parent_fk_statement FROM @brainvault_drop_legacy_parent_fk;
EXECUTE brainvault_drop_legacy_parent_fk_statement;
DEALLOCATE PREPARE brainvault_drop_legacy_parent_fk_statement;
