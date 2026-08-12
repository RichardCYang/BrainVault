-- Add the multi-item accordion block type without changing or deleting existing block rows.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'UNORDERED_LIST', 'ORDERED_LIST', 'QUOTE', 'CALLOUT', 'TOGGLE', 'ACCORDION', 'TABLE', 'KANBAN', 'DATABASE', 'TIMETABLE', 'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'VIDEO', 'ATTACHMENT')
  NOT NULL DEFAULT 'MARKDOWN';
