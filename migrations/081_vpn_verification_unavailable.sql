-- Keep verification outages distinct from confirmed VPN/proxy detections.
ALTER TABLE user_country_login_blocks
  MODIFY COLUMN reason ENUM(
    'NOT_ALLOWLISTED',
    'BLOCKLISTED',
    'COUNTRY_UNRESOLVED',
    'POLICY_INVALID',
    'VPN_DETECTED',
    'VPN_GATE_DETECTED',
    'PROXY_DETECTED',
    'TOR_DETECTED',
    'TOTP_ATTEMPTS_EXCEEDED',
    'VPN_VERIFICATION_UNAVAILABLE'
  ) NOT NULL;
