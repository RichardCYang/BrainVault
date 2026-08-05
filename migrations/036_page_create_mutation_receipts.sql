CREATE TABLE IF NOT EXISTS page_create_mutations (
  owner_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, mutation_id),
  KEY idx_page_create_mutations_page (page_id),
  CONSTRAINT fk_page_create_mutations_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
