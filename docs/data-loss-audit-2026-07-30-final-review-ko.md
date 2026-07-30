# BrainVault 데이터 무결성 최종 심층 감사 보고서

- 감사일: 2026-07-30
- 원본 Git HEAD: `9dabd0133d2488bbc666772154d64407b078b716`
- 대상 브랜치: `main`
- 원본 압축파일: `BrainVault.zip`
- 감사 범위: MariaDB 쓰기·삭제·트랜잭션, 페이지/블록 계층, Yjs 저장·압축·materialization, 브라우저 로컬 복구, 첨부파일 수명주기, 전체 백업/복원, 마이그레이션 재실행 안전성

## 1. 최종 결론

재현 가능한 신규 데이터 무결성 결함 1건을 발견해 수정했습니다.

### BV-DI-2026-07-30-ATT-01 — 정상 파일을 포함한 복원이 첨부를 앱에서 접근 불가능하게 만드는 결함

- 중요도: **높음(High)**
- 공격/발생 전제: 손상되었거나 조작된 백업을 사용자가 복원함
- 물리적 파일 바이트 삭제: 즉시 발생하지 않음
- 애플리케이션 관점의 데이터 손실: 발생
- 수정 상태: 완료

백업 ZIP의 첨부파일 바이트, 크기, CRC32, SHA-256이 모두 정상이어도 대응하는 `ATTACHMENT` 블록의 `metadata`가 `null`, `{}`, 이중 JSON 인코딩 또는 파일과 불일치한 상태일 수 있었습니다. 기존 복원 검증은 첨부 블록 ID와 ZIP 경로·체크섬만 확인하고 첨부 metadata가 다운로드에 필요한 형태인지 확인하지 않았습니다.

복원이 성공하면 기존 작업공간은 교체되고 파일도 디스크에 반입되지만, 다운로드 API는 `metadata.attachment`를 해석하지 못해 `Attachment file not found`로 처리합니다. 따라서 정상 바이트가 서버에 남아 있어도 BrainVault를 통해 열거나 내려받을 수 없는 상태가 됩니다. 이후 블록/페이지가 정상 삭제되면 해당 파일도 정리되므로 실질적인 복구 기회를 잃을 수 있습니다.

이번 재감사에서 그 밖의 서버 SQL/Yjs/첨부/복원/브라우저 저장 경로에서는 기존 방어를 우회해 영구 소실로 이어지는 신규 Critical/High 결함을 재현하지 못했습니다.

## 2. 재현

수정 전 관계 검증과 다운로드 해석을 동일하게 모델링한 결과는 다음과 같습니다.

```json
{
  "currentRestoreRelationChecksAccept": true,
  "attachmentBytesAndDescriptorCanMatch": true,
  "downloadMetadataResult": null,
  "restoredFileBecomesUnavailableThroughDownloadRoute": true,
  "effectiveApplicationLevelDataLossReproduced": true
}
```

증거 로그:

- `audit-logs-2026-07-30-deep/attachment-metadata-vulnerability-before-fix.log`

수정 후 재현 명령:

```bash
npm run reproduce:backup-attachment-metadata-loss
```

수정 후 확인된 상태:

- metadata 누락을 복원 DB 작업 전에 거부
- 이중 인코딩 metadata 거부
- 저장 시 정규화되어 원본과 달라지는 파일명/MIME 거부
- 안전한 정수가 아닌 크기 거부
- metadata 크기와 실제 파일 바이트 수 불일치 거부
- 기존 작업공간에 이미 손상된 첨부가 있으면 정상 백업처럼 내보내지 않고 실패

## 3. 원인

`validateManifestRelations()`는 모든 블록 metadata의 JSON 문법을 확인했지만 `ATTACHMENT` 타입에는 구조·의미 검증을 적용하지 않았습니다. 첨부 관계 검증도 다음만 확인했습니다.

- 첨부 블록과 첨부 엔트리의 ID 집합 일치
- `attachments/<blockId>` 경로 일치
- ZIP 엔트리 크기·CRC32·SHA-256 일치

반면 다운로드 경로는 `getAttachmentInfo()`가 유효한 `metadata.attachment` 객체를 반환해야만 파일을 제공합니다. 복원 승인 조건과 실제 사용 가능 조건이 달라 생긴 무결성 공백입니다.

## 4. 수정 내용

### `src/lib/attachment-metadata-integrity.ts` 신규

첨부 metadata의 순수 검증·정규화 계약을 한 곳으로 통합했습니다.

- `attachment.originalName`: 문자열이며 업로드 시 저장되는 canonical filename과 정확히 일치
- `attachment.mimeType`: 문자열이며 canonical MIME과 정확히 일치
- `attachment.size`: 0 이상의 JavaScript safe integer
- 기대 파일 크기가 제공되면 metadata 크기와 정확히 일치
- JSON 파싱 실패, 객체가 아닌 루트, 이중 인코딩을 fail-closed 처리

### `src/lib/attachments.ts`

기존 첨부 metadata 타입·파서·정규화 함수를 신규 순수 모듈에서 재노출하도록 변경했습니다. 다운로드와 렌더링 동작은 유지하면서 복원/내보내기와 같은 계약을 공유합니다.

### `src/lib/data-transfer.ts`

복원 전 관계 검증에서 각 첨부 엔트리를 해당 블록 metadata와 결속했습니다.

```text
manifest attachment size
        == metadata.attachment.size
        == staged ZIP entry actual byte count
```

이 검사는 ID 충돌 확인, 파일 반입, 사용자 행 잠금, 기존 SQL 삭제보다 먼저 실행됩니다.

백업 내보내기에서도 스테이징된 실제 파일 크기와 DB metadata를 비교합니다. 기존 DB가 이미 손상된 경우 복구 가능성이 불명확한 백업을 성공으로 표시하지 않습니다.

### 재현·회귀 게이트

- `scripts/reproduce-backup-attachment-metadata-loss.mjs`
- `tests/backup-attachment-metadata-integrity.node.test.mjs`
- `scripts/verify-data-loss-guards.mjs` 통합
- `package.json` 재현 스크립트 추가

## 5. 전체 감사 결과

### 5.1 MariaDB 원자성·동시성

- 페이지/블록의 주요 쓰기·삭제는 트랜잭션, `FOR UPDATE`, 버전 CAS를 사용합니다.
- 사용자 단위 첨부 잠금과 페이지 잠금의 순서가 일관됩니다.
- 커밋 응답이 불명확할 때 성공/실패를 임의로 단정하지 않고 데이터를 보존하며 재확인합니다.
- 영구 삭제는 페이지/블록 버전 스냅샷과 협업 materialization 상태를 확인합니다.
- DDL은 MariaDB에서 암시적 커밋될 수 있으므로 마이그레이션 안전성은 트랜잭션 롤백이 아니라 재실행 가능성·중간 marker에 의존합니다. 현재 데이터 변환이 있는 핵심 마이그레이션은 이 패턴을 사용합니다.

신규 영구 소실 경로는 재현되지 않았습니다.

### 5.2 페이지·블록 계층

- 페이지 부모 이동은 전체 소유 페이지 집합을 잠그고 순환을 차단합니다.
- 블록 부모 FK는 `(parent_block_id, page_id)` 복합 관계로 같은 페이지 내부만 허용합니다.
- 서브트리 삭제와 재정렬은 대상 전체 버전/부모/순서를 검증합니다.
- `sort_order`는 MariaDB signed `INT` 범위 밖에서 fail-closed 처리됩니다.

신규 교차 페이지 cascade 또는 순서 소실은 재현되지 않았습니다.

### 5.3 Yjs 협업

- 최초 Yjs 문서는 SQL 원본과 의미적으로 동일해야 durable log에 들어갑니다.
- 업데이트는 durable SQL log에 저장된 뒤 클라이언트 ACK가 진행됩니다.
- process-local room과 durable tip 불일치를 감지해 stale 인스턴스의 append/compaction을 차단합니다.
- compaction snapshot 저장과 오래된 업데이트 삭제가 같은 DB 트랜잭션에 있습니다.
- materialization은 브라우저가 제출한 중복 본문이 아니라 잠긴 durable update log를 재생합니다.
- 첨부 삭제·교체는 다른 탭의 미확인 recovery까지 검사합니다.

신규 영구 협업 소실 경로는 재현되지 않았습니다.

### 5.4 첨부파일 수명주기

- 최종 저장 경로는 덮어쓰는 `rename()` 대신 exclusive hard-link claim을 사용합니다.
- 파일 및 디렉터리 동기화 후 임시 이름을 제거합니다.
- DB 커밋 결과가 불명확하면 이동한 파일을 삭제하지 않습니다.
- 삭제 후 정리는 DB에서 블록 부재를 다시 확인한 뒤 실행합니다.
- 백업 ZIP 스트리밍 시 실제 바이트의 CRC32와 SHA-256을 다시 계산합니다.
- 이번 수정으로 파일 바이트와 첨부 metadata까지 같은 무결성 체인에 포함했습니다.

### 5.5 백업·복원

- 소유 페이지 집합을 잠근 일관된 스냅샷을 내보냅니다.
- Yjs 상태가 SQL에 완전히 materialize되지 않으면 백업/복원을 거부합니다.
- ZIP 경로, 중복, 크기, CRC32, SHA-256, 계층, 태그, 공유 관계, 구조화 metadata를 검증합니다.
- 복원 직전 workspace fingerprint를 재확인합니다.
- restore journal과 attachment generation marker로 DB commit 결과 및 디렉터리 전환을 복구합니다.
- 이번 수정으로 첨부 metadata가 실제 파일과 불일치하는 백업도 기존 작업공간을 건드리기 전에 거부합니다.

### 5.6 브라우저 로컬 복구

- direct draft, Yjs recovery, transition lease는 탭/소스별로 분리됩니다.
- malformed·빈 레코드를 안전한 부재로 간주해 덮어쓰거나 삭제하지 않습니다.
- cross-tab Web Locks를 사용할 수 없으면 파괴적 전환은 fail-closed 됩니다.
- 페이지/블록 삭제 전 모든 관련 draft/recovery를 검사합니다.
- ACK된 상태만 generation/revision 조건으로 제거합니다.

신규 영구 소실 경로는 재현되지 않았습니다.

## 6. 검증 결과

최종 실행 결과:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
48 tests, 48 passed, 0 failed

node scripts/verify-data-loss-guards.mjs
PASS

node --experimental-strip-types scripts/verify-collaboration.mjs
PASS, syntax/source/protocol checks for 163 files

node --experimental-strip-types scripts/reproduce-backup-attachment-metadata-loss.mjs
PASS: vulnerable and fixed states both demonstrated

tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext \
  src/lib/attachment-metadata-integrity.ts
PASS: focused semantic type check
```

주요 로그:

- `audit-logs-2026-07-30-deep/node-tests-baseline.log`
- `audit-logs-2026-07-30-deep/node-tests-final.log`
- `audit-logs-2026-07-30-deep/verify-data-loss-final.log`
- `audit-logs-2026-07-30-deep/verify-collaboration-final.log`
- `audit-logs-2026-07-30-deep/reproduce-backup-attachment-metadata-loss.log`
- `audit-logs-2026-07-30-deep/npm-ci.log`
- `audit-logs-2026-07-30-deep/tsc-focused-attachment-metadata.log`
- `audit-logs-2026-07-30-deep/tsc-full-without-dependencies.log`

## 7. 검증 제한

실행 환경의 내부 npm 프록시가 lockfile의 `zod-3.25.76.tgz` 요청에 404를 반환해 `npm ci --ignore-scripts`를 완료하지 못했습니다. 따라서 `node_modules`가 필요한 전체 Vitest 스위트, 정식 `tsc` 빌드, 실제 MariaDB 통합 테스트는 이 환경에서 재실행하지 못했습니다.

대신 의존성 없이 동작하는 내구성 테스트 48개, 데이터 손실 통합 검증기, 협업 소스/프로토콜/구문 검증, 신규 취약점 재현을 모두 통과했습니다. 신규 순수 metadata 모듈은 전역 TypeScript 5.8.3으로 별도 semantic type check도 통과했습니다. 배포 전 정상 npm 레지스트리와 MariaDB가 있는 환경에서 다음을 최종 게이트로 실행해야 합니다.

```bash
npm ci
npm run check
```

## 8. 원본 ZIP 줄바꿈 손상과 복구

업로드된 ZIP의 작업트리 파일은 Git 객체와 비교했을 때 LF가 CRLF로 확장되어 있었고 PNG 같은 바이너리 파일에도 CR 바이트가 삽입되어 있었습니다. `.git` pack/object는 정상이라 모든 추적 파일을 원본 Git HEAD blob 바이트로 복원한 뒤 이번 수정만 적용했습니다.

이는 애플리케이션 코드 결함이 아니라 전달된 압축본의 작업트리 무결성 문제입니다. 최종 압축본은 추적 바이너리를 Git 객체와 대조해 정상 바이트로 포함합니다.

## 9. `.git` 보존

- `.git` 디렉터리를 삭제·초기화·commit·gc하지 않았습니다.
- 최종 패키징 직전에 감사 도중 갱신된 `.git/index` stat cache만 원본 ZIP의 동일 파일 바이트로 복원합니다.
- `.git` 전체 파일 SHA-256 매니페스트를 원본과 비교합니다.
- 최종 ZIP 내부의 `.git`도 다시 추출해 동일 매니페스트를 확인합니다.

## 10. 변경 파일

수정:

- `src/lib/attachments.ts`
- `src/lib/data-transfer.ts`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- `docs/README.md`

추가:

- `src/lib/attachment-metadata-integrity.ts`
- `tests/backup-attachment-metadata-integrity.node.test.mjs`
- `scripts/reproduce-backup-attachment-metadata-loss.mjs`
- `docs/data-loss-audit-2026-07-30-final-review-ko.md`
- `audit-logs-2026-07-30-deep/*`

## 11. 참고한 공식 문서

- MariaDB Server: START TRANSACTION / COMMIT / ROLLBACK
  - https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction
- MariaDB Server: SQL statements causing an implicit commit
  - https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit
- Node.js File System API
  - https://nodejs.org/api/fs.html
- Yjs document updates
  - https://docs.yjs.dev/api/document-updates
