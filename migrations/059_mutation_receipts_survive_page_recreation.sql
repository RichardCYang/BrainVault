-- Successful reset/create mutation IDs are replay tombstones, not children of a
-- page generation. Keep them after permanent page deletion so a delayed request
-- cannot become new work if a backup later recreates the same page id.
--
-- The user/actor foreign keys remain in place, so deleting the account still
-- removes these receipts. Page indexes remain useful for diagnostics and lookup.
-- Each DDL statement is idempotent because MariaDB DDL implicitly commits and a
-- stopped migration may be replayed before schema_migrations is updated.

SET @brainvault_drop_page_version_reset_page_fk = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE page_version_reset_mutations DROP FOREIGN KEY fk_page_version_reset_mutations_page',
    'DO 0'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'page_version_reset_mutations'
    AND CONSTRAINT_NAME = 'fk_page_version_reset_mutations_page'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
PREPARE brainvault_drop_page_version_reset_page_fk_statement FROM @brainvault_drop_page_version_reset_page_fk;
EXECUTE brainvault_drop_page_version_reset_page_fk_statement;
DEALLOCATE PREPARE brainvault_drop_page_version_reset_page_fk_statement;

SET @brainvault_drop_block_create_page_fk = (
  SELECT IF(
    COUNT(*) = 1,
    'ALTER TABLE block_create_mutations DROP FOREIGN KEY fk_block_create_mutations_page',
    'DO 0'
  )
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'block_create_mutations'
    AND CONSTRAINT_NAME = 'fk_block_create_mutations_page'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
PREPARE brainvault_drop_block_create_page_fk_statement FROM @brainvault_drop_block_create_page_fk;
EXECUTE brainvault_drop_block_create_page_fk_statement;
DEALLOCATE PREPARE brainvault_drop_block_create_page_fk_statement;
