# BrainVault 데이터 무결성 재감사 — 페이지 경계를 넘는 블록 삭제 연쇄

- 감사일: 2026-07-30
- 대상 Git HEAD: `cc16e93`
- 대상: 업로드된 전체 프로젝트, 데이터베이스 스키마·마이그레이션, 페이지/블록 삭제, Yjs materialization, 첨부파일, 전체 백업/복원, 브라우저 복구
- `.git`: 삭제·초기화·commit·gc 없이 원본 파일을 그대로 보존

## 결론

정상 UI/API 요청만으로 현재 노트가 즉시 영구 소실되는 신규 Critical 경로는 확인되지 않았다. 기존 버전의 durable Yjs log, 서버 권위 materialization, 삭제 스냅샷, 첨부파일 사용자 잠금, 복원 journal/generation marker, ZIP CRC32·SHA-256 검증은 현재 소스에서도 유지되고 있었다.

다만 데이터베이스 방어 계층에서 다음 무결성 공백을 재현했다.

## BV-DI-2026-07-30-02 — 단일 열 부모 FK의 교차 페이지 cascade 삭제

### 영향

기존 `blocks.parent_block_id -> blocks.id ON DELETE CASCADE` 제약은 부모 블록의 존재만 확인하고 부모·자식의 `page_id`가 같은지는 확인하지 않았다. 현재 REST, Yjs materialization, 백업 복원 코드는 모두 같은 페이지 부모를 검사하므로 정상 원격 요청만으로 이 상태를 만드는 경로는 찾지 못했다.

그러나 레거시 데이터, 수동 SQL, 운영 도구, 손상된 마이그레이션 또는 향후 누락된 쓰기 경로가 교차 페이지 부모를 한 번 만들면, 부모 블록을 정상 삭제하는 순간 다른 페이지의 자식 블록까지 DB cascade로 영구 삭제될 수 있다. 애플리케이션 삭제 스냅샷은 대상 페이지 블록만 수집하므로 이 외부 자식은 삭제 예정 목록에도 나타나지 않는다.

- 중요도: Medium(방어 계층 무결성)
- 원격 정상 사용만으로 생성 가능: 확인되지 않음
- 손상 상태가 이미 존재할 때 영구 소실: 재현됨
- 다른 계정까지 영향 가능성: 스키마상 존재

## 수정

1. 신규 설치 스키마
   - `(id, page_id)` 복합 고유 키를 추가했다.
   - 부모 FK를 `(parent_block_id, page_id) -> (id, page_id)`로 변경했다.
   - 같은 페이지의 정상 subtree cascade는 그대로 유지하면서 교차 페이지 참조는 DB가 거부한다.

2. 기존 설치 마이그레이션 `023_blocks_parent_page_integrity.sql`
   - 복합 키를 먼저 추가한다.
   - 복합 FK가 없을 때만 동적 DDL로 추가한다.
   - 강한 FK가 존재한 뒤에만 레거시 단일 열 FK를 제거한다.
   - MariaDB DDL의 implicit commit을 고려해 각 단계가 재실행 가능하도록 `information_schema` 검사와 prepared statement를 사용했다.
   - 기존 DB에 교차 페이지 부모가 이미 있으면 FK 추가가 실패하고, 데이터를 자동 삭제·수정하지 않은 채 관리자가 먼저 복구하도록 fail-closed 한다.

3. 재현·회귀 검증
   - `scripts/reproduce-cross-page-parent-cascade-loss.mjs`
   - `tests/cross-page-parent-integrity.node.test.mjs`
   - `scripts/verify-data-loss-guards.mjs` 통합
   - `package.json`에 `reproduce:cross-page-parent-loss` 추가

## 재현 결과

레거시 단일 열 FK 모델:

- 다른 페이지 자식이 부모 ID만 맞으면 허용: 참
- 부모 삭제 시 다른 페이지 자식 cascade 삭제: 참
- 영구 교차 페이지 소실 창: 재현됨

수정 복합 FK 모델:

- 교차 페이지 부모 참조 거부: 참
- 같은 페이지 정상 부모/자식 허용: 참
- 같은 페이지 subtree cascade 유지: 참
- 신규 설치와 업그레이드 마이그레이션 모두 복합 FK 사용: 참

실행:

```bash
npm run reproduce:cross-page-parent-loss
node --experimental-strip-types --test tests/*.node.test.mjs
node scripts/verify-data-loss-guards.mjs
node --experimental-strip-types scripts/verify-collaboration.mjs
```

## 전체 검증 결과

- dependency-free durability 테스트: 통과
- 데이터 손실 source/reproduction verifier: 통과
- 협업 source/protocol/syntax verifier: 통과
- 기존 ZIP 동일 크기 변조, structured metadata, sort-order, Yjs bootstrap/materialization, browser durable-before-visible 회귀: 통과

## 제한

이 감사 환경의 내부 npm 프록시가 `zod-3.25.76.tgz`를 404로 반환하여 `npm ci`를 완료하지 못했다. 따라서 `node_modules`가 필요한 전체 Vitest, 정식 TypeScript build, 실제 MariaDB 통합 마이그레이션 실행은 이 환경에서 수행하지 못했다. 배포 전 정상 npm 네트워크와 MariaDB가 있는 환경에서 다음을 실행해야 한다.

```bash
npm ci
npm run check
npm run db:migrate
```

`023` 마이그레이션이 교차 페이지 부모 데이터 때문에 실패하면 자동 수정하지 말고 다음 진단 쿼리로 행을 백업·검토한 뒤 올바른 같은 페이지 부모로 연결하거나 `NULL`로 분리해야 한다.

```sql
SELECT child.id, child.page_id, child.parent_block_id, parent.page_id AS parent_page_id
FROM blocks child
JOIN blocks parent ON parent.id = child.parent_block_id
WHERE child.parent_block_id IS NOT NULL
  AND child.page_id <> parent.page_id;
```

## `.git` 보존

감사 시작 시 `.git` 내부 28개 일반 파일의 SHA-256 매니페스트를 만들었다. 최종 패키징 전후에 같은 파일 수와 해시를 비교하며, `.git`은 삭제·재생성·commit·gc하지 않는다.
