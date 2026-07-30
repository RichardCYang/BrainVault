# BrainVault 데이터 손실 심층 감사 — 블록 순서 범위 무결성

- 감사일: 2026-07-30
- 대상: 업로드된 BrainVault 전체 작업 트리
- 판정: **높음(High) — 조용한 구조적 순서 손실 가능**
- 수정 상태: 완료

## 결론

`blocks.sort_order`는 MariaDB의 signed `INT`이므로 저장 가능한 최댓값은 `2,147,483,647`이다. 그러나 수정 전에는 다음 입력 경로가 상한 없이 정수를 허용했다.

1. 일반 블록 생성 및 수정 API
2. 블록 재정렬 API
3. 첨부 블록 생성 폼
4. 백업 ZIP 복원 manifest
5. 형제 목록 끝에 자동 추가할 때의 `last_sort_order + 1`

MariaDB 공식 문서에 따르면 엄격 SQL 모드가 꺼져 있으면 범위를 벗어난 숫자는 가장 가까운 유효 경계값으로 조정되고 경고가 발생한다. Node.js 커넥터의 성공 결과에는 `warningStatus`가 노출되지만, 기존 쓰기 경로는 이 경고를 무결성 실패로 처리하지 않았다. 따라서 서로 다른 큰 순서값이 모두 `INT_MAX`로 저장되고, 이후 `ORDER BY sort_order, id`의 ID 보조 정렬이 사용자가 의도한 블록 순서를 대체할 수 있었다.

이는 본문 문자열 자체를 삭제하지는 않지만, 목록·문서 구조에서 의미를 가지는 블록 순서를 영구적으로 바꿀 수 있는 **구조 데이터 손실**이다.

## 재현

실행:

```bash
npm run reproduce:block-order-loss
```

재현기는 MariaDB 문서에 명시된 비엄격 모드의 경계값 조정 동작을 모델링한다.

- 요청: `INT_MAX + 1`, `INT_MAX + 2`
- 저장: 두 값 모두 `INT_MAX`
- 의도 순서: `blk_z`, `blk_a`
- 조회 순서: `blk_a`, `blk_z`

수정 후에는 두 요청이 SQL 실행 전에 거부되며, 기존 최댓값 뒤에 자동 추가하는 동작도 `409 BLOCK_ORDER_RANGE_EXHAUSTED`로 실패 종료된다.

## 수정 내용

### 1. 단일 범위 계약

`src/lib/block-order-integrity.ts`에 `0..2,147,483,647` 범위를 정의하고, 안전 정수 검증과 자동 증가 오버플로 방지를 중앙화했다.

### 2. 모든 외부 입력 경로 차단

`src/routes/block.routes.ts`의 생성·수정·재정렬·첨부 업로드 스키마가 동일한 상한을 사용한다.

### 3. 자동 추가 오버플로 차단

`lastBlock.sort_order + 1` 직접 연산을 제거했다. 범위가 소진되었거나 기존 값이 유효하지 않으면 DB 쓰기 전에 실패하며 아무 블록도 생성하지 않는다.

### 4. 백업 복원 검증

`src/lib/data-transfer.ts`가 범위 밖 또는 음수 `sort_order`를 가진 백업을 트랜잭션 실행 전에 거부한다.

### 5. DB 세션 방어

`src/lib/db.ts`의 MariaDB 풀 `initSql`로 모든 연결에 `STRICT_TRANS_TABLES`를 보장한다. 운영자의 전역 SQL 모드가 느슨하더라도 유효하지 않은 트랜잭션 쓰기가 경고만 남기고 변환되지 않도록 한다.

### 6. 회귀 테스트

- `tests/block-order-integrity.node.test.mjs`
- `scripts/reproduce-block-sort-order-overflow-loss.mjs`
- `scripts/verify-data-loss-guards.mjs` 통합

## 변경 파일

- `src/lib/block-order-integrity.ts` (신규)
- `src/routes/block.routes.ts`
- `src/lib/data-transfer.ts`
- `src/lib/db.ts`
- `scripts/reproduce-block-sort-order-overflow-loss.mjs` (신규)
- `tests/block-order-integrity.node.test.mjs` (신규)
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- 이 감사 보고서

## `.git` 보존 검증

수정 전후 `.git` 내부의 모든 일반 파일을 경로순으로 SHA-256 계산한 manifest의 SHA-256은 모두 아래와 같았다.

```text
0e12a8231ce8b64744181fc58d722c8f0bc4dd23a7dffb884622a6875147212f
```

따라서 감사·수정 과정에서 `.git` 내부 파일은 변경하거나 삭제하지 않았다. 원본 업로드 ZIP의 SHA-256은 `53673e7388fcadaee5bb46fff7b6fa30ba277aa6e8a48f67215eeb768c26d793`이다.

## 검증 범위와 제한

- 정적 데이터 흐름 감사: 완료
- 문서화된 취약 동작의 결정론적 재현: 완료
- 수정 후 경계·오버플로·전체 입력 표면 테스트: 완료
- 기존 무의존 내구성 테스트 및 데이터 손실 가드: 완료 (`23/23` 통과)
- JavaScript/MJS 구문 검사: `31/31` 통과
- TypeScript 실행 소스 구문 검사(선언 파일 제외): `101/101` 통과
- 협업 무결성 검증기: 통과 (`147`개 파일 배선·구문 검사 포함)
- 재현 명령 6종: 모두 완료
- 실제 MariaDB 프로세스 기반 통합 재현: 현재 실행 환경에 MariaDB 서버/클라이언트가 없어 미실행
- 전체 npm 빌드/Vitest: 실행 환경의 내부 npm 미러가 `zod@3.25.76` tarball을 반환하지 않아 미실행

위 두 환경 제한은 보고서에 숨기지 않았으며, 수정본에는 실제 MariaDB가 있는 개발 환경에서 그대로 실행할 수 있는 스크립트가 포함되어 있다.

## 공식 근거

- MariaDB INT: https://mariadb.com/docs/server/reference/data-types/numeric-data-types/int
- MariaDB Numeric Data Type Overview: https://mariadb.com/docs/server/reference/data-types/numeric-data-types/numeric-data-type-overview
- MariaDB Connector/Node.js Promise API (`warningStatus`): https://mariadb.com/docs/connectors/mariadb-connector-nodejs/connector-nodejs-promise-api
- MariaDB Connector/Node.js Connection Options (`initSql`): https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options
- MariaDB SQL_MODE: https://mariadb.com/docs/server/server-management/variables-and-modes/sql_mode
