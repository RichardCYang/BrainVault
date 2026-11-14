-- BrainVault also saves the workspace on its own just before a collection or a
-- page with nested pages is permanently deleted, so that deletion can be undone
-- by restoring the snapshot. These count as automatic snapshots: they do not
-- use the manual snapshot count or storage quota and are pruned with the
-- "Before restore" ones (SNAPSHOT_AUTO_MAX_COUNT, SNAPSHOT_AUTO_RETENTION_HOURS).
ALTER TABLE workspace_snapshots
  MODIFY COLUMN kind ENUM('MANUAL', 'PRE_RESTORE', 'PRE_DELETE') NOT NULL DEFAULT 'MANUAL';
