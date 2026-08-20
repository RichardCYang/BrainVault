-- Fence collaborator revocation from remove/re-add races.
-- A share row can be deleted and recreated under the same (page_id, user_id)
-- primary key. Give each logical grant a new generation so a delayed DELETE
-- cannot revoke the replacement grant.
ALTER TABLE page_shares
  ADD COLUMN IF NOT EXISTS generation VARCHAR(64) NULL AFTER shared_by;

UPDATE page_shares
SET generation = CONCAT(
  'share_',
  LEFT(
    SHA2(
      CONCAT(
        page_id,
        CHAR(0),
        user_id,
        CHAR(0),
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%f')
      ),
      256
    ),
    32
  )
)
WHERE generation IS NULL OR generation = '';

ALTER TABLE page_shares
  MODIFY COLUMN generation VARCHAR(64) NOT NULL;
