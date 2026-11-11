-- Keep completed restore receipts independently of page generations and the
-- short-lived filesystem recovery markers. Never expire them: a delayed retry
-- must not replace edits made after an earlier successful restore.
CREATE TABLE IF NOT EXISTS data_restore_receipts (
  user_id VARCHAR(64) NOT NULL,
  operation_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  archive_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json LONGTEXT NOT NULL CHECK (JSON_VALID(result_json)),
  committed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, operation_id),
  CONSTRAINT fk_data_restore_receipts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
