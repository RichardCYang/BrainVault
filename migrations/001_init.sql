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
  failed_login_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_failed_login_at DATETIME(3) NULL,
  login_locked_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_users_username UNIQUE (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pages (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  icon VARCHAR(32),
  cover_url MEDIUMTEXT,
  cover_position_x TINYINT UNSIGNED NOT NULL DEFAULT 50,
  cover_position_y TINYINT UNSIGNED NOT NULL DEFAULT 50,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  is_collection TINYINT(1) NOT NULL DEFAULT 0,
  owner_id VARCHAR(64) NOT NULL,
  parent_page_id VARCHAR(64),
  edit_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  content_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  last_mutation_id VARCHAR(64) NULL,
  last_mutation_hash CHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pages_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_pages_parent FOREIGN KEY (parent_page_id) REFERENCES pages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE IF NOT EXISTS user_navigation_page_order (
  user_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  sort_order INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, page_id),
  KEY idx_user_navigation_page_order_sort (user_id, sort_order, page_id),
  KEY idx_user_navigation_page_order_page (page_id),
  CONSTRAINT fk_user_navigation_page_order_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_navigation_page_order_page
    FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_version_reset_mutations (
  owner_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  revision BIGINT UNSIGNED NULL,
  deleted_count BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, mutation_id),
  KEY idx_page_version_reset_mutations_page (page_id),
  CONSTRAINT fk_page_version_reset_mutations_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_create_mutations (
  owner_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_id, mutation_id),
  KEY idx_page_create_mutations_page (page_id),
  CONSTRAINT fk_page_create_mutations_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS blocks (
  id VARCHAR(64) PRIMARY KEY,
  page_id VARCHAR(64) NOT NULL,
  parent_block_id VARCHAR(64),
  type ENUM('MARKDOWN', 'HEADING_1', 'HEADING_2', 'HEADING_3', 'TODO', 'UNORDERED_LIST', 'ORDERED_LIST', 'QUOTE', 'CALLOUT', 'TOGGLE', 'ACCORDION', 'TABLE', 'KANBAN', 'DATABASE', 'TREEVIEW', 'TIMETABLE', 'GANTT', 'BOOKMARK', 'AI_CHAT', 'MATH', 'CODE', 'DIVIDER', 'IMAGE', 'VIDEO', 'ATTACHMENT') NOT NULL DEFAULT 'MARKDOWN',
  markdown TEXT NOT NULL,
  html_cache MEDIUMTEXT,
  checked TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL,
  metadata JSON,
  edit_version BIGINT UNSIGNED NOT NULL DEFAULT 1,
  last_mutation_id VARCHAR(64) NULL,
  last_mutation_hash CHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT uq_blocks_id_page UNIQUE (id, page_id),
  CONSTRAINT fk_blocks_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE,
  CONSTRAINT fk_blocks_parent_page FOREIGN KEY (parent_block_id, page_id) REFERENCES blocks(id, page_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_delete_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  page_ids JSON NOT NULL,
  attachment_ids JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_page_delete_mutations_page (page_id),
  CONSTRAINT fk_page_delete_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS block_create_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_block_create_mutations_page (page_id),
  KEY idx_block_create_mutations_block (block_id),
  CONSTRAINT fk_block_create_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS block_delete_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  page_content_version BIGINT UNSIGNED NOT NULL,
  attachment_ids JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_block_delete_mutations_page (page_id),
  KEY idx_block_delete_mutations_block (block_id),
  CONSTRAINT fk_block_delete_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_block_delete_mutations_page FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS block_move_mutations (
  actor_id VARCHAR(64) NOT NULL,
  mutation_id VARCHAR(64) NOT NULL,
  block_id VARCHAR(64) NOT NULL,
  source_page_id VARCHAR(64) NOT NULL,
  target_page_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  moved_block_ids JSON NOT NULL,
  source_page_content_version BIGINT UNSIGNED NOT NULL,
  target_page_content_version BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (actor_id, mutation_id),
  KEY idx_block_move_mutations_block (block_id),
  KEY idx_block_move_mutations_source_page (source_page_id),
  KEY idx_block_move_mutations_target_page (target_page_id),
  CONSTRAINT fk_block_move_mutations_actor FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE
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
CREATE INDEX IF NOT EXISTS idx_pages_owner_archived_created ON pages(owner_id, is_archived, created_at, id);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page_sort ON blocks(page_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_blocks_parent_sort ON blocks(parent_block_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_page_tags_tag ON page_tags(tag_id);
CREATE FULLTEXT INDEX IF NOT EXISTS ft_pages_title ON pages(title);
CREATE FULLTEXT INDEX IF NOT EXISTS ft_blocks_markdown ON blocks(markdown);
