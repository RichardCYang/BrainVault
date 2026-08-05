CREATE TABLE IF NOT EXISTS block_delete_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  page_content_version BIGINT UNSIGNED NOT NULL,
  attachment_ids JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_block_delete_mutations_page (page_id),
  KEY idx_block_delete_mutations_block (block_id),
  CONSTRAINT fk_block_delete_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_block_delete_mutations_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
