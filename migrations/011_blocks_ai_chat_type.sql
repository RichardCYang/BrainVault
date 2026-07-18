-- Keep the full current enum so replaying a historical migration after a lost
-- or incomplete schema_migrations ledger can never narrow existing block data.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'QUOTE', 'CALLOUT', 'TABLE', 'KANBAN', 'DATABASE', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'ATTACHMENT')
  NOT NULL DEFAULT 'MARKDOWN';
