CREATE INDEX IF NOT EXISTS idx_login_attempt_retention ON user_login_attempts (attempted_at);
CREATE INDEX IF NOT EXISTS idx_comment_deletion_retention ON page_comment_deletions (deleted_at);
