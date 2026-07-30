# BrainVault documentation

The root [README](../README.md) provides the project overview. Detailed documentation is organized by **topic** and then by **document date**.

## Directory convention

```text
docs/<topic>/<YYYY-MM-DD>/<document>
```

`docs/README.md` is the only undated file because it is the navigation index.

## Product and operations

| Topic | Date | Document |
| --- | --- | --- |
| Getting started | 2026-07-27 | [Setup, database bootstrap, and production](getting-started/2026-07-27/getting-started.md) |
| Configuration | 2026-07-28 | [Environment variables and runtime behavior](configuration/2026-07-28/configuration.md) |
| Development | 2026-07-28 | [Scripts, repository structure, translations, and preview capture](development/2026-07-28/development.md) |
| Collaboration | 2026-07-29 | [Sharing, Yjs/WebSocket synchronization, persistence, and deployment](collaboration/2026-07-29/collaboration.md) |
| Features | 2026-07-30 | [Editor behavior, blocks, backup/restore, languages, and export](features/2026-07-30/features.md) |
| Security | 2026-07-30 | [MFA, secrets, attachments, backup safety, and production boundaries](security/2026-07-30/security.md) |
| API | 2026-07-30 | [REST route overview and authentication](api/2026-07-30/api.md) |
| API | 2026-07-30 | [OpenAPI 3.1 specification](api/2026-07-30/openapi.yaml) |
| Assets | 2026-07-17 | [Workspace preview image](assets/2026-07-17/preview.png) |

## Data-loss and integrity reports

### 2026-07-28

- [Critical persistence and recovery paths](data-loss/2026-07-28/critical-persistence-and-recovery-paths.md)

### 2026-07-29

- [Collaboration and data-loss fix verification](data-loss/2026-07-29/collaboration-verification.md)
- [Browser recovery-write durability](data-loss/2026-07-29/browser-recovery-write-durability.md)
- [Attachment-position integrity](data-loss/2026-07-29/attachment-position-integrity.md)
- [Content limits and attachment lock ordering](data-loss/2026-07-29/content-limits-and-attachment-lock-order.md)

### 2026-07-30

- [Backup-restore structured-metadata integrity](data-loss/2026-07-30/backup-restore-structured-metadata-integrity.md)
- [Backup sharing-permission integrity](data-loss/2026-07-30/backup-share-integrity.md)
- [Backup collaborator identity integrity](data-loss/2026-07-30/backup-share-identity-integrity.md)
- [Archived-page sharing backup round-trip integrity](data-loss/2026-07-30/archived-share-backup-roundtrip-integrity.md)
- [Backup stream integrity](data-loss/2026-07-30/backup-stream-integrity.md)
- [Block-order range integrity](data-loss/2026-07-30/block-order-integrity.md)
- [Collaborative block-deletion integrity](data-loss/2026-07-30/collaboration-block-delete-integrity.md)
- [Initial collaboration-bootstrap integrity](data-loss/2026-07-30/collaboration-bootstrap-integrity.md)
- [Cross-page block-parent integrity](data-loss/2026-07-30/cross-page-parent-integrity.md)
- [Structured-block metadata integrity](data-loss/2026-07-30/structured-metadata-integrity.md)
- [Independent data-integrity review](data-loss/2026-07-30/independent-data-integrity-review.md)
- [Final data-integrity review](data-loss/2026-07-30/final-data-integrity-review.md)
