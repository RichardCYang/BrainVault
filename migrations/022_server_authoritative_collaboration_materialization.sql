ALTER TABLE page_collaboration_state
  ADD COLUMN IF NOT EXISTS materialization_version SMALLINT UNSIGNED NOT NULL DEFAULT 0
  AFTER materialized_update_id;
