# BrainVault 독립 데이터 무결성 심층 감사 보고서

- 감사일: 2026-07-30
- 대상 Git HEAD: `5e4bf4985a7ab0022ab6803858fc08af66640921`
- 브랜치: `main`
- 대상: 첨부된 전체 소스, 마이그레이션, 브라우저 복구 저장소, Yjs 협업 서버, 첨부파일 저장소, 백업/복원, 검증·재현 스크립트
- `.git` 기준 매니페스트 SHA-256: `9723dd233f0a9d8b1394bce225f62b04a81f1c12731c6a448e74ef450da9fec9`

## 1. 결론

새로운 **Critical(원격 또는 정상 사용만으로 즉시 영구 소실되는 수준)** 데이터 손실 경로는 재현되지 않았습니다. 현재 코드는 페이지·블록 쓰기 직렬화, 낙관적 버전 검사, Yjs durable log, 서버 권위 materialization, 복원 journal/generation marker, 첨부파일 사용자 단위 잠금 등 다수의 강한 방어를 이미 갖추고 있습니다.

다만 신규로 다음 무결성 결함 1건을 재현했습니다.

### BV-DI-2026-07-30-01 — 동일 크기 첨부 변경 시 복원 불가 백업의 거짓 성공

- 영향도: 높음
- 발생 가능성: 낮음
- 종합 중요도: 중간(Medium)
- 범위: 백업 내보내기
- 원본 데이터 즉시 손실: 없음
- 장애 복구 실패 가능성: 있음

사전 검사 후 ZIP 스트리밍 전에 스테이징된 첨부파일의 내용이 같은 크기로 바뀌면 기존 `ZipWriter.add()`는 바이트 수만 확인하고 이전 CRC32를 헤더에 기록했습니다. 그 결과 ZIP 다운로드가 완성되어도 실제 페이로드와 매니페스트의 CRC32/SHA-256이 달라 복원 시 거부되었습니다.

정상 BrainVault 코드가 해당 스테이징 파일을 다시 쓰지는 않으므로 원격 사용자 입력만으로 쉽게 유발되는 취약점은 아닙니다. 그러나 로컬 변조, 저장장치 오류, 운영 스크립트 간섭 또는 향후 코드 변경이 있을 때 “백업 성공”이라는 잘못된 신호를 만들 수 있어 복구 신뢰성 측면에서 수정 가치가 큽니다.

## 2. 수정 내용

1. `src/lib/zip.ts`
   - ZIP으로 실제 전송되는 모든 청크의 CRC32를 실시간 재계산합니다.
   - 선택적으로 SHA-256을 실시간 계산하고 사전 검사값과 비교합니다.
   - 크기·CRC32·SHA-256 중 하나라도 다르면 중앙 디렉터리를 완성하지 않고 실패합니다.
   - 버퍼 엔트리도 호출자가 제공한 CRC32를 무조건 신뢰하지 않습니다.
   - Node 내장 type stripping으로 독립 회귀 테스트가 가능하도록 생성자의 TypeScript parameter property를 동등한 명시적 필드로 변경했습니다.

2. `src/lib/data-transfer.ts`
   - 첨부파일의 사전 검사 SHA-256을 `ZipWriter`에 전달해 매니페스트와 실제 출력 바이트를 결속했습니다.

3. 재현·검증
   - `scripts/reproduce-backup-stream-integrity-loss.mjs` 추가
   - `tests/backup-stream-integrity.node.test.mjs` 추가
   - `scripts/verify-data-loss-guards.mjs`에 소스 가드와 취약/수정 상태 재현 통합
   - `package.json`에 `reproduce:backup-stream-integrity-loss` 추가

4. 기존 재현성 결함 교정
   - `scripts/reproduce-collaboration-bootstrap-loss.mjs`가 현재의 수정된 `HEAD`를 취약 버전으로 가정해 실패하던 문제를 고쳤습니다.
   - 이제 Git 이력에서 실제 취약 커밋 `243fba624c107dcf452fc9a7dcfcba86f9c9350b`를 찾아 과거 상태와 현재 상태를 각각 검증합니다.

## 3. 심층 검토 범위와 결과

### 데이터베이스 원자성·동시성

- MariaDB 연결에 strict transactional SQL mode가 강제됩니다.
- 주요 페이지·블록 변경은 트랜잭션과 `FOR UPDATE` 잠금을 사용합니다.
- edit/content version CAS와 mutation receipt가 재시도·중복 적용을 방지합니다.
- 커밋 결과가 불명확할 때 성공으로 단정하지 않고 별도 오류로 처리합니다.
- 영구 삭제는 정확한 서브트리 스냅샷과 협업 materialization 상태를 확인한 뒤 실행합니다.

새로운 영구 소실 경로는 재현되지 않았습니다.

### Yjs 협업 저장·materialization

- Yjs 업데이트가 durable SQL log에 먼저 저장됩니다.
- 첫 문서 bootstrap은 기존 SQL 상태와 의미적으로 일치해야 허용됩니다.
- 다중 인스턴스에서 durable tip과 process-local room의 불일치를 검사합니다.
- materialization은 클라이언트 본문이 아니라 정렬된 durable Yjs log에서 재구성합니다.
- 오래된 업데이트 compact/delete는 snapshot 저장과 같은 트랜잭션에서 처리됩니다.
- 브라우저 복구 레코드는 ACK 전까지 유지되고 저장 실패 시 live mutation을 노출하지 않습니다.

기존 회귀 재현들은 모두 수정 상태를 증명했습니다.

### 첨부파일

- 최종 경로는 overwrite 가능한 `rename()` 대신 hard-link claim을 사용합니다.
- 파일과 디렉터리를 fsync하고 DB 커밋 불명확 시 파일을 보수적으로 보존합니다.
- 백업·복원·정리 작업은 사용자 단위 DB 잠금으로 직렬화됩니다.
- 복원은 크기·CRC32·SHA-256 및 매니페스트 관계를 검증합니다.

이번 감사에서 내보내기 스트림 자체의 재검증 누락을 발견하고 수정했습니다.

### 백업·복원

- 백업은 페이지 집합을 잠근 뒤 일관된 스냅샷을 수집합니다.
- 협업 상태가 SQL에 완전히 materialize되지 않은 경우 내보내기를 거부합니다.
- 복원은 임시 디렉터리, journal, generation marker, 원자적 DB 변경 및 디렉터리 전환을 사용합니다.
- 복원 전 워크스페이스 fingerprint를 재확인해 준비 이후의 동시 변경을 차단합니다.
- ZIP 경로·중복·크기·CRC32·SHA-256·부모 관계·참조 무결성을 fail-closed로 검사합니다.

새 수정으로 ZIP에 기록되는 실제 바이트도 매니페스트와 일치해야 내보내기가 완료됩니다.

### 마이그레이션

- 마이그레이션 009의 비원자적 DDL/백필 단계에는 별도 durable marker 복구가 존재합니다.
- 나머지 현재 마이그레이션에서 감사 범위 내 재현 가능한 신규 데이터 삭제 결함은 찾지 못했습니다.
- 다만 MariaDB DDL의 암시적 커밋 특성상 향후 데이터 변환 마이그레이션에는 단계별 marker와 재시작 가능한 설계를 계속 적용해야 합니다.

### 브라우저 로컬 복구

- draft, collaboration recovery, transition lock의 malformed/empty 레코드가 안전한 빈 상태로 오인되지 않습니다.
- cross-tab 소유권과 만료·전환 fence를 검사합니다.
- 저장 실패 시 durable-before-visible 규칙을 유지합니다.

새로운 영구 소실 경로는 재현되지 않았습니다.

## 4. 재현 결과

### 신규 결함

```bash
npm run reproduce:backup-stream-integrity-loss
```

확인된 취약 상태:

- 사전 검사 후 소스 변경: 참
- 파일 크기 동일: 참
- 기존 내보내기 완료 가능: 참
- 생성 백업의 복원 무결성 검사 통과: 거짓
- 복원 불가 백업의 거짓 성공 재현: 참

확인된 수정 상태:

- 스트리밍 CRC32 불일치 거부: 참
- CRC32가 실제 바이트와 같아도 SHA-256 불일치 거부: 참
- 중앙 디렉터리 완성 전 중단: 참

### 기존 부트스트랩 손실 재현

```bash
npm run reproduce:bootstrap-loss
```

- 취약 기준 커밋 자동 탐색: `243fba624c107dcf452fc9a7dcfcba86f9c9350b`
- 불완전 첫 Yjs 문서가 SQL 블록 2개를 0개로 만들 수 있던 과거 상태 재현: 성공
- 현재 구현이 bootstrap을 거부하고 SQL 블록 2개를 보존: 성공

## 5. 검증 결과

- `node --experimental-strip-types --test tests/*.node.test.mjs`: 전체 통과
- `node scripts/verify-data-loss-guards.mjs`: 통과
- `node --experimental-strip-types scripts/verify-collaboration.mjs`: 통과, 152개 파일 소스 연결·프로토콜·구문 검사
- 신규 ZIP 회귀 테스트:
  - 동일 크기 파일 변경 거부
  - 정상 CRC32/SHA-256 ZIP 완성
  - CRC32 일치 상황에서도 SHA-256 불일치 거부
  - 잘못된 버퍼 CRC32 거부
- 수정 스크립트 구문 검사: 통과

## 6. 검증 제한

이 실행 환경에서는 `npm ci --ignore-scripts`가 내부 npm 프록시의 `zod-3.25.76.tgz` 404로 실패했습니다. 따라서 `node_modules`가 필요한 전체 Vitest 스위트, 정식 `tsc` 빌드, 실제 MariaDB 통합 테스트는 실행하지 못했습니다. 전역 `tsc`도 프로젝트의 `@types/node`와 `vitest/globals`가 없어 전체 타입 검사를 시작할 수 없었습니다.

대신 의존성 없이 실행 가능한 Node 회귀 테스트, 모든 내장 데이터 손실 재현, 협업 검증 스크립트, 변경 파일 구문 검사 및 정적 쓰기/삭제 경로 추적을 실행했습니다. 배포 전 정상 네트워크와 MariaDB가 있는 환경에서 아래 최종 게이트를 추가로 실행해야 합니다.

```bash
npm ci
npm run check
```

## 7. `.git` 보존

- `.git` 디렉터리는 삭제·초기화·commit·gc하지 않았습니다.
- 감사 시작 시 28개 `.git` 파일의 SHA-256 매니페스트를 생성했습니다.
- 수정 후 동일 매니페스트 검증에서 28개 모두 일치했습니다.
- 최종 ZIP 내부에서도 동일 검증을 다시 수행하도록 패키징 절차에 포함했습니다.

## 8. 변경 파일

추적 파일:

- `src/lib/zip.ts`
- `src/lib/data-transfer.ts`
- `scripts/reproduce-collaboration-bootstrap-loss.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- `docs/README.md`

새 파일:

- `scripts/reproduce-backup-stream-integrity-loss.mjs`
- `tests/backup-stream-integrity.node.test.mjs`
- `docs/data-loss-audit-2026-07-30-backup-stream-integrity-ko.md`
- `docs/data-loss-audit-2026-07-30-independent-review-ko.md`

## 9. 참고한 공식 자료

- PKWARE APPNOTE ZIP File Format Specification: ZIP 파일별 CRC32 무결성 요구와 local/central header 구조
- Node.js Crypto API: `crypto.createHash()`와 SHA-256 digest
- Node.js File System API: `FileHandle.sync()`의 저장장치 flush 의미
- MariaDB Server Documentation: transaction, commit/rollback, `SELECT ... FOR UPDATE`
- Yjs Documentation: document updates, ordered update application 및 state update 모델
