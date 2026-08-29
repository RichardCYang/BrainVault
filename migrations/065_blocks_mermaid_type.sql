-- Add Mermaid diagram blocks while preserving every existing block value.
-- Historical enum migrations are kept in sync as well because BrainVault's
-- migration safety tests require every replayable enum definition to remain a
-- superset of all block types supported by the current application.
ALTER TABLE blocks
  MODIFY COLUMN type ENUM(
    'MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO',
    'UNORDERED_LIST', 'ORDERED_LIST', 'QUOTE', 'CALLOUT', 'TOGGLE',
    'ACCORDION', 'TABLE', 'KANBAN', 'DATABASE', 'TREEVIEW', 'TIMETABLE',
    'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'MERMAID', 'CODE', 'DIVIDER',
    'IMAGE', 'VIDEO', 'ATTACHMENT'
  ) NOT NULL DEFAULT 'MARKDOWN';
