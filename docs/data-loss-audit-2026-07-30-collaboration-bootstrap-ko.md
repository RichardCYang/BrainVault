# BrainVault 데이터 손실 심층 감사 — 최초 Yjs 협업 부트스트랩 무결성

- 감사일: 2026-07-30 (Asia/Seoul)
- 대상: 업로드된 `BrainVault.zip` 전체 작업 트리 206개 일반 파일과 보존된 `.git`
- 기준 Git HEAD: `243fba624c107dcf452fc9a7dcfcba86f9c9350b`
- 판정: **High — 페이지 전체 블록의 영구 손실 가능**
- 수정 상태: 완료

## 1. 결론

이번 후속 감사에서 **협업 기능을 처음 활성화할 때 SQL 정본과 일치하지 않는 첫 Yjs 문서가 영속 로그의 최초 상태로 채택될 수 있는 중대 무결성 결함**을 확인하고 수정했다.

수정 전에는 첫 WebSocket 클라이언트가 보낸 Yjs 업데이트가 구조적으로 유효하고 크기 제한만 통과하면 `page_yjs_updates`에 저장됐다. 이 문서가 오래되었거나 초기화 도중 일부 블록을 빠뜨렸더라도, 서버는 같은 트랜잭션 안에서 현재 SQL 페이지와 의미적으로 대조하지 않았다. 이후 서버 권위 materialization은 Yjs에 없는 비첨부 블록을 삭제 의도로 해석하여 `DELETE FROM blocks`를 실행하므로, 정상 SQL 페이지의 블록 일부 또는 전부가 영구 삭제될 수 있었다.

결정론적 재현에서는 SQL 정본의 블록 2개가, 제목만 있고 블록이 0개인 유효 후보 문서가 최초 로그로 채택된 뒤 **2개에서 0개로 감소**했다. 수정 후 같은 후보는 로그 삽입 전에 거부되고 SQL 블록 2개가 그대로 유지된다.

이번 범위에서 저장·삭제·백업/복원·첨부파일·페이지/블록 계층·브라우저 임시 복구·Yjs materialization·다중 프로세스 checkpoint 경로를 다시 추적했다. 본 결함 외에 새로 확인된 별도의 Critical/High 영구 손실 경로는 없었다. 이는 취약점 부재를 수학적으로 보증한다는 뜻은 아니며, 아래 환경 제한도 함께 적용된다.

## 2. 취약 경로

### 2.1 최초 공유가 새 협업 세대를 생성

첫 공유 사용자를 추가할 때 기존 `page_yjs_updates`와 `page_collaboration_state`를 삭제하고 새 document epoch를 만든다. 이 시점의 권위 데이터는 SQL `pages`와 `blocks`에만 존재한다.

### 2.2 첫 클라이언트를 부트스트랩 리더로 선택

Yjs 내구 로그가 비어 있으면 서버는 먼저 연결한 클라이언트에 `bootstrap: true`를 보내고, 클라이언트가 세션 API에서 받은 페이지를 Yjs 문서로 구성하여 전체 상태 업데이트를 보낸다.

### 2.3 수정 전 검증 공백

수정 전 서버는 첫 업데이트에 대해 다음만 확인했다.

- Yjs 바이너리 디코딩 가능 여부
- 문서/업데이트 크기 제한
- process-local room과 DB의 update id checkpoint
- 협업 권한 및 document epoch

하지만 다음 핵심 불변식은 없었다.

```text
최초 durable Yjs state == 같은 트랜잭션에서 잠근 SQL page + 모든 blocks
```

따라서 비어 있거나 일부만 있는 문서도 Yjs 자체로는 유효하면 최초 내구 로그가 될 수 있었다.

### 2.4 후속 materialization의 파괴적 효과

서버 권위 materialization은 Yjs 문서에 존재하는 block id를 `activeIds`로 만들고, 존재하지 않는 기존 비첨부 행을 삭제한다. 일반적인 협업 편집 이후에는 올바른 삭제 의미지만, 최초 문서가 SQL 정본의 완전한 복사본이라는 전제가 깨지면 **누락과 삭제 의도를 구분할 수 없다.**

## 3. 재현성 검증

추가 명령:

```bash
npm run reproduce:bootstrap-loss
```

핵심 결과:

```json
{
  "vulnerable": {
    "firstYjsUpdateSemanticallyComparedWithSql": false,
    "incompleteCandidateIsSyntacticallyValid": true,
    "durableHistoryAccepted": true,
    "relationalBlockCountBeforeMaterialization": 2,
    "relationalBlockCountAfterMaterialization": 0,
    "permanentLossWindowReproduced": true
  },
  "fixed": {
    "firstYjsUpdateSemanticallyComparedWithSql": true,
    "bootstrapAccepted": false,
    "missingBlockCount": 2,
    "relationalBlockCountAfterRejectedBootstrap": 2,
    "permanentLossWindowClosed": true
  }
}
```

재현기는 `.git`의 현재 HEAD에 저장된 수정 전 `src/lib/collaboration-server.ts`와 작업 트리의 수정본을 동시에 검사한다. 취약 구현에 의미 대조가 없고 최초 업데이트가 곧바로 INSERT 경로로 진행되는지, 후속 materialization의 삭제 조건이 누락 블록을 제거하는지, 수정본이 같은 후보를 저장 전에 거부하는지를 결정론적으로 증명한다.

## 4. 수정 내용

### 4.1 SQL 정본과 최초 Yjs 문서의 원자적 대조

`src/lib/collaboration-server.ts`의 최초 업데이트 경로를 다음 순서로 변경했다.

1. 기존과 동일하게 페이지 행을 `FOR UPDATE`로 잠금
2. collaboration state/document epoch 잠금 및 확인
3. durable update id가 정확히 0인지 확인
4. 같은 트랜잭션에서 페이지의 모든 block 행을 `FOR UPDATE`로 잠금
5. 후보 Yjs 문서를 서버에서 materialize
6. SQL 정본과 의미적으로 완전 일치하는지 대조
7. 일치하는 경우에만 `page_yjs_updates` INSERT
8. 불일치 또는 디코딩 실패 시 트랜잭션을 변경 없이 종료

이 순서 때문에 세션 응답 후 다른 직접 편집이 발생한 경쟁 상황도 조용히 덮어쓰지 않는다. 첫 후보는 최신 SQL 정본과 불일치하므로 거부되고, 새 세션에서 최신 정본을 다시 가져온다.

### 4.2 의미 동등성 검증기

새 `src/lib/collaboration-bootstrap.ts`는 다음을 비교한다.

- 페이지 제목
- block id 집합의 완전 일치
- type
- markdown 원문
- checked
- parent block id
- sort order
- metadata 전체 구조와 값
- 최초 문서의 attachment tombstone 부재

metadata는 객체 key 순서에는 독립적이되 배열 순서와 모든 실제 값을 보존하는 canonical signature로 비교한다. 잘못된 JSON, 비유한수, 위험한 prototype key, 과도한 깊이/노드 수, 지원 범위 밖 sort order는 정상화하여 통과시키지 않고 실패 폐쇄한다.

### 4.3 브라우저의 안전한 재부트스트랩

서버가 close code `4012`로 최초 문서를 거부하면 브라우저는 다음 조건에서만 자동 재시도한다.

- 아직 ACK되지 않은 startup 문서
- 별도 local recovery record가 없음
- 보존해야 할 recovery 상태가 없음

이 경우 프로세스 메모리의 미확정 Y.Doc만 폐기하고 새 collaboration session을 받아 SQL 정본에서 다시 구성한다. local recovery가 하나라도 있으면 자동 폐기하지 않고 offline 상태로 남겨 복구 데이터를 보존한다.

### 4.4 로그 최소화

불일치 로그에는 페이지/사용자 식별자와 누락·추가·변경 개수만 남기고 제목, 본문, metadata 내용은 기록하지 않는다.

## 5. 수정 후 보장되는 핵심 불변식

```text
첫 page_yjs_updates INSERT 성공
  ⇒ 같은 DB 트랜잭션에서 잠근 pages.title 및 모든 blocks와
     후보 Yjs materialization이 의미적으로 완전 동일

불일치/불완전/비정상 최초 후보
  ⇒ Yjs 로그 미변경 + SQL 페이지 미변경 + 정본 재조회

보존할 local recovery가 있는 최초 후보 거부
  ⇒ 자동 폐기 금지 + 복구 데이터 유지
```

Yjs 업데이트의 교환 법칙·결합 법칙·멱등성은 이미 만들어진 CRDT 상태의 병합과 수렴을 보장하지만, 애플리케이션이 **어떤 최초 상태를 정본으로 승인해야 하는지**까지 결정하지는 않는다. 따라서 SQL→Yjs 전환 경계에는 별도의 애플리케이션 수준 의미 검증이 필요하다.

## 6. 회귀 테스트 및 전체 재검증

### 6.1 새 테스트

- `tests/collaboration-bootstrap-integrity.node.test.mjs`
  - 완전 일치 승인
  - block/key 순서 독립성
  - 누락 후보 거부
  - 변경/추가 block 거부
  - attachment tombstone 거부
  - 제목 불일치 거부
  - 손상된 SQL metadata 실패 폐쇄
- `scripts/reproduce-collaboration-bootstrap-loss.mjs`
  - 수정 전 손실 창과 수정 후 차단을 한 번에 검증
- `verify:collaboration`, `verify:data-loss`에 소스 배선 및 재현 결과 통합

### 6.2 실행 결과

```text
lockfile registry check:              PASS
신규 부트스트랩 손실 재현:             PASS (2 blocks → 0, 수정 후 2 유지)
Node 내구성 테스트:                   28/28 PASS
협업 무결성 검증기:                   PASS (150개 파일 구문/배선 포함)
데이터 손실 가드:                     PASS
신규 모듈 strict TypeScript 단독 검사: PASS
기존 손실 재현기 전체:                7/7 PASS
```

재검증한 기존 손실 모델:

- forged collaboration materialization
- 최초 collaboration bootstrap
- cross-instance stale room/compaction
- 브라우저 recovery write 실패
- stale SQL attachment 위치 재게시
- 구조화 metadata 자동 축약
- block sort-order 범위 overflow

### 6.3 실행 환경 제한

전체 `npm ci`, `npm run build`, Vitest 통합 테스트와 실제 MariaDB 프로세스 기반 crash/race injection은 이번 샌드박스에서 완료하지 못했다.

- 강제 내부 npm mirror가 `yjs@13.6.31` 및 lockfile의 일부 패키지를 404로 반환
- public npm registry 직접 DNS가 차단
- MariaDB 서버/클라이언트가 설치되어 있지 않음
- 전역 `tsc`로 전체 프로젝트를 검사하려 했으나 설치되지 않은 `@types/node`, `vitest/globals` 때문에 시작 단계에서 중단

이는 숨기지 않은 검증 공백이다. 실제 개발/배포 환경에서는 다음을 추가 실행해야 한다.

```bash
npm ci
npm run check
```

그리고 실제 MariaDB에서 다음 경쟁 시험을 권장한다.

1. 최초 협업 세션 응답 직후 직접 SQL/API 편집을 삽입
2. 오래된 탭과 최신 탭이 동시에 최초 WebSocket 후보를 전송
3. 최초 INSERT 전후 DB 연결 강제 종료
4. 다중 Node 프로세스가 update id 0 room을 동시에 생성

## 7. 변경 파일

- `src/lib/collaboration-bootstrap.ts` (신규)
- `src/lib/collaboration-server.ts`
- `public/collaboration.js`
- `tests/collaboration-bootstrap-integrity.node.test.mjs` (신규)
- `scripts/reproduce-collaboration-bootstrap-loss.mjs` (신규)
- `scripts/verify-collaboration.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- 이 감사 보고서

## 8. `.git` 보존 검증

수정 전후 `.git`의 모든 일반 파일 28개에 대해 경로·크기·SHA-256 manifest를 생성해 바이트 단위로 비교했다. 두 manifest는 완전히 동일하며 manifest 자체의 SHA-256은 다음과 같다.

```text
21a0e87c2917da7bb41f26cbdb94569aad6e3c652e13c815fe791ad75ca06e7c
```

최종 ZIP도 별도 디렉터리에 다시 추출한 뒤 같은 검사를 반복해 `.git`과 전체 일반 파일 내용이 수정 트리와 일치함을 확인했다. ZIP 파일의 SHA-256은 압축본과 함께 제공되는 `.sha256` sidecar에 기록한다.

## 9. 공식 기술 근거

- Yjs Document Updates: https://docs.yjs.dev/api/document-updates
- Yjs README / `encodeStateAsUpdate`: https://github.com/yjs/yjs/blob/main/README.md
- MariaDB `FOR UPDATE`: https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update
- MariaDB transactions: https://mariadb.com/docs/server/reference/sql-statements/transactions
- MariaDB `START TRANSACTION`: https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction
