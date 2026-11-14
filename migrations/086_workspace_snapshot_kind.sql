-- Tell snapshots a person made apart from the ones BrainVault saves on its own
-- just before a restore or backup import replaces the workspace. Automatic
-- snapshots do not use up the manual snapshot count or storage quota; only the
-- newest few are kept (SNAPSHOT_AUTO_MAX_COUNT).
ALTER TABLE workspace_snapshots
  ADD COLUMN kind ENUM('MANUAL', 'PRE_RESTORE') NOT NULL DEFAULT 'MANUAL' AFTER user_id;
