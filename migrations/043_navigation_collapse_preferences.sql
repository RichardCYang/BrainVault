CREATE TABLE IF NOT EXISTS user_navigation_collapsed_pages (
  user_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, page_id),
  KEY idx_user_navigation_collapsed_pages_page (page_id),
  CONSTRAINT fk_user_navigation_collapsed_pages_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_navigation_collapsed_pages_page
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
