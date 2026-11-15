-- A snapshot leaves out its oldest version history entries when the whole
-- workspace would not fit the backup budget (current content is never cut).
-- A downloaded backup already says so; a snapshot now records how many it
-- left out, so the snapshot list and its restore can say so too.
ALTER TABLE workspace_snapshots
  ADD COLUMN history_entries_omitted INT UNSIGNED NOT NULL DEFAULT 0 AFTER page_version_count;
