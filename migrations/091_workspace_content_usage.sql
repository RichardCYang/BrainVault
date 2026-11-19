ALTER TABLE page_collaboration_state ADD COLUMN IF NOT EXISTS pending_content_growth BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS page_storage_usage (
  page_id VARCHAR(64) NOT NULL PRIMARY KEY,
  owner_id VARCHAR(64) NOT NULL,
  content_bytes BIGINT UNSIGNED NOT NULL,
  history_bytes BIGINT UNSIGNED NOT NULL,
  KEY idx_storage_usage_owner (owner_id),
  CONSTRAINT fk_storage_usage_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO page_storage_usage (page_id, owner_id, content_bytes, history_bytes)
SELECT p.id, p.owner_id,
       768 + OCTET_LENGTH(p.title) + COALESCE(OCTET_LENGTH(p.icon), 0) + COALESCE(OCTET_LENGTH(p.cover_url), 0)
       + COALESCE((SELECT SUM(384 + OCTET_LENGTH(JSON_QUOTE(b.markdown)) + COALESCE(OCTET_LENGTH(JSON_QUOTE(b.metadata)), 0)) FROM blocks b WHERE b.page_id = p.id), 0)
       + COALESCE((SELECT SUM(384 + OCTET_LENGTH(JSON_QUOTE(c.body))) FROM page_comments c WHERE c.page_id = p.id), 0)
       + (SELECT COUNT(*) * 256 FROM page_tags pt WHERE pt.page_id = p.id) AS content_bytes,
       COALESCE((SELECT SUM(256 + OCTET_LENGTH(v.actors) + OCTET_LENGTH(v.change_summary) + OCTET_LENGTH(v.changes)) FROM page_versions v WHERE v.page_id = p.id), 0) AS history_bytes
FROM pages p
ON DUPLICATE KEY UPDATE content_bytes = VALUES(content_bytes), history_bytes = VALUES(history_bytes);
