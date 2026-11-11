**English** | [한국어](network-verification.ko.md) | [日本語](network-verification.jp.md)

# VPN/proxy blocking: connection measurement

BrainVault can block sign-ins that appear to come through a VPN or proxy. It does this by comparing two delay (RTT) measurements of the same browser connection. This guide explains how to set it up and what it can and cannot detect.

## Contents

- [At a glance](#at-a-glance)
- [How it works](#how-it-works)
- [Setup on Synology DSM](#setup-on-synology-dsm)
- [Other ingress setups](#other-ingress-setups)
- [Troubleshooting](#troubleshooting)
- [Settings reference](#settings-reference)
- [How a result is decided](#how-a-result-is-decided)
- [Limits](#limits)

## At a glance

- **Requires a reverse proxy** (HTTPS ingress) that can report TCP_INFO for the browser's connection. Direct HTTPS mode cannot provide this ([details](#direct-https-mode)).
- **Needs nothing extra in the container.** No ICMP, ping, raw sockets, `NET_RAW`, `NET_ADMIN`, or privileged mode. BrainVault sends no outbound measurement requests and uses no external services (no geographic reference servers, WebRTC discovery, or VPN reputation lists).
- **Off by default.** You enable trust in the TCP measurement only after the proxy is configured correctly.
- **Not a perfect VPN detector.** Many VPNs cannot be detected this way ([details](#what-it-can-and-cannot-detect)).

New to the base HTTPS setup? Complete the [HTTPS deployment guide](README.md) first.

## How it works

```text
Browser -- HTTPS/WSS --> Synology DSM reverse proxy -- HTTP/WS --> BrainVault container
         ① TCP RTT measured here                   ② WebSocket RTT measured end to end
```

1. **TCP RTT**: the proxy reads the kernel's delay for the browser→proxy connection and passes it to BrainVault in request headers.
2. **WebSocket RTT**: BrainVault measures the round trip all the way to the browser.
3. **Compare**: if the WebSocket delay is consistently much larger than the TCP delay, there is probably an extra relay (for example a VPN or proxy server) in between.

> [!IMPORTANT]
> The TCP measurement must be taken on the **browser→proxy** connection, the same connection that carries the WebSocket upgrade. Measuring the proxy→container connection would describe only the internal hop and cause false positives.

A private NAS or Docker address is fine. What matters is that BrainVault receives the browser's public address and valid TCP information from the ingress.

## Setup on Synology DSM

### Step 1. Prepare the reverse-proxy rule

In DSM, open **Control Panel > Login Portal > Advanced > Reverse Proxy** and edit the BrainVault rule (see the [HTTPS deployment guide](README.md#synology-dsm-reverse-proxy) if you have none yet).

- Source: HTTPS. Destination: the container's private HTTP address.
- Under **Custom Header**, choose **Create > WebSocket**.
- Keep the `Origin` header, and forward `X-Forwarded-Proto: https` and the real client address through your trusted forwarding chain.

Synology describes these options in its [DSM reverse-proxy guide](https://kb.synology.com/en-in/DSM/help/DSM/AdminCenter/system_login_portal_advanced).

### Step 2. Add the TCP measurement headers

Add these **request** headers at the HTTPS ingress. They must **overwrite** any value sent by the client:

| Header | NGINX value | Meaning |
| --- | --- | --- |
| `X-BrainVault-TCP-Peer-IP` | `$remote_addr` | Address at the other end of the client's TCP connection |
| `X-BrainVault-TCP-RTT-Us` | `$tcpinfo_rtt` | Kernel TCP RTT, in microseconds |
| `X-BrainVault-TCP-RTTVar-Us` | `$tcpinfo_rttvar` | Kernel TCP RTT variation, in microseconds |

These variables come from NGINX's [TCP_INFO support](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_tcpinfo_rtt) (see the [NGINX source](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_variables.c) for the units).

> [!WARNING]
> Support differs between DSM versions and builds. Having a custom-header screen does **not** guarantee that these variables exist or are filled in.
>
> - Check that the generated proxy configuration evaluates them and that BrainVault receives **numbers** on the WebSocket upgrade.
> - A literal `$tcpinfo_rtt`, an empty value, or an RTT of `0` is rejected.
> - Never type in fixed RTT values.
> - If your DSM build cannot provide TCP_INFO, you need a different ingress that receives the browser's connection directly. Adding NGINX **behind** DSM does not help, because it never sees the original connection.

This repository does not change anything on the NAS itself.

### Step 3. Configure BrainVault

After all three headers are generated and overwritten correctly, set the following. Use the proxy address the container actually sees for `TRUST_PROXY_ADDRESSES`:

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

Checklist:

- [ ] `TRUST_PROXY_ADDRESSES` is as narrow as possible.
- [ ] The container's HTTP port is not public.
- [ ] `VPN_TRUST_PROXY_TCP_INFO=true` is set **only after** the overwrite rules are in place. (A normal proxy would pass attacker-supplied headers straight through, which is why the default is `false`.)
- [ ] WebSocket upgrades are forwarded for both `/api/network-verification/probe` and `/api/collaboration/`.

### Step 4. Verify in the app

1. Connect from an **external network** (for example a phone on mobile data). Access from the local network is intentionally exempt, so it does not prove the public setup works.
2. Open the account security settings and click **Measure connection again**.
3. A working setup shows **Client TCP RTT measured at the trusted ingress** together with the measured WebSocket and TCP RTTs.

If something is wrong, the screen tells you whether TCP information is disabled, the TCP RTT is missing, or the client information does not match. See [Troubleshooting](#troubleshooting).

Measurement values and thresholds are never exposed through pre-authentication endpoints.

## Other ingress setups

- **NGINX**: an equivalent configuration is in [nginx.conf.example](nginx.conf.example).
- **NGINX with `real_ip`**: if `real_ip` rewrites `$remote_addr`, use `$realip_remote_addr` for `X-BrainVault-TCP-Peer-IP` so the original TCP peer is kept. That peer must equal the verified client IP.
- **CDN or another TCP-terminating proxy in front**: the ingress then measures its connection to the CDN, not to the browser. Forwarding the CDN's client-IP header does not fix this, and mismatching observations are rejected.

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| TCP information is disabled | `VPN_TRUST_PROXY_TCP_INFO` is `false` | Finish Step 2, then set it to `true` |
| TCP RTT is missing | The ingress does not send numeric TCP_INFO headers (literal `$tcpinfo_rtt`, empty, or `0`) | Check the generated proxy config; use an ingress with TCP_INFO support |
| Client information does not match | `X-BrainVault-TCP-Peer-IP` differs from the verified client IP (`real_ip`, CDN in front) | Use `$realip_remote_addr`, or remove the extra TCP-terminating hop |
| No TCP evidence at all | Duplicate or malformed headers, untrusted proxy address, non-HTTPS forwarding, or an invalid forwarding chain | Check `TRUST_PROXY_ADDRESSES` and that headers are overwritten, not appended |
| Works on LAN, fails outside | Local network is exempt, so the public path was never tested | Test from an external network |
| Protected requests pause for about 20 seconds | A browser measurement failed | Fix the measurement setup above |

## Settings reference

| Setting | Default | Meaning |
| --- | --- | --- |
| `VPN_TRUST_PROXY_TCP_INFO` | `false` | Accept TCP_INFO headers overwritten by the explicitly trusted local HTTPS ingress |
| `VPN_MIN_EXCESS_RTT_MS` | `50` | Minimum repeated extra delay, in milliseconds (not a confidence percentage) |
| `VPN_PROXY_RTT_MARGIN_MS` | `10` | Extra tolerance for the local reverse-proxy hop |
| `VPN_ALLOW_PRIVATE_NETWORK` | `true` | Keep direct LAN access. Private clients that arrive through a proxy also need `TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=true` |
| `VPN_POLICY_FAIL_CLOSED` | `true` | Deny access for accounts with blocking enabled when no measurement evidence is available |

**What happens when measurement fails?**

- A failed measurement is **not** the same as a detected tunnel.
- With `VPN_POLICY_FAIL_CLOSED=true`, accounts with blocking enabled are still denied when evidence is missing. With `false`, measurement failures are allowed, but detected tunnels stay blocked.
- Accounts with blocking disabled are always accessible.
- You cannot enable a blocking policy that would immediately block your current connection.
- Existing password/MFA re-authentication and session-revocation protections still apply. Past block records and the separate country-based login restrictions remain viewable.

## How a result is decided

| Result | Meaning |
| --- | --- |
| `CLEAR` | No extra TCP/WebSocket gap was observed. This does **not** prove there is no VPN. |
| `TUNNEL` | A consistent extra delay was observed. Treated as a VPN/proxy. |
| `INCONCLUSIVE` | Timing was too noisy to decide (unstable WebSocket timing, high TCP variation, or inconsistent estimates). |
| `UNKNOWN` | No TCP evidence was available. Any completed WebSocket samples are kept. |

<details>
<summary>Measurement details</summary>

1. The browser requests a same-origin, one-use ticket and opens `/api/network-verification/probe`.
2. The server records the TCP_INFO metadata from that upgrade request.
3. The server sends twelve unpredictable WebSocket ping frames and times the matching pong frames with a monotonic clock. These are TCP-based WebSocket control frames, not ICMP packets.
4. The browser submits only an opaque completion receipt. RTTs or verdicts claimed by the client are ignored.
5. The twelve samples form two consecutive windows of six. The result is `TUNNEL` only if **both** windows exceed the TCP RTT plus `VPN_MIN_EXCESS_RTT_MS`, plus `VPN_PROXY_RTT_MARGIN_MS`, plus three times the TCP RTT variation. A high RTT alone never triggers detection. One TCP snapshot is never counted as several independent measurements.

**Where the result is stored**

- The receipt is exchanged for an opaque `HttpOnly`, `SameSite=Strict` cookie (also `Secure` with a `__Host-` prefix on HTTPS).
- The result is bound to that browser and its exact normalized client IP, expires after five minutes, and refreshes while the page is visible.
- Different browsers behind the same NAT do not share results.
- It is enforced on password login, MFA, passkeys, authenticated requests, and collaboration rechecks.

</details>

## Limits

### Resource limits

| Item | Limit |
| --- | --- |
| Active measurement sockets | 32 in total, 4 per source IP |
| Tickets | 30 per minute per source IP |
| Measurement time | 12 seconds |
| WebSocket samples | 12 |
| Internal state | Size-limited maps with expiry |

Keep ticket subprotocols, receipts, and cookies out of logs. A failed measurement can delay the next protected request by about 20 seconds.

### What it can and cannot detect

- **Can detect**: a relay that splits the TCP connection while the WebSocket stream continues to the browser, causing a stable extra delay.
- **Cannot reliably detect**:
  - Every residential VPN.
  - WireGuard, OpenVPN, and other tunnels that forward the TCP connection end to end. TCP RTT and WebSocket RTT then rise together.
  - A relay very close to the server, or one that answers WebSocket control frames itself.
- Network load and ingress scheduling affect both measurements.
- Before relying on it, calibrate with labeled traffic (direct, mobile, congested, local proxy, residential VPN), and measure the false-positive rate and how often evidence is available separately. No accuracy percentage is claimed.

### Direct HTTPS mode

Direct Node.js HTTPS (`HTTPS_MODE=posh-acme`) measures WebSocket RTT but has no built-in TCP_INFO collector. It reports `DIRECT_TCP_INFO_UNAVAILABLE`, and request headers cannot replace kernel socket data. The TCP collector targets the DSM/NGINX ingress setup described above.
