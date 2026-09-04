# VPN / Proxy Access Blocking

Date: 2026-08-10

## Scope

BrainVault supports an opt-in per-account security policy that rejects authenticated access and login completion when the source public IP is identified with high confidence as a VPN, proxy, Tor exit, or verified public VPN relay.

The policy is exposed under Account Settings -> Security. Changing the policy requires the current account password and rotates the authentication version so other sessions and collaboration connections are revoked.

## Detection sources

The implementation intentionally uses only sources that can be queried without a paid subscription or login/API key:

- A primary IP-intelligence source provides VPN, proxy, Tor, datacenter, risk-score, country, and timezone information.
- A secondary IP-intelligence source is used only as a conditional second opinion when the primary result is suspicious, when a public-relay directory entry needs independent corroboration, or when other supporting risk signals justify the extra request.
- The Tor Project's public `exit-addresses` export is downloaded as a whole and cached locally. This allows an authoritative Tor-exit match without sending each user's IP to Tor.
- A public volunteer-relay CSV directory is cached locally and used to identify currently advertised public VPN relays.

All provider requests have short timeouts, response-size limits, IP-response validation, in-flight request de-duplication where appropriate, and local result caches.

## Public-relay-specific layer

A source IP that appears in the public-relay CSV directory is not automatically blocked. The directory may contain incorrect or stale IP addresses, and public volunteer relays may use dynamic residential addresses. To reduce false positives BrainVault requires one of these additional confirmations:

1. The relay's provider-managed DDNS hostname currently resolves back to the same source IP. This is treated as a high-confidence current public-relay match.
2. If DDNS verification is unavailable, an independent IP-intelligence provider must also flag the same address as VPN, proxy, or Tor.

A directory-only match that cannot be independently verified is returned as `UNKNOWN` and is not blocked.

Verified public-relay blocks are written to the existing block-history table with a dedicated relay-detection reason, including the source IP and country when available. The account-security UI distinguishes this from a generic VPN-detection result and shows whether the relay match was DDNS-verified or corroborated by IP intelligence.

The public-relay directory is refreshed every five minutes. A failed refresh is retained for no longer than fifteen minutes, because volunteer endpoints can be dynamic and an old residential IP may be reassigned. Matching DDNS lookups are bounded by a short timeout and are performed only after an IP appears in the cached directory; BrainVault does not scan arbitrary client IP ports or actively probe them for relay software.

## Decision policy

The policy favors false-positive resistance:

- A match in the Tor Project exit list blocks immediately.
- A Tor provider consensus/direct high-confidence result blocks.
- A public-relay directory match whose provider-managed DDNS currently resolves to the source IP blocks with the dedicated relay-detection reason.
- A public-relay directory match corroborated by an independent VPN/proxy/Tor provider signal blocks with the dedicated relay-detection reason.
- A public-relay directory-only match that is not independently verified does not block.
- Multiple agreeing VPN/proxy/Tor provider signals block.
- A single direct VPN/proxy/Tor flag blocks only when that is the only available provider result; if two providers are available and disagree, the result is `UNKNOWN` and is not blocked.
- Datacenter/hosting status, provider risk score, and browser-vs-IP timezone offset are supporting signals only. They never independently cause a block.
- Provider outages or ambiguous results fail open as `UNKNOWN` rather than locking out a legitimate user.

Generic positive results are cached for 10 minutes, verified public-relay positives for 2 minutes because volunteer residential IPs can change quickly, clear results for 5 minutes, and unknown results for 1 minute.

## Timezone signal

The browser sends its current IANA timezone using `Intl.DateTimeFormat().resolvedOptions().timeZone`. The server compares its current UTC offset with the IP-geolocation timezone. A difference of at least three hours is exposed as a supporting signal.

This signal is deliberately not treated as proof of VPN use because it can be spoofed and can also be legitimate when a user is traveling, has an unusual device timezone, or connects near a timezone border.

## WebRTC STUN network verification
BrainVault now performs a browser-side ICE candidate-gathering check with `RTCPeerConnection` and the configured public STUN endpoint. It creates a data channel only; it does not request camera or microphone access. The browser collects only server-reflexive (`srflx`) ICE candidate addresses and sends a bounded list of those observed public IP addresses with subsequent BrainVault API requests.
The server normalizes and validates the browser-provided addresses and compares the HTTP source IP against every observed STUN address. This supports dual-stack clients where IPv4 and IPv6 server-reflexive candidates can both be gathered. An exact match is exposed as `WEBRTC_HTTP_IP_MATCH`. If WebRTC returns one or more valid public `srflx` addresses and none match the HTTP source IP, BrainVault exposes `WEBRTC_HTTP_IP_MISMATCH` and requests the conditional secondary IP-intelligence cross-check.
A WebRTC/HTTP IP mismatch is deliberately not a standalone block reason. It changes an otherwise clean decision to `UNKNOWN`, because browser ICE can use a different path from HTTPS in some legitimate multi-homed, split-tunnel, enterprise, mobile, or IPv4/IPv6 environments. Existing high-confidence VPN/proxy/Tor/public-relay evidence remains responsible for an actual block.
When `RTCPeerConnection` is unavailable or browser policy rejects its use, the browser reports WebRTC as `DISABLED`. When WebRTC exists but no usable STUN observation can be collected before completion/timeout, it reports `UNAVAILABLE`. Both states are supporting risk signals only (`WEBRTC_DISABLED` / `WEBRTC_STUN_UNAVAILABLE`) and cannot independently block an account; they only lower clear-result confidence and trigger the same conditional second-opinion lookup.
The browser result is cached briefly to avoid running ICE gathering on every API call. Collaboration WebSockets cannot attach arbitrary browser headers, so the immediately preceding authenticated collaboration-session HTTP request sanitizes the WebRTC signal and embeds it in the short-lived signed collaboration ticket; WebSocket admission and periodic VPN-policy checks then reuse that signed value.
### Trust and privacy boundary
The WebRTC observation is supplemental telemetry, not cryptographic proof. A modified client can forge its own BrainVault request headers, so the server never treats a claimed match as sufficient evidence that a connection is safe and never treats a mismatch/disabled state as sufficient evidence to block. A production deployment that needs stronger attestation would require a server-controlled correlation mechanism rather than trusting browser-returned candidate text.
Running the STUN check sends a STUN Binding request from the browser network path to the configured STUN service, which necessarily exposes that network path's translated source address to the STUN service. Operators should account for that third-party network contact in their privacy documentation.

## Enforcement points

When enabled, VPN/proxy/Tor/public-relay enforcement runs at the same account-security boundaries as country access controls:

- password login before MFA/session completion;
- passkey direct login;
- MFA TOTP and passkey login completion paths;
- every authenticated HTTP API request through `requireAuth`;
- collaboration WebSocket upgrade, connection validation, and periodic access revalidation.

A blocked attempt is stored in the existing `user_country_login_blocks` history table with the source IP, detected country (when available), timestamp, and the applicable VPN, verified-relay, proxy, or Tor detection reason. The existing Account Settings -> Block History tab renders those records.

## Important protocol limitation

Some relay software supports Ethernet-over-HTTPS as well as multiple other VPN protocols. An ordinary BrainVault HTTPS application server, however, receives the connection after an upstream VPN relay has already forwarded the browser traffic. It does not see the original user-to-relay tunnel packets, so a private self-hosted relay that is absent from public VPN data cannot be proven merely by performing deeper inspection of the BrainVault-side HTTPS packets.

The public-relay layer improves coverage for relay servers that opt into the public directory, because those relays register themselves there. Private relay servers that do not register remain subject to the generic IP-intelligence, Tor, datacenter, timezone, and behavior signals; they cannot be guaranteed to be detected at the application layer.

BrainVault deliberately does not actively connect to or port-scan a visitor's source IP to guess whether relay software is listening there. Such probing would be noisy, unreliable for NAT/mobile users, and would still not prove that the current web request traversed that server.

## Database migrations

Migration `046_vpn_access_policy.sql` adds `users.vpn_block_enabled` and the generic VPN/proxy/Tor block-history reasons.

A follow-up relay-detection migration adds a distinct verified-relay history reason without changing the account-setting schema.

## Upstream references

- WebRTC specification (`RTCIceCandidate` / ICE gathering): `https://www.w3.org/TR/webrtc/`
- ICE / server-reflexive candidate definition: `https://www.rfc-editor.org/rfc/rfc8445`
- STUN specification: `https://www.rfc-editor.org/rfc/rfc8489`
- Public STUN service address and port guidance
