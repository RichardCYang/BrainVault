CREATE TABLE IF NOT EXISTS page_collaboration_write_leases (
  lease_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  document_epoch VARCHAR(64) NOT NULL,
  expires_at DATETIME(6) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (lease_id),
  INDEX idx_collaboration_write_leases_page (page_id, expires_at),
  CONSTRAINT fk_collaboration_write_leases_page
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
