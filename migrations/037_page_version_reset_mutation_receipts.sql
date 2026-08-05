CREATE TABLE IF NOT EXISTS page_version_reset_mutations (
  owner_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  revision BIGINT UNSIGNED NULL,
  deleted_count BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, mutation_id),
  KEY idx_page_version_reset_mutations_page (page_id),
  CONSTRAINT fk_page_version_reset_mutations_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_version_reset_mutations_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
