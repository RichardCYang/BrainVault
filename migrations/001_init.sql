CREATE TABLE IF NOT EXISTS schema_migrations (
  id VARCHAR(255) PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(64) PRIMARY KEY,
  username VARCHAR(50) NOT NULL,
  name VARCHAR(80),
  avatar_data MEDIUMTEXT NULL,
  preferred_language VARCHAR(10) NULL,
  default_collection_icon VARCHAR(32) NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_users_username UNIQUE (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pages (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  icon VARCHAR(32),
  cover_url VARCHAR(500),
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  is_collection TINYINT(1) NOT NULL DEFAULT 0,
  owner_id VARCHAR(64) NOT NULL,
  parent_page_id VARCHAR(64),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pages_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pages_parent FOREIGN KEY (parent_page_id) REFERENCES pages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blocks (
  id VARCHAR(64) PRIMARY KEY,
  page_id VARCHAR(64) NOT NULL,
  parent_block_id VARCHAR(64),
  type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'QUOTE', 'CALLOUT', 'TABLE', 'KANBAN', 'DATABASE', 'BOOKMARK', 'CODE', 'DIVIDER', 'IMAGE', 'ATTACHMENT') NOT NULL DEFAULT 'MARKDOWN',
  markdown TEXT NOT NULL,
  html_cache MEDIUMTEXT,
  checked TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL,
  metadata JSON,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_blocks_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_blocks_parent FOREIGN KEY (parent_block_id) REFERENCES blocks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tags (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_tags (
  page_id VARCHAR(64) NOT NULL,
  tag_id VARCHAR(64) NOT NULL,
  PRIMARY KEY (page_id, tag_id),
  CONSTRAINT fk_page_tags_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_page_tags_tag FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX IF NOT EXISTS idx_pages_owner_updated_at ON pages(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_pages_owner_archived ON pages(owner_id, is_archived);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page_sort ON blocks(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_parent_sort ON blocks(parent_block_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag_id);
CREATE FULLTEXT INDEX IF NOT EXISTS ft_pages_title ON pages(title);
CREATE FULLTEXT INDEX IF NOT EXISTS ft_blocks_markdown ON blocks(markdown);
