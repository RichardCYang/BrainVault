# BrainVault documentation

The root [README](../README.md) provides the project overview. This directory keeps maintained product, setup, operations, API, development, and dated remediation documentation. Transient benchmark logs, one-off verification artifacts, and superseded preview assets are intentionally excluded.

## Maintained documentation

| Topic | Document |
| --- | --- |
| Getting started | [Setup, database bootstrap, and production](getting-started/2026-07-27/getting-started.md) |
| Configuration | [Environment variables and runtime behavior](configuration/2026-07-28/configuration.md) |
| Deployment | [Direct Posh-ACME HTTPS and trusted reverse-proxy setup](../deploy/README.md) |
| Development | [Scripts, repository structure, translations, and preview capture](development/2026-07-28/development.md) |
| Collaboration | [Page/collection sharing, Yjs/WebSocket synchronization, persistence, and deployment](collaboration/2026-07-29/collaboration.md) |
| Collection sharing | [UI entry point, READ/WRITE/ADMIN roles, inheritance, API, backup/restore, and troubleshooting](collaboration/2026-09-02/collection-sharing.md) |
| Features | [Editor behavior, blocks, backup/restore, languages, and export](features/2026-07-30/features.md) |
| Security | [MFA, secrets, attachments, backup safety, and production boundaries](security/2026-07-30/security.md) |
| API | [REST route overview and authentication](api/2026-07-30/api.md) |
| OpenAPI | [OpenAPI 3.1 specification](api/2026-07-30/openapi.yaml) |
| Preview asset | [Current workspace preview](assets/2026-08-09/preview.png) |

## Maintenance and audit notes

| Date | Topic | Document |
| --- | --- | --- |
| 2026-09-13 | Security report remediation | [Confirmed findings, applied fixes, validation, and limits](security/2026-09-13/security-report-remediation.md) |
| 2026-09-11 | Recovery maintenance review | [Failed-write recovery preservation and reconciliation review](recovery/2026-09-11/recovery-maintenance-review.md) |
| 2026-09-11 | Recovery durability barrier | [Concurrent flush and durability-barrier maintenance](recovery/2026-09-11/recovery-durability-barrier-maintenance.md) |
| 2026-09-11 | Queued recovery cleanup integrity | [Queued delete/clear rollback integrity review](recovery/2026-09-11/queued-recovery-cleanup-integrity.md) |
| 2026-09-11 | Legacy recovery cleanup audit | [Legacy migration and cleanup reconciliation audit](recovery/2026-09-11/legacy-recovery-cleanup-audit.md) |

The dated directory names are retained for stable links. Durable remediation notes are kept when they document shipped behavior or recovery guarantees; transient audit logs and benchmark artifacts should remain outside the maintained documentation set.
