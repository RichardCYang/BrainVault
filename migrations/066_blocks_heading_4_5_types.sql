-- Add Heading 4 and Heading 5 blocks without rewriting existing block rows.
-- The complete enum is restated so existing databases can accept the new values
-- while migration replay remains a superset of every application-supported block type.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM(
    'MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'HEADING_4', 'HEADING_5', 'TODO',
    'UNORDERED_LIST', 'ORDERED_LIST', 'QUOTE', 'CALLOUT', 'TOGGLE',
    'ACCORDION', 'TABLE', 'KANBAN', 'DATABASE', 'TREEVIEW', 'TIMETABLE',
    'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'MERMAID', 'CODE', 'DIVIDER',
    'IMAGE', 'VIDEO', 'ATTACHMENT'
  ) NOT NULL DEFAULT 'MARKDOWN';
