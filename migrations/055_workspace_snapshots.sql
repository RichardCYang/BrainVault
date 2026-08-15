-- Persist metadata for server-side workspace snapshots. Snapshot archive bytes live
-- outside the public web root and are always resolved by authenticated owner ID.
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  archive_size BIGINT UNSIGNED NOT NULL,
  archive_sha256 CHAR(64) NOT NULL,
  page_count INT UNSIGNED NOT NULL,
  block_count INT UNSIGNED NOT NULL,
  attachment_count INT UNSIGNED NOT NULL,
  page_version_count INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_workspace_snapshots_user_created (user_id, created_at, id),
  CONSTRAINT fk_workspace_snapshots_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
