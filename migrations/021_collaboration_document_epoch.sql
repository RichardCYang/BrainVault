ALTER TABLE page_collaboration_state
  ADD COLUMN IF NOT EXISTS document_epoch VARCHAR(64) NULL AFTER page_id;

UPDATE page_collaboration_state
SET document_epoch = CONCAT('epoch_', REPLACE(UUID(), '-', ''))
WHERE document_epoch IS NULL OR document_epoch = '';

ALTER TABLE page_collaboration_state
  MODIFY COLUMN document_epoch VARCHAR(64) NOT NULL;
