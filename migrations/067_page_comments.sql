CREATE TABLE IF NOT EXISTS page_comments (
  id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT fk_page_comments_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_comments_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_page_comments_page_created ON page_comments(page_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_page_comments_user ON page_comments(user_id);
