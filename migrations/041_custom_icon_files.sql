CREATE TABLE IF NOT EXISTS custom_icons (
  id VARCHAR(64) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  file_path VARCHAR(512) NOT NULL,
  last_used_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_custom_icons_user_path UNIQUE (user_id, file_path),
  KEY idx_custom_icons_user_last_used (user_id, last_used_at),
  CONSTRAINT fk_custom_icons_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
