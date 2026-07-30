# BrainVault documentation

The root [README](../README.md) is intentionally short. Detailed setup, operation, and implementation notes are organized here by topic.

## Guides

| Document | Use it for |
| --- | --- |
| [Getting started](getting-started.md) | Installing dependencies, preparing MariaDB, running locally, loading demo data, and building for production |
| [Features](features.md) | Learning the editor controls, page sharing, block types, backup/restore flow, languages, and PDF export |
| [Collaboration](collaboration.md) | Understanding sharing permissions, Yjs/WebSocket synchronization, persistence, proxy requirements, and verification |
| [Collaboration verification](collaboration-verification.md) | Reviewing completed source/protocol checks, the package-fetch limitation, and deployment validation commands |
| [Data-loss audit (2026-07-28)](data-loss-audit-2026-07-28.md) | Reviewing all nine critical persistence/recovery findings, reproductions, corrections, and validation evidence |
| [데이터 손실 감사 보고서 (한국어)](data-loss-audit-2026-07-28-ko.md) | 9번째 cross-process compaction 취약점, 수정, 검증, 배포 조건을 한국어로 검토 |
| [데이터 손실 감사 보고서 2026-07-29 (한국어)](data-loss-audit-2026-07-29-ko.md) | 10번째 browser recovery write 실패 취약점, durable-before-visible 수정, 재현 및 검증을 검토 |
| [데이터 손실 후속 감사 2026-07-29: 첨부 위치 (한국어)](data-loss-audit-2026-07-29-attachment-position-ko.md) | ACK된 Yjs 첨부 위치를 stale SQL snapshot이 되돌리는 11번째 결함, 수정, protocol fence, 재현 및 검증 |
| [데이터 보존 후속 감사 2026-07-29: 협업 입력 길이 (한국어)](data-loss-audit-2026-07-29-content-limits-ko.md) | 협업 제목·본문 초과 입력이 저장된 것처럼 보인 뒤 잘리는 결함, 첨부 잠금 순서, 빌드·테스트 게이트 수정 |
| [구조화 블록 데이터 무결성 감사 2026-07-30 (한국어)](data-loss-audit-2026-07-30-structured-metadata-ko.md) | BOOKMARK/AI_CHAT 원본 metadata 자동 축약, DATABASE fallback 참조 불일치, 재현·수정·회귀 검증 |
| [백업 스트림 무결성 감사 2026-07-30 (한국어)](data-loss-audit-2026-07-30-backup-stream-integrity-ko.md) | 동일 크기 첨부파일 변경으로 완성되지만 복원 불가능한 ZIP이 생성되는 결함, 스트리밍 CRC32·SHA-256 재검증, 재현·회귀 검증 |
| [독립 데이터 무결성 심층 감사 2026-07-30 (한국어)](data-loss-audit-2026-07-30-independent-review-ko.md) | 데이터베이스·Yjs·첨부·백업/복원·마이그레이션·브라우저 복구의 전체 검토 범위, 신규 결함, 수정 및 검증 제한 |
| [교차 페이지 블록 부모 무결성 재감사 2026-07-30 (한국어)](data-loss-audit-2026-07-30-cross-page-parent-ko.md) | 단일 열 부모 FK가 손상 상태에서 다른 페이지 블록까지 cascade 삭제할 수 있는 방어 공백, 복합 FK 수정, 재현·회귀 검증 |
| [백업 공유 권한 무결성 감사 2026-07-30 (한국어)](data-loss-audit-2026-07-30-backup-share-integrity-ko.md) | 전체 백업이 `page_shares`를 누락해 정상 복원 뒤 공유 권한을 영구 손실하던 결함, 재현, 수정, 레거시 호환성 및 회귀 검증 |
| [Configuration](configuration.md) | Reviewing every supported environment variable and its default behavior |
| [Security](security.md) | Configuring MFA and understanding the project security boundaries and production requirements |
| [API](api.md) | Finding route summaries, authentication expectations, the health endpoint, and the OpenAPI document |
| [Development](development.md) | Using npm scripts, maintaining the lockfile, navigating the repository, updating translations, and capturing the preview |
| [OpenAPI specification](openapi.yaml) | Reading the complete machine-readable OpenAPI 3.1 definition |

## Assets

- [`preview.png`](preview.png): workspace screenshot used by the root README
- [`openapi.yaml`](openapi.yaml): API contract served by the application
