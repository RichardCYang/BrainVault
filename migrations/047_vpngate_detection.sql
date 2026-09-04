-- Distinguish high-confidence public relay blocks in the existing security history.
ALTER TABLE user_country_login_blocks
  MODIFY COLUMN reason ENUM(
    'NOT_ALLOWLISTED',
    'BLOCKLISTED',
    'COUNTRY_UNRESOLVED',
    'POLICY_INVALID',
    'VPN_DETECTED',
    'VPN_GATE_DETECTED',
    'PROXY_DETECTED',
    'TOR_DETECTED'
  ) NOT NULL;
