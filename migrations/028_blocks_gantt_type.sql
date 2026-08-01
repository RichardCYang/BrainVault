-- Add Gantt chart blocks while preserving every existing block type.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'QUOTE', 'CALLOUT', 'TABLE', 'KANBAN', 'DATABASE', 'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'ATTACHMENT')
  NOT NULL DEFAULT 'MARKDOWN';
