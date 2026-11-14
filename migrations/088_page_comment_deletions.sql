-- A deleted comment used to be gone at once, even when a page owner deleted
-- someone else's comment. Its row is now kept here for a while so the person
-- who deleted it can undo that. Rows go with their page and are pruned after
-- 30 days. They are recovery data only and are not part of backups.
CREATE TABLE IF NOT EXISTS page_comment_deletions (
  id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  edit_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  deleted_by VARCHAR(64) NOT NULL,
  deleted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_page_comment_deletions_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_comment_deletions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_page_comment_deletions_page_deleted ON page_comment_deletions(page_id, deleted_at);
