-- Per-account VPN/proxy/Tor access blocking. Extends the existing security block history.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS vpn_block_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER country_login_mode;

ALTER TABLE user_country_login_blocks
  MODIFY COLUMN reason ENUM(
    'NOT_ALLOWLISTED',
    'BLOCKLISTED',
    'COUNTRY_UNRESOLVED',
    'POLICY_INVALID',
    'VPN_DETECTED',
    'PROXY_DETECTED',
    'TOR_DETECTED'
  ) NOT NULL;
