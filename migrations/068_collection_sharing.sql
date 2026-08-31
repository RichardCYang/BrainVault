-- Collection administrators can permanently delete pages owned by the
-- collection owner. Persist the workspace owner in the idempotency receipt so
-- an ambiguous HTTP retry can safely finish attachment cleanup in that owner's
-- storage generation instead of the acting administrator's workspace.
ALTER TABLE page_delete_mutations
  ADD COLUMN IF NOT EXISTS workspace_owner_id VARCHAR(64) NULL AFTER attachment_generation;

CREATE TABLE IF NOT EXISTS collection_shares (
  collection_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  permission ENUM('READ', 'WRITE', 'ADMIN') NOT NULL,
  shared_by VARCHAR(64) NOT NULL,
  generation VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (collection_id, user_id),
  CONSTRAINT fk_collection_shares_collection FOREIGN KEY (collection_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_shares_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_collection_shares_shared_by FOREIGN KEY (shared_by) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_collection_shares_user ON collection_shares(user_id, collection_id);

CREATE TABLE IF NOT EXISTS page_collection_memberships (
  page_id VARCHAR(64) NOT NULL,
  collection_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (page_id),
  KEY idx_page_collection_memberships_collection (collection_id, page_id),
  CONSTRAINT fk_page_collection_memberships_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_collection_memberships_collection FOREIGN KEY (collection_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO page_collection_memberships (page_id, collection_id)
WITH RECURSIVE collection_tree AS (
  SELECT p.id AS page_id, p.id AS collection_id, 0 AS depth
  FROM pages p
  WHERE p.is_collection = 1
  UNION ALL
  SELECT child.id AS page_id, collection_tree.collection_id, collection_tree.depth + 1
  FROM pages child
  INNER JOIN collection_tree ON child.parent_page_id = collection_tree.page_id
  WHERE collection_tree.depth < 256
)
SELECT page_id, collection_id FROM collection_tree;
