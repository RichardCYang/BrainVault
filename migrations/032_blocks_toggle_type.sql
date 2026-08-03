-- Add collapsible toggle blocks while preserving every existing block type.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'QUOTE', 'CALLOUT', 'TOGGLE', 'TABLE', 'KANBAN', 'DATABASE', 'TIMETABLE', 'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'VIDEO', 'ATTACHMENT')
  NOT NULL DEFAULT 'MARKDOWN';
