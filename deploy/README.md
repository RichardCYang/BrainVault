**English** | [한국어](README.ko.md) | [日本語](README.jp.md)

# HTTPS deployment

BrainVault must be served over HTTPS in production. You can do this in one of two ways:

- **Direct HTTPS**: BrainVault serves TLS itself using certificate files issued by Posh-ACME.
- **Reverse proxy**: Caddy, NGINX, Nginx Proxy Manager, or Synology DSM serves public TLS and forwards traffic to BrainVault over private HTTP.

## Contents

- [Choose a deployment mode](#choose-a-deployment-mode)
- [Settings shared by both modes](#settings-shared-by-both-modes)
- [Option A: Direct HTTPS with Posh-ACME](#option-a-direct-https-with-posh-acme)
- [Option B: HTTPS through a reverse proxy](#option-b-https-through-a-reverse-proxy)
- [Production operations](#production-operations)
- [VPN/proxy blocking](#vpnproxy-blocking)
- [Files in this directory](#files-in-this-directory)

## Choose a deployment mode

| | Direct HTTPS (`HTTPS_MODE=posh-acme`) | Reverse proxy (`HTTPS_MODE=proxy`) |
| --- | --- | --- |
| Who serves TLS | BrainVault | The proxy |
| BrainVault listens on | Public HTTPS (for example `0.0.0.0:443`) | Private HTTP (for example `127.0.0.1:4000`) |
| Certificates | Posh-ACME files, read at startup | Managed by the proxy |
| HTTP→HTTPS redirect | Not provided (no port 80 listener) | Provided by BrainVault or the proxy |
| Ingress request limits | Application limits only | Can add proxy limits ([see below](#public-ingress-request-limits)) |
| VPN/proxy measurement | WebSocket only (no TCP_INFO) | Full TCP/WebSocket comparison with a supported ingress |
| Good fit | A single Windows host without a proxy | Most deployments, NAS, containers |

If you are unsure, use a reverse proxy.

<details>
<summary>New to this? Key terms</summary>

| Term | Meaning |
| --- | --- |
| TLS / HTTPS | Encryption between the browser and the server. Requires a certificate for your domain. |
| Reverse proxy | A web server in front of BrainVault that receives public HTTPS traffic and forwards it to BrainVault. |
| Origin | The scheme, domain and port of your site, for example `https://notes.example.com`. |
| WebSocket | A long-lived connection used for live collaboration. Proxies must allow the WebSocket "upgrade". |
| Loopback | The machine's own address (`127.0.0.1`). Only programs on the same machine can reach it. |

</details>

## Settings shared by both modes

Both modes need the public URL of the site. Replace `notes.example.com` with your domain:

```env
NODE_ENV=production

PUBLIC_ORIGIN="https://notes.example.com"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
```

Also keep `JWT_SECRET` the same across restarts. It also signs deletion previews: changing it invalidates outstanding previews, which must be fetched again before deleting. Previews created before this signing was added fail with `409 PAGE_EDIT_CONFLICT`.

See the [configuration guide](../docs/configuration/2026-07-28/configuration.md) for every variable.

## Option A: Direct HTTPS with Posh-ACME

### 1. Find the certificate files

Posh-ACME stores `fullchain.cer` (certificate plus issuing chain) and `cert.key` (private key) in each certificate order folder. Show the paths for the active order in PowerShell:

```powershell
Get-PACertificate | Format-List Subject,FullChainFile,KeyFile,NotAfter
```

### 2. Configure BrainVault

Add the following to the [shared settings](#settings-shared-by-both-modes). `POSH_ACME_CERT_PATH` can be the order folder or the `FullChainFile` path shown above:

```env
HOST="0.0.0.0"
PORT=443

HTTPS_MODE=posh-acme
POSH_ACME_CERT_PATH="C:/Users/service-account/AppData/Local/Posh-ACME/acme-v02.api.letsencrypt.org/example-order/fullchain.cer"
# Optional. By default BrainVault reads cert.key next to fullchain.cer.
# POSH_ACME_KEY_PATH="D:/certificates/notes.example.com/cert.key"
```

- Use forward slashes (`/`) in Windows `.env` paths to avoid backslash escaping problems.
- The account that runs BrainVault needs read permission on both files.

### 3. Start and verify

At startup BrainVault checks that the certificate is currently valid, covers the `PUBLIC_ORIGIN` hostname, and matches the private key. If a file is missing or invalid, startup fails instead of falling back to HTTP.

The log should show `Posh-ACME HTTPS mode enabled`. Then check:

```bash
curl -I https://notes.example.com/health
curl -I https://notes.example.com/
```

Collaboration WebSockets use the same HTTPS listener, so no extra setup is needed.

### 4. Restart after renewal

Certificate files are read only at startup, so restart BrainVault after Posh-ACME renews the certificate. For example, in a scheduled renewal task:

```powershell
Set-PAOrder notes.example.com
if (Submit-Renewal) {
    Restart-Service -Name BrainVault
}
```

> [!NOTE]
> This mode opens only the HTTPS listener on `HOST`:`PORT`. It does not listen on port 80. If you need an HTTP→HTTPS redirect, use a firewall, router, or separate redirect service.

## Option B: HTTPS through a reverse proxy

### 1. Configure BrainVault

Add the following to the [shared settings](#settings-shared-by-both-modes). This example is for a proxy on the same host:

```env
HOST="127.0.0.1"
PORT=4000

HTTPS_MODE=proxy
HTTPS_REDIRECT=true
HTTPS_HEALTHCHECK_BYPASS=true
TRUST_PROXY_ADDRESSES="loopback"
TRUST_PROXY_HOPS=0
```

| Setting | What it does |
| --- | --- |
| `TRUST_PROXY_ADDRESSES` | Required. Only requests from these addresses may set `X-Forwarded-Proto`. Use `loopback` for a same-host proxy. For a proxy in another container or host, use its exact IP or the narrowest practical CIDR. Catch-all `/0` ranges are rejected. |
| `TRUST_PROXY_HOPS` | Kept for compatibility only. Must be `0`. Counting hops is refused because a client with a shorter path to the backend could then forge forwarding headers. |
| `HTTPS_REDIRECT` | `true`: plain HTTP requests get a 308 redirect to `PUBLIC_ORIGIN`. `false`: they get `426 HTTPS_REQUIRED`. |
| `HTTPS_HEALTHCHECK_BYPASS` | `true`: `/health` stays reachable over private HTTP for local checks. |
| `HOST` | Bind only to an interface the proxy can reach. Never expose port 4000 publicly. |

### 2. Configure the proxy

Every proxy must do three things: serve TLS for your domain, forward `X-Forwarded-Proto: https`, and allow WebSocket upgrades (used by `/api/collaboration/` and `/api/network-verification/probe`).

#### Caddy

Copy [Caddyfile.example](Caddyfile.example), change the domain and backend address, and reload Caddy. `reverse_proxy` forwards the original protocol and handles WebSocket upgrades automatically.

#### NGINX

1. Copy the `log_format`, `map`, and `limit_req_zone` lines and both `server` blocks from [nginx.conf.example](nginx.conf.example) into the `http` context.
2. Update the domain and certificate paths.
3. Run `nginx -t`, then reload.

The `Upgrade` and `Connection` headers in the example are required for collaboration. The example also includes [request limits](#public-ingress-request-limits) and [safe logging](#keep-credentials-out-of-proxy-logs).

#### Nginx Proxy Manager

Create a Proxy Host:

| Field | Value |
| --- | --- |
| Domain | `notes.example.com` |
| Scheme | `http` |
| Forward host/IP | BrainVault private address |
| Forward port | `4000` |
| Websockets Support | Enabled |
| SSL certificate | Selected |
| Force SSL | Enabled |

Nginx Proxy Manager normally sends the forwarded host and protocol headers. Allow port 4000 only from the proxy network.

#### Synology DSM reverse proxy

1. Open **Control Panel → Login Portal → Advanced → Reverse Proxy** and create a rule:

   | Field | Value |
   | --- | --- |
   | Source protocol | `HTTPS` |
   | Source hostname | `notes.example.com` |
   | Source port | `443` |
   | Destination protocol | `HTTP` |
   | Destination hostname | `127.0.0.1` or the BrainVault private address |
   | Destination port | `4000` |

2. Under **Custom Header**, choose **Create → WebSocket**.
3. If your DSM version does not add it already, add the header `X-Forwarded-Proto` with value `$scheme`. BrainVault requires the trusted proxy to report `https`.
4. Assign the `notes.example.com` certificate in DSM.
5. Optional: add a separate HTTP source rule that redirects to HTTPS.

Keep the destination port private. For VPN/proxy blocking on DSM, also follow the [connection measurement guide](network-verification.md).

### 3. Verify

The log should show `HTTPS reverse-proxy mode enabled`. Then run:

| Command | Expected result |
| --- | --- |
| `curl -I http://127.0.0.1:4000/health` | `200` (private health check) |
| `curl -I -H 'Host: notes.example.com' http://127.0.0.1:4000/` | `308` (`426` if `HTTPS_REDIRECT=false`) |
| `curl -I -H 'X-Forwarded-Proto: https' http://127.0.0.1:4000/` | `200` (simulates the trusted proxy) |
| `curl -I https://notes.example.com/` | The app, with no redirect loop |

Finally, open the same shared page in two browser windows to confirm that live collaboration works.

## Production operations

### Public ingress request limits

- **Run one instance only.** Application rate-limit counters live in process memory and reset on restart. Before listening, BrainVault takes a lease on its MariaDB database and refuses to start a second active process for the same database. Horizontal scaling is not supported. A proxy limiter does not change this, because upload/import admission and collaboration coordination would also need shared backends.
- **Login lockouts are separate.** They are stored in the database and are not affected by these counters.
- **Proxy limits survive app restarts.** The NGINX example limits requests per IP for `/api/`, with stricter limits for `/api/auth/` and `/api/mfa/`, and returns HTTP 429. Static assets and `/health` are excluded. Its shared-memory zones cover all workers on one NGINX ingress.
- **Tune the rates.** Allow for autosave, collaboration reconnects, and many users behind one shared NAT. See the [NGINX `limit_req` documentation](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html).
- **Keep every backend private** so all public traffic passes through the limiter.
- **Never key a limit on an untrusted forwarding header.** If another trusted proxy sits in front of NGINX, configure real client IP handling there.
- **Know the example's limits.** Multiple ingress hosts need a shared edge limiter or shared store. The example has no Redis integration and no global per-account quota, and it limits WebSocket handshakes, not frames.

### Keep credentials out of proxy logs

At every ingress, keep these headers out of access logs, tracing, WAF captures, and error/debug logs:

- `Sec-WebSocket-Protocol`
- `Cookie` and `Set-Cookie`
- `Authorization`

The collaboration WebSocket subprotocol carries a 120-second ticket bound to the page and session (the matching session cookie is also required). Do not move the ticket into a cookie: it would still need log redaction, and a single shared cookie would collide across page tabs. Keep the current transport and redact at the logging layer.

The NGINX example already uses a minimal `brainvault_safe` log format without query strings or headers. Do not enable full-header logging in production.

### Password login lockout recovery

Password throttling is applied per account across all networks. This means anyone who knows an account ID can temporarily block password login for it.

| Restriction | Behavior |
| --- | --- |
| Stored lock | Starts at 30 seconds, grows with failures after it expires, maximum 15 minutes |
| Account request budget | Separate default budget that lasts six hours |

Removing only the stored lock does not clear the request budget and weakens protection against distributed guessing. Ways to recover:

1. **Passkey (recommended).** Register a discoverable passkey in advance. **Passkey** sign-in has separate limits, and a verified WebAuthn sign-in clears the account's password counter and stored lock.
2. **Existing session.** A signed-in session can call `POST /api/auth/login-lockout/reset`. It cannot unlock other accounts and does not reset the shared IP budget.
3. **Wait.** Without a passkey or a session, password login must wait until the restrictions expire.

Keep an operator recovery procedure for case 3. Do not offer an anonymous reset based only on an account ID.

## VPN/proxy blocking

VPN/proxy blocking compares the TCP RTT measured at the trusted ingress with the WebSocket RTT measured by the server. See the [connection measurement guide](network-verification.md) for Synology DSM setup, TCP_INFO headers, proxy trust, and detection limits.

## Files in this directory

| File | Contents |
| --- | --- |
| `README.md` / [`README.ko.md`](README.ko.md) / [`README.jp.md`](README.jp.md) | This HTTPS deployment guide |
| [`network-verification.md`](network-verification.md) / [`.ko.md`](network-verification.ko.md) / [`.jp.md`](network-verification.jp.md) | TCP/WebSocket measurement for VPN/proxy blocking |
| [`Caddyfile.example`](Caddyfile.example) | Caddy reverse-proxy example |
| [`nginx.conf.example`](nginx.conf.example) | NGINX example with redirect, WebSocket, request limits, safe logging, and TCP_INFO headers |
