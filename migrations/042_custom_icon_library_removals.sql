CREATE TABLE IF NOT EXISTS custom_icon_library_removals (
  user_id VARCHAR(64) NOT NULL,
  value_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  removed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, value_hash),
  KEY idx_custom_icon_library_removals_user_removed (user_id, removed_at),
  CONSTRAINT fk_custom_icon_library_removals_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
