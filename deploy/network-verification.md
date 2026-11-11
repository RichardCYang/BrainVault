**English** | [한국어](network-verification.ko.md) | [日本語](network-verification.jp.md)

# TCP/WebSocket measurement for VPN/proxy blocking

The detector compares the original client's TCP RTT at the HTTPS ingress with server-measured WebSocket round trips. It makes no outbound measurement requests and launches no measurement processes. ICMP, ping executables, raw sockets, geographic reference servers, WebRTC discovery and VPN reputation services are not used. Containers do not need `NET_RAW`, `NET_ADMIN`, privileged mode or a ping package for this feature.

## Synology DSM: HTTPS ingress to an HTTP container

The supported deployment path is:

```text
Browser -- HTTPS/WSS --> Synology DSM reverse proxy -- HTTP/WS --> BrainVault container
         client TCP RTT measured here              WebSocket measured end to end
```

The TCP measurement must describe **browser-to-DSM**, obtained on the same client connection that carries the WebSocket upgrade. Measuring the container's socket would describe only DSM-to-container and would produce false positives. A private NAS/Docker address alone does not make a connection unverifiable. The public client address and valid ingress TCP information are required for a comparison.

In DSM, edit the BrainVault reverse-proxy rule under **Control Panel > Login Portal > Advanced > Reverse Proxy**. Keep the source as HTTPS and the destination as the private container HTTP address. Under **Custom Header**, use **Create > WebSocket**. Preserve `Origin` and forward `X-Forwarded-Proto: https` and the actual client address through the existing trusted forwarding chain. Synology documents the WebSocket/custom-header controls in its [DSM reverse-proxy guide](https://kb.synology.com/en-in/DSM/help/DSM/AdminCenter/system_login_portal_advanced).

Configure the following **request** headers at the HTTPS ingress, overwriting incoming values:

| Header | NGINX value | Purpose |
| --- | --- | --- |
| `X-BrainVault-TCP-Peer-IP` | `$remote_addr` | Actual transport peer of the client connection |
| `X-BrainVault-TCP-RTT-Us` | `$tcpinfo_rtt` | Kernel TCP RTT, in microseconds |
| `X-BrainVault-TCP-RTTVar-Us` | `$tcpinfo_rttvar` | Kernel TCP RTT variation, in microseconds |

These variables come from NGINX's [TCP_INFO support](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_tcpinfo_rtt); [NGINX's implementation](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_variables.c) passes the kernel RTT and variation in microseconds. DSM versions and builds differ: custom-header controls alone do not guarantee that these variables are available or expanded. Verify that the generated proxy configuration evaluates them and that the backend receives numeric values on the WebSocket upgrade. A literal `$tcpinfo_rtt`, an empty value, or zero RTT is rejected. Do not substitute fixed RTT values. If the DSM build cannot supply TCP_INFO, this deployment needs an ingress with TCP_INFO support at the original client connection; adding NGINX **behind** DSM does not recover it. No changes to the NAS itself are made by this repository.

Equivalent NGINX configuration is included in [nginx.conf.example](nginx.conf.example). If NGINX `real_ip` rewrites `$remote_addr`, use `$realip_remote_addr` for `X-BrainVault-TCP-Peer-IP` to retain the original transport peer. That peer must equal the verified client IP. A CDN or another TCP-terminating proxy in front of DSM measures a different connection; forwarding its client-IP assertion does not turn DSM's TCP RTT into the browser's RTT. Mismatching observations are rejected.

After all three headers are generated and overwritten correctly, configure the container, using the peer address it actually sees:

```env
HTTPS_MODE=proxy
PUBLIC_ORIGIN="https://notes.example.com"
TRUST_PROXY_ADDRESSES="172.18.0.1"
TRUST_PROXY_HOPS=0
TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=false
VPN_TRUST_PROXY_TCP_INFO=true
VPN_PROXY_RTT_MARGIN_MS=10
VPN_MIN_EXCESS_RTT_MS=50
```

Use the narrowest practical proxy trust rule and keep the container HTTP port private. Explicit TCP_INFO trust defaults to **false**, because a normal proxy can forward attacker-supplied custom headers. Enable it only after overwrite rules are installed. Duplicate headers, malformed values, untrusted peers, non-HTTPS forwarding, invalid forwarding chains and mismatching transport/client IPs cannot supply TCP evidence. Forward WebSocket upgrades for both `/api/network-verification/probe` and `/api/collaboration/`.

In account security settings, use **Measure connection again**. A working configuration shows **Client TCP RTT measured at the trusted ingress** and the measured WebSocket/TCP RTTs. The interface distinguishes disabled TCP information, missing TCP RTT and mismatching client information. Test from an external connection: the intentional local-network exemption does not validate the public ingress setup. The application does not publish measurement values or thresholds through its pre-authentication endpoints.

## Measurements and decisions

The browser requests a same-origin, one-use ticket and opens `/api/network-verification/probe`. The server captures TCP_INFO metadata on that upgrade, sends twelve unpredictable WebSocket protocol ping frames and times matching pong frames with its monotonic clock. These are TCP-based WebSocket control frames, not network ICMP packets. The browser submits only an opaque completion receipt; client-supplied RTTs and verdicts are ignored.

Two consecutive six-sample WebSocket windows are compared with the genuine ingress TCP snapshot. Both windows must exceed TCP RTT by the configured minimum plus the local-proxy margin and three times TCP RTT variation for `TUNNEL`. High RTT alone does not trigger detection. Noisy WebSocket timing, high TCP variation and incompatible estimates produce `INCONCLUSIVE`. Missing TCP evidence produces `UNKNOWN`, with any completed WebSocket samples retained. A single TCP snapshot is not represented as multiple independent transport measurements.

Completed probes redeem one-use receipts for opaque HttpOnly, SameSite=Strict cookies, Secure and `__Host-` prefixed on HTTPS. Evidence is bound to the browser handle and exact normalized client IP, expires after five minutes, and refreshes while the page is visible. Separate browsers sharing a NAT do not share verdicts. Password login, MFA, passkeys, authenticated requests and collaboration rechecks enforce this evidence.

## Policy and limits

| Setting | Default | Meaning |
| --- | --- | --- |
| `VPN_TRUST_PROXY_TCP_INFO` | `false` | Accept overwritten TCP_INFO from the explicitly trusted local HTTPS ingress |
| `VPN_MIN_EXCESS_RTT_MS` | `50` | Minimum repeated extra delay in milliseconds; not a confidence percentage |
| `VPN_PROXY_RTT_MARGIN_MS` | `10` | Extra uncertainty for the local reverse-proxy hop |
| `VPN_ALLOW_PRIVATE_NETWORK` | `true` | Preserve direct LAN access; forwarded private clients also need `TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=true` |
| `VPN_POLICY_FAIL_CLOSED` | `true` | Refuse access for accounts with blocking enabled when measurement evidence is unavailable |

Unavailability is not a detected tunnel. With fail-closed enabled, it can still prevent access under an account's blocking policy. False allows measurement failures without overriding detected tunnels. Accounts with blocking disabled remain accessible. Enabling a policy is refused if it would immediately block the current connection. Existing password/MFA and session-revocation protections still apply. Historical block records and separate country-login restrictions remain readable.

Resource limits include 32 active measurement sockets globally, four per source IP, 30 tickets per minute per source IP, bounded expiring maps, a twelve-second measurement deadline, and twelve WebSocket samples. Ticket subprotocols, receipts and cookies must stay out of logs. A failed browser measurement can delay a subsequent protected request by approximately twenty seconds. No additional container capabilities or external reference lists are needed.

## Detection scope

This comparison can expose a stable extra path when TCP is split at a relay but the WebSocket stream continues to the browser. It cannot reliably identify every residential VPN. WireGuard/OpenVPN and other tunnels can forward the client's TCP connection end to end, making TCP RTT and WebSocket RTT increase together. A nearby relay or one that answers WebSocket control frames itself can also evade this comparison. `CLEAR` means no extra TCP/WebSocket gap was observed; it does not certify the absence of a VPN. Network load and ingress scheduling can affect both timings. Calibrate with labeled direct, mobile, congested, local-proxy and residential-VPN traffic, and measure false positives and evidence availability separately. No deployment accuracy percentage is claimed.

Direct Node.js HTTPS currently has WebSocket measurements but no native TCP_INFO collector. It reports `DIRECT_TCP_INFO_UNAVAILABLE`; request headers cannot substitute for kernel socket data. The implemented TCP collector targets the DSM/NGINX ingress deployment above.
