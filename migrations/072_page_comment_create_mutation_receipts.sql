-- Durable comment-create receipts make POST retries idempotent after a lost response.
-- Page/comment foreign keys are intentionally omitted: the receipt must survive
-- page deletion/restore long enough to reject a stale replay against reused IDs.
CREATE TABLE IF NOT EXISTS page_comment_create_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  comment_id VARCHAR(64) NULL,
  actor_workspace_generation BIGINT UNSIGNED NOT NULL,
  workspace_owner_id VARCHAR(64) NOT NULL,
  owner_workspace_generation BIGINT UNSIGNED NOT NULL,
  share_generation VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_page_comment_create_mutations_page (page_id),
  KEY idx_page_comment_create_mutations_comment (comment_id),
  KEY idx_page_comment_create_mutations_owner (workspace_owner_id),
  CONSTRAINT fk_page_comment_create_mutations_actor
    FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
