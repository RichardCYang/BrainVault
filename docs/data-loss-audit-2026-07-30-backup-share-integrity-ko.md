# BrainVault 백업 공유 권한 무결성 심층 감사

- 감사일: 2026-07-30
- 기준 Git 커밋: `69610238d9e0686b2546619edcfa4ffe194c48f9`
- 대상: 첨부된 BrainVault 전체 소스와 `.git` 이력
- 중점 범위: MariaDB 트랜잭션/FK, 전체 백업·복원, 첨부파일 세대 전환, Yjs 협업 상태, 브라우저 복구, 마이그레이션 재실행 안전성

## 결론

기존 코드에는 **전체 워크스페이스 백업을 정상적으로 복원해도 페이지 공유 권한이 영구적으로 사라질 수 있는 높은 심각도의 데이터 무결성 결함**이 있었다.

노트 본문이나 첨부파일 바이트가 직접 손실되는 결함은 아니지만, `page_shares`는 사용자가 구성한 워크스페이스 상태이자 접근 관계 데이터다. UI와 문서는 기능을 “complete backup/restore”로 안내했지만 백업 manifest에는 이 관계가 없었다. 복원은 소유 페이지를 먼저 삭제하고, 외래키 `ON DELETE CASCADE`가 기존 공유 행을 모두 지운 뒤 이를 재생성하지 않았다.

수정본은 다음을 보장한다.

1. 새 백업은 페이지 공유 관계를 collaborator 로그인 ID와 함께 저장한다.
2. 복원은 파괴적 삭제 전에 모든 collaborator 계정을 확인하고 행 잠금을 획득한다.
3. 계정 누락, 자기 자신 공유, 중복 공유, 존재하지 않는 페이지, 컬렉션/보관 페이지 공유가 발견되면 **아무 데이터도 교체하기 전에 실패**한다.
4. 유효한 새 백업은 `page_shares`를 트랜잭션 안에서 다시 삽입한다.
5. `pageShares`가 없던 구형 백업은 동일한 shareable 페이지 ID에 대한 현재 공유 관계를 보존한다.
6. API와 7개 언어 UI가 복원한 공유 권한 수를 표시한다.

## 신규 결함: 전체 복원 뒤 공유 권한 영구 손실

### 심각도

**High — 데이터/구성 무결성 손실**

영향:

- 정상 완료된 복원인데도 초대 편집자 전원이 제거됨
- 공유 대상과 권한을 백업에서 복구할 방법이 없음
- 사용자가 어떤 페이지를 누구와 공유했는지 별도 기록하지 않았다면 수동 복구도 불완전할 수 있음
- 복원 성공 응답만으로는 손실을 알아차리기 어려움

### 근본 원인

마이그레이션 `020_page_sharing_yjs_collaboration.sql`은 다음 관계를 정의한다.

```sql
CONSTRAINT fk_page_shares_page
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
```

기존 복원 경로는 다음 삭제를 수행했다.

```sql
DELETE FROM pages WHERE owner_id = ?
```

그러나 기존 백업 manifest는 `pages`, `blocks`, `tags`, `pageTags`, attachments만 저장했고 `page_shares`를 내보내거나 다시 삽입하지 않았다. 따라서 페이지 삭제가 정상적으로 성공하는 순간 공유 행도 cascade 삭제되며, 이후 복원 트랜잭션은 공유 행 없이 커밋됐다.

### 재현

프로젝트에 다음 명령을 추가했다.

```bash
npm run reproduce:backup-share-loss
```

재현기는 Git HEAD의 취약 원본과 수정된 working tree를 비교해 다음 조건을 검증한다.

- 취약본 manifest가 `pageShares`를 누락함
- 취약본이 소유 페이지 전체를 삭제함
- 취약본이 `page_shares`를 재삽입하지 않음
- 성공 복원 뒤 공유 관계 수가 1개에서 0개로 감소함
- 수정본은 새 백업과 구형 백업 모두에서 공유 관계를 보존함

독립적인 SQL FK 재현에서도 `ON DELETE CASCADE`가 설정된 부모 페이지 삭제 후 공유 행이 `1 → 0`으로 감소함을 확인했다. 로그는 `audit-logs/sql-foreign-key-cascade-reproduction.log`에 있다.

## 수정 내용

### 1. 백업 manifest 확장

`src/lib/data-transfer.ts`에 `pageShareSchema`와 선택적 `data.pageShares`를 추가했다.

저장 필드:

- `page_id`
- `shared_username`
- `permission` (`EDIT`만 허용)
- `created_at`

`pageShares`를 optional로 둔 이유는 기존 버전 1 백업과의 하위 호환성 때문이다. 새 백업은 항상 이 배열을 포함한다.

### 2. 복원 전 관계 검증

manifest 관계 검증에 다음 항목을 추가했다.

- `(page_id, lower(shared_username))` 중복 금지
- 공유 대상 페이지가 manifest에 존재해야 함
- 컬렉션 또는 보관 페이지에는 공유 관계를 적용하지 않음
- permission은 `EDIT`만 허용

### 3. 파괴적 삭제 전 collaborator 해석과 잠금

현재 형식 백업은 collaborator 로그인 ID를 `users` 행으로 해석하고 `FOR UPDATE`로 잠근다.

다음 조건에서는 `INVALID_DATA_BACKUP`으로 실패하며, 이 시점에는 아직 `DELETE FROM pages`가 실행되지 않는다.

- collaborator 계정이 목적지 서버에 없음
- owner 자신을 collaborator로 지정함
- manifest 관계가 유효하지 않음

이는 복원 중 사용자 삭제/변경과의 경합도 차단한다.

### 4. 구형 백업의 공유 관계 보존

`pageShares` 필드가 없는 백업은 백업 생성 시점의 공유 상태를 알 수 없다. 기존 동작처럼 전부 삭제하는 대신, 복원 직전 잠근 현재 공유 관계 중 다음 조건을 만족하는 행을 재삽입한다.

- 백업에 동일 page ID가 존재함
- 해당 페이지가 collection이 아님
- 해당 페이지가 archived가 아님
- collaborator 계정이 여전히 존재함

복원 응답의 `sharing.mode`는 이 경우 `legacy-preserved`다.

### 5. 트랜잭션 내부 재삽입

페이지·블록·태그·태그 관계를 가져온 뒤 `page_shares`를 같은 DB 트랜잭션에서 다시 삽입한다. 삽입 실패 시 DB replacement 전체가 롤백된다. 기존 restore journal과 attachment generation 전환 로직은 유지했다.

### 6. API/UI/문서 동기화

- `/api/data/import`가 `counts.shares`와 `sharing` 결과를 반환
- OpenAPI 응답 스키마 갱신
- 복원 완료 메시지에 공유 권한 수 표시
- 영어, 일본어, 한국어, 프랑스어, 독일어, 스페인어, 포르투갈어 안내 갱신
- Features, Security, API 문서 갱신

## 회귀 및 재현 검증

수정 후 실행한 의존성 독립 검증:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
36 tests passed, 0 failed
```

```text
node scripts/verify-data-loss-guards.mjs
OK
```

```text
node --experimental-strip-types scripts/verify-collaboration.mjs
OK — source/protocol checks and syntax for 156 files
```

```text
node scripts/reproduce-backup-share-loss.mjs
vulnerable state reproduced; fixed new/legacy paths preserved shares
```

추가된 테스트:

- `tests/backup-share-integrity.node.test.mjs`
- `tests/data-transfer.routes.test.ts`의 공유 관계 ZIP round-trip 검증

검증 로그는 `audit-logs/`에 포함했다.

## 감사 중 확인한 기존 주요 방어선

다음 경로도 정적 추적과 기존 재현 테스트로 다시 확인했다.

- DB 쓰기 트랜잭션과 strict transactional SQL mode
- 페이지/블록 edit-version CAS와 commit 결과 불명확 처리
- 첨부파일 hard-link claim, fsync, restore journal, generation marker
- ZIP stream 중 CRC-32와 SHA-256 재검증
- Yjs durable update log, document epoch, server-authoritative materialization
- 복원 전 live collaboration room 무효화
- 브라우저 direct draft/Yjs recovery fail-closed 검사
- 블록 부모의 page-scoped 복합 FK
- 구조화 metadata와 block sort-order의 무손실 경계 검사
- 마이그레이션 재실행 안전성과 DDL 경계

이번 추가 감사에서 위 방어선을 우회해 노트 본문/첨부파일 바이트를 손실시키는 별도의 신규 재현 경로는 확인하지 못했다. 이는 결함 부재의 수학적 증명은 아니며, 실제 운영 MariaDB·다중 서버·장애 주입 환경의 지속 검증은 필요하다.

## 검증 환경 제한

`npm ci --ignore-scripts`는 프로젝트 문제가 아니라 현재 실행 환경의 내부 npm mirror가 `zod@3.25.76` tarball을 404로 반환해 완료되지 않았다. 따라서 다음 항목은 이 환경에서 실행하지 못했다.

- 전체 Vitest suite
- `tsc` 기반 전체 프로젝트 type-check/build
- 실제 MariaDB를 연결한 통합 round-trip
- 실제 브라우저 E2E

대신 Node 내장 test runner, TypeScript syntax stripping/check, 프로젝트의 데이터 손실·협업 검증기, 결정적 재현기를 실행했다. 배포 전 실제 개발 환경에서 다음을 반드시 추가 실행해야 한다.

```bash
npm ci
npm test
npm run build
npm run verify:data-loss
npm run verify:collaboration
```

MariaDB 테스트 계정에서 최소한 다음 시나리오를 확인해야 한다.

1. 공유 페이지 1개를 포함한 새 백업 export/import round-trip
2. collaborator 계정이 없는 목적지에서 restore가 삭제 전에 실패하는지
3. `pageShares`를 제거한 구형 manifest 복원 시 현재 grant가 유지되는지
4. 복원 중 서버 종료 후 journal recovery가 DB/attachment/share 상태를 일치시키는지
5. 두 서버 인스턴스와 열린 협업 탭이 있는 상태에서 restore generation이 오래된 Yjs 문서를 차단하는지

## 변경 파일

핵심 코드:

- `src/lib/data-transfer.ts`
- `src/routes/data.routes.ts`
- `public/app.js`
- `public/i18n.js`

테스트/재현:

- `scripts/reproduce-backup-share-loss.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `scripts/verify-collaboration.mjs`
- `tests/backup-share-integrity.node.test.mjs`
- `tests/data-transfer.routes.test.ts`
- `package.json`

계약/문서:

- `docs/openapi.yaml`
- `docs/api.md`
- `docs/features.md`
- `docs/security.md`
- `docs/README.md`
- `README.md`

## `.git` 보존

수정 작업은 `.git` 디렉터리를 삭제하거나 재생성하지 않았다. 원본 ZIP과 수정 작업 디렉터리의 `.git` 43개 엔트리(일반 파일 28개)를 비교했으며 모든 파일 바이트가 동일하다. 감사 중 Git 상태 조회가 갱신한 index stat cache는 원본 `.git/index`로 복구했고, 최종 index SHA-256은 `0f7067637f67d9b94803288268c837ce0ed04709fb58defc78de09e3704399a9`다. 전달 ZIP을 별도 디렉터리에 다시 풀어 원본과 수정본의 255개 파일 목록·바이트 일치, `.git` 28개 파일의 원본 바이트 일치, 36개 내구성 테스트와 두 검증 스크립트 통과를 다시 확인했다.
