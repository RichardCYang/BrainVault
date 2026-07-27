CREATE TABLE IF NOT EXISTS page_shares (
  page_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  permission ENUM('EDIT') NOT NULL DEFAULT 'EDIT',
  shared_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (page_id, user_id),
  CONSTRAINT fk_page_shares_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_shares_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_shares_shared_by FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_page_shares_user_page ON page_shares(user_id, page_id);

CREATE TABLE IF NOT EXISTS page_yjs_updates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  page_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  update_data LONGBLOB NOT NULL,
  is_snapshot TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_page_yjs_updates_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_page_yjs_updates_page_id ON page_yjs_updates(page_id, id);

CREATE TABLE IF NOT EXISTS page_collaboration_state (
  page_id VARCHAR(64) NOT NULL,
  materialized_update_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  materialized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (page_id),
  CONSTRAINT fk_page_collaboration_state_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
