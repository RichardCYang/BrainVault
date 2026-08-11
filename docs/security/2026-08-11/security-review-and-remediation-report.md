# Security Review and Remediation Report — 2026-08-11

## Scope

This review covered the uploaded BrainVault working tree, including authentication and session boundaries, MFA and passkeys, page sharing and WebSocket collaboration, bookmark SSRF controls, multipart uploads, attachment storage, backup/restore ZIP handling, HTML sanitization, database access, reverse-proxy trust, runtime security floors, and the locked direct dependencies. The existing `.git` directory was treated as immutable project data. Before final packaging, its complete file tree and file contents were verified against the uploaded archive and restored where necessary so that the final `.git` contents match the original archive.

## Remediated finding

### High (deployment-dependent): remote MariaDB transport could remain plaintext

BrainVault explicitly supports a remote MariaDB server, but the database URL parser previously discarded every query parameter. As a result, an operator could configure `DATABASE_URL=...?...ssl=true` and reasonably expect TLS while the resulting MariaDB Connector/Node.js options still contained no `ssl` setting. The same parsing path was used for `MARIADB_ADMIN_URL`. Unless the database server independently required TLS, a remote production deployment could therefore expose database credentials, note contents, authentication state, and database writes to a network-position attacker.

The remediation makes database transport intent explicit and fail-closed:

- `?ssl=true` is parsed and forwarded as the connector `ssl: true` option.
- Production rejects a non-loopback `DATABASE_URL` that does not enable TLS.
- Production applies the same rule to `MARIADB_ADMIN_URL`.
- `npm run db:init` applies the same production transport guard before opening either connection.
- Unsupported or duplicate database URL query parameters are rejected instead of silently ignored.
- Loopback database connections remain compatible with plaintext local development and same-host production deployments.

## Reproduction

Before the correction, parsing the following URL produced connector options with no `ssl` property:

```text
mariadb://brainvault:strong-secret@db.example.internal:3306/brainvault?ssl=true
```

The standalone reproduction command is:

```bash
npm run reproduce:database-transport-security
```

The corrected model reports that the legacy connector options had no SSL setting, the fixed options have `ssl: true`, and a plaintext remote production URL is rejected.

## Verification

The remediation is covered by `tests/database-transport-security.node.test.mjs` and is included in `npm run verify:security`. Final validation completed with 53/53 security tests passing, 249/249 dependency-free durability tests passing, the data-loss guard passing, the collaboration verifier passing, and the lockfile registry-integrity check passing.

External dependency comparison during this review also confirmed that the lockfile already uses Multer 2.2.0, markdown-it 14.3.0, and sanitize-html 2.17.5, which are beyond the affected versions of the 2026 advisories reviewed. The repository's Node.js runtime floor also matches the fixed versions published in the Node.js July 29, 2026 security release.

## Residual notes

No additional critical or high-severity application vulnerability was reproduced in the reviewed authentication, authorization, SSRF, upload, backup/restore, HTML rendering, or collaboration paths. A current-registry `npm audit` and dependency-backed production build could not be completed because the review sandbox could not reach the npm registry, and its installed Node.js runtime was below the repository's enforced security floor. Locked direct dependency versions were therefore cross-checked against the published advisories reviewed, while the repository's dependency-free security, durability, data-loss, collaboration, and lockfile-integrity checks were executed locally. This review does not replace deployment-specific penetration testing, infrastructure review, secret scanning of external systems, or a live database/network assessment.
