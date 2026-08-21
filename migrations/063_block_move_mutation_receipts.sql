CREATE TABLE IF NOT EXISTS block_move_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  source_page_id VARCHAR(64) NOT NULL,
  target_page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  moved_block_ids JSON NOT NULL,
  source_page_content_version BIGINT UNSIGNED NOT NULL,
  target_page_content_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_block_move_mutations_block (block_id),
  KEY idx_block_move_mutations_source_page (source_page_id),
  KEY idx_block_move_mutations_target_page (target_page_id),
  CONSTRAINT fk_block_move_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
