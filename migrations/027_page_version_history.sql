CREATE TABLE IF NOT EXISTS page_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  page_id VARCHAR(64) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  page_edit_version BIGINT UNSIGNED NOT NULL,
  page_content_version BIGINT UNSIGNED NOT NULL,
  actors JSON NOT NULL,
  source VARCHAR(32) NOT NULL,
  change_count INT UNSIGNED NOT NULL DEFAULT 0,
  change_summary JSON NOT NULL,
  changes JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT uq_page_versions_revision UNIQUE (page_id, revision),
  CONSTRAINT fk_page_versions_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_page_versions_page_id ON page_versions(page_id, id);

INSERT INTO page_versions
  (page_id, revision, page_edit_version, page_content_version, actors, source,
   change_count, change_summary, changes, created_at)
SELECT
  p.id,
  1,
  p.edit_version,
  p.content_version,
  JSON_ARRAY(JSON_OBJECT('id', u.id, 'username', u.username, 'name', u.name)),
  'BASELINE',
  1,
  JSON_OBJECT(
    'baseline', 1,
    'pageCreated', 0,
    'pageFields', JSON_ARRAY(),
    'blocksCreated', 0,
    'blocksUpdated', 0,
    'blocksDeleted', 0,
    'blocksMoved', 0
  ),
  JSON_ARRAY(JSON_OBJECT(
    'kind', 'history-started',
    'page', JSON_OBJECT(
      'title', p.title,
      'icon', p.icon,
      'coverUrl', p.cover_url,
      'isArchived', IF(p.is_archived = 1, TRUE, FALSE),
      'isCollection', IF(p.is_collection = 1, TRUE, FALSE),
      'parentPageId', p.parent_page_id
    )
  )),
  CURRENT_TIMESTAMP(3)
FROM pages p
INNER JOIN users u ON u.id = p.owner_id
WHERE NOT EXISTS (
  SELECT 1 FROM page_versions existing WHERE existing.page_id = p.id
);
