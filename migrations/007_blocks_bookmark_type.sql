-- Keep the full current enum so replaying a historical migration after a lost
-- or incomplete schema_migrations ledger can never narrow existing block data.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'UNORDERED_LIST', 'ORDERED_LIST', 'QUOTE', 'CALLOUT', 'TOGGLE', 'ACCORDION', 'TABLE', 'KANBAN', 'DATABASE', 'TREEVIEW', 'TIMETABLE', 'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'VIDEO', 'ATTACHMENT')
  NOT NULL DEFAULT 'MARKDOWN';
