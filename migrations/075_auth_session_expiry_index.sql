ALTER TABLE user_auth_sessions
  ADD INDEX IF NOT EXISTS idx_user_auth_sessions_expiry (expires_at, id);
