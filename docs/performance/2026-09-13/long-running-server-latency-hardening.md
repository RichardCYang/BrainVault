# Long-running server latency hardening

## Symptom

After BrainVault remains online for a long period, the first document load can become noticeably slower and direct passkey login can spend time after the button click before the browser's native WebAuthn dialog appears. Restarting the application process temporarily removes the delay.

## Root causes addressed

### 1. MariaDB pool retained the entire fixed pool while idle

MariaDB Connector/Node.js defaults `minimumIdle` to `connectionLimit`, so every connection created during a burst can remain resident. Long-idle connections can later require validation/replacement when a database server, proxy, NAT, or network path has expired them. BrainVault's direct passkey options endpoint must persist its challenge before returning options, so a stale pool checkout is visible as pre-dialog latency.

BrainVault now keeps one minimum idle connection, retires surplus connections after 30 seconds, and enables TCP keepalive on database sockets. The existing minute-level auth-session prune naturally exercises the remaining minimum connection. This limits the number of long-idle sockets that can sit in the pool while keeping a warm connection available.

### 2. VPN provider facts became synchronously stale every five minutes

Bulk Tor/VPN Gate directories already used bounded stale-while-revalidate, but per-IP `ipquery`/`ipapi` results did not. Once the five-minute freshness window expired, the next authenticated request could synchronously inherit external provider latency.

Previously verified facts for the same exact IP now use a bounded stale window and revalidate in the background. Cold or too-old entries still perform synchronous verification. Provider-unavailable results get only a short two-minute stale bound.

### 3. Successful country lookups synchronously revalidated after ten minutes

When country-login restrictions are enabled, a successful exact-IP country mapping used to synchronously call the external country provider after its ten-minute cache expired. A previously successful exact-IP mapping now gets a bounded background revalidation window. Provider failures, unresolved lookups, cold lookups, and too-old entries retain fail-closed synchronous behavior.

### 4. Passkey intent warm-up expired too aggressively

The passkey options endpoint must create and persist a one-time challenge before `navigator.credentials.get()` can run. Existing pointer/focus intent warming was correct, but its 45-second reuse window was much shorter than the server's five-minute challenge lifetime. The client now keeps a ready intent-warmed challenge for three minutes, leaving at least two minutes for the native ceremony and verification while avoiding unnecessary repeat option requests.

## Security properties retained

- Passkey challenges remain one-time, bound to the ceremony cookie/source IP, persisted before use, and expire after five minutes.
- No unconditional anonymous passkey prefetch was added, so shared-IP rate-limit budget is not consumed merely by viewing the login page.
- VPN/country stale serving is keyed to the exact normalized public IP and is time-bounded.
- Failed/unresolved country resolution is not extended with the successful-country stale window.
- Cold and too-old policy facts still use synchronous verification.

## Verification

The regression suite includes `tests/long-running-server-latency.node.test.mjs` to pin the database-pool lifecycle, network-policy background revalidation, and passkey warm-up bounds.
