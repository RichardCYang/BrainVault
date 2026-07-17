CREATE TABLE IF NOT EXISTS data_restore_markers (
  user_id VARCHAR(64) NOT NULL,
  operation_id VARCHAR(64) NOT NULL,
  committed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, operation_id),
  KEY idx_data_restore_markers_committed (committed_at),
  CONSTRAINT fk_data_restore_markers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
