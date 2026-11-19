-- Restore IDs outlive their live rows. Keep ownership with the workspace so
-- its backups remain restorable after deleting a page or replacing its data.
CREATE TABLE IF NOT EXISTS backup_resource_owners (
  kind ENUM('page','block','comment') NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (kind, resource_id),
  CONSTRAINT fk_backup_resource_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO backup_resource_owners SELECT 'page', id, owner_id FROM pages;
INSERT IGNORE INTO backup_resource_owners SELECT 'block', b.id, p.owner_id FROM blocks b JOIN pages p ON p.id = b.page_id;
INSERT IGNORE INTO backup_resource_owners SELECT 'comment', c.id, p.owner_id FROM page_comments c JOIN pages p ON p.id = c.page_id;
INSERT IGNORE INTO backup_resource_owners SELECT 'comment', c.id, p.owner_id FROM page_comment_deletions c JOIN pages p ON p.id = c.page_id;
