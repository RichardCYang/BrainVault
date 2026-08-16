-- Recovery grants deliberately do not reference pages/users with foreign keys.
-- They must survive page deletion, share revocation, and workspace restore long
-- enough for an offline browser to upload its last durable local recovery copy.
CREATE TABLE IF NOT EXISTS page_recovery_grants (
  page_id VARCHAR(64) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  lineage_key VARCHAR(96) NOT NULL,
  reason ENUM('SHARE_STARTED', 'SHARE_REMOVED', 'PAGE_DELETED', 'WORKSPACE_RESTORED') NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  purged_at DATETIME(6) NULL,
  PRIMARY KEY (page_id, principal_id, lineage_key),
  INDEX idx_page_recovery_grants_owner (owner_id, updated_at),
  INDEX idx_page_recovery_grants_principal (principal_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS page_recovery_candidates (
  id VARCHAR(64) NOT NULL,
  page_id VARCHAR(64) NOT NULL,
  principal_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  lineage_key VARCHAR(96) NOT NULL,
  kind ENUM('DIRECT_DRAFT', 'YJS_UPDATE', 'YJS_LEGACY_UPDATE') NOT NULL,
  source_id VARCHAR(128) NOT NULL,
  generation VARCHAR(128) NOT NULL,
  payload LONGBLOB NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY uq_page_recovery_candidate_payload
    (page_id, principal_id, lineage_key, kind, payload_sha256),
  INDEX idx_page_recovery_candidates_owner (owner_id, created_at),
  INDEX idx_page_recovery_candidates_principal (principal_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
