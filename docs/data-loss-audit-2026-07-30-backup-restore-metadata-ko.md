# BrainVault 백업 복원 구조화 메타데이터 무결성 감사 및 수정 보고서

- 감사일: 2026-07-30 (Asia/Seoul)
- 대상 Git HEAD: `a9044cc05463bed8daf14385631f7d389cad57ad`
- 브랜치: `main`
- 대상: 업로드된 전체 작업 트리, 보존된 `.git`, MariaDB 저장 계층, Yjs 협업 내구성, 첨부파일, 백업/복원, 브라우저 복구
- 감사 시작 `.git` 파일 수: 28
- 감사 시작 `.git` 매니페스트 SHA-256: `1b4e2af32b04862634c25f2d94fb295c627a632686de5da1c6e01ba1c2d275c2`

## 1. 결론

이번 독립 재감사에서 **백업 복원 후 정상 편집만으로 구조화 블록 데이터 일부가 조용히 영구 삭제될 수 있는 신규 High 무결성 결함 1건**을 재현하고 수정했다.

### BV-DI-2026-07-30-RESTORE-METADATA

- 영향도: High
- 발생 조건: 구버전·수동 작성·부분 손상된 백업에 편집기 한도를 넘거나 이중 인코딩된 TABLE/KANBAN/DATABASE/BOOKMARK/AI_CHAT metadata가 포함됨
- 즉시 복원 결과: 원본 metadata 문자열은 DB에 들어가므로 초과 데이터가 즉시 삭제되지는 않음
- 지연 손실: 편집기가 화면 상태를 한도까지 정규화한 뒤 사용자가 블록을 편집·저장하면 화면에 나타나지 않은 데이터가 권위 metadata에서 제거됨
- 기존 방어 공백: 복원 검증이 metadata에 대해 `JSON.parse()` 성공 여부만 확인하고, 애플리케이션 스키마와 무손실 편집 가능성을 확인하지 않음

결정론적 재현에서는 JSON 문법상 정상인 51행 TABLE 백업이 복원 검사를 통과한 뒤 편집기 projection에서 50행으로 축소됐고, 축소된 50행 상태는 정상 저장 입력으로 인정됐다. 따라서 51번째 행은 다음 저장 시 영구 소실될 수 있었다.

이번 수정 후에는 복원 파일의 직렬화된 metadata를 기존 서버 무손실 검증기로 검사하며, 손실 가능 입력은 워크스페이스 삭제·DB 충돌 검사·첨부파일 교체 전에 `INVALID_DATA_BACKUP`으로 실패 폐쇄된다.

## 2. 원인 분석

기존 `validateManifestRelations()`의 metadata 검사는 다음과 같았다.

```text
metadata === null
  또는
JSON.parse(metadata)가 예외 없이 성공
```

이 검사는 JSON 문법만 증명한다. 그러나 편집기와 서버 렌더러는 구조화 데이터에 다음 상한 및 정규화를 적용한다.

- TABLE: 최대 50행, 20열, 셀 4,000자
- KANBAN: 최대 12열, 열당 카드 50개, 태그·제목·설명 길이 제한
- DATABASE: 최대 20속성, 200행, 12뷰, 옵션·필터·정렬 제한과 참조 정리
- BOOKMARK: 최대 50개, URL canonicalization, 중복·문자열 제한
- AI_CHAT: 질문 8,000자, 답변 12,000자, provider/model/date 형식 제한

이 정규화는 손상 입력을 안전하게 화면에 표시하기 위한 projection으로는 타당하지만, 복원된 원본이 projection 한도를 넘는 상태에서 다음 편집 저장이 발생하면 projection만 다시 전송된다. 기존 저장 경로의 무손실 가드는 이미 projection 자체는 정상으로 인정하므로, 화면에서 제거된 원본 데이터는 복구 사본 없이 사라진다.

추가 검토에서 이중 JSON 인코딩도 확인했다. 복원 도우미가 먼저 `JSON.parse()`한 값을 다시 구조화 검증기에 전달하면, `"{...}"` 형태의 JSON 문자열이 두 번 해석되어 검증을 통과할 수 있다. 실제 편집기·매퍼는 저장 표현을 한 번만 해석하므로 표현 불일치가 생긴다. 최종 수정은 **디코딩된 값이 아니라 백업에 들어 있던 직렬화 문자열 자체**를 구조화 검증기에 전달한다.

## 3. 수정 내용

### `src/lib/structured-metadata-integrity.ts`

- `BackupMetadataIntegrityError` 추가
- `assertLosslessBackupBlockMetadata()` 추가
- 모든 metadata에 대해 JSON 문법 검증
- 구조화 블록은 직렬화된 백업 값을 직접 `assertStructuredBlockMetadataIntegrity()`에 전달
- 한도 초과, 손실성 정규화, 관계 참조 오류, 이중 인코딩을 명확한 path와 함께 거부
- 정상 metadata는 변경하거나 재직렬화하지 않음

### `src/lib/data-transfer.ts`

- `validateManifestRelations()`의 단순 `JSON.parse()` 검사 교체
- 각 블록에 `assertLosslessBackupBlockMetadata()` 적용
- 실패 시 `INVALID_DATA_BACKUP`과 손실 가능 metadata path/reason 반환
- 검증 순서는 다음보다 앞선다.
  - `assertNoForeignIdConflicts()`
  - 사용자 워크스페이스 잠금
  - 기존 페이지 삭제
  - 첨부파일 generation 교체

따라서 하나의 손실 가능 블록 때문에 정상 워크스페이스가 먼저 교체되는 부분 복원은 발생하지 않는다.

### 재현·회귀 자산

- `scripts/reproduce-backup-metadata-loss.mjs`
- `tests/backup-metadata-integrity.node.test.mjs`
- `package.json`의 `reproduce:backup-metadata-loss`
- `scripts/verify-data-loss-guards.mjs` 통합 가드

## 4. 재현 결과

실행:

```bash
npm run reproduce:backup-metadata-loss
```

검증된 취약 상태:

```json
{
  "jsonSyntaxAccepted": true,
  "originalRows": 51,
  "rowsAfterEditorProjection": 50,
  "silentlyLostRowsAfterNextSave": 1,
  "projectedSaveWouldBeAccepted": true,
  "permanentStructuredDataLossReproduced": true
}
```

검증된 수정 상태:

```json
{
  "rejectedBeforeRestoreDatabaseWork": true,
  "rejectedPath": "metadata.table.rows",
  "doubleEncodedRejected": true,
  "lossClosed": true
}
```

경계값 50행 TABLE은 그대로 허용된다. 즉, 정상 백업을 변형하거나 임의로 축약하지 않고 손실 가능 백업만 실패 폐쇄한다.

## 5. 전체 심층 검토 요약

### MariaDB 트랜잭션과 계층 삭제

- 주요 변경은 InnoDB 트랜잭션과 행 잠금을 사용한다.
- 페이지/블록 영구 삭제는 subtree 버전 snapshot과 잠금 후 수행된다.
- 블록 부모 FK는 `(parent_block_id, page_id)` 복합 관계로 페이지 범위를 벗어난 cascade를 막는다.
- commit 결과 불명 상태를 일반 실패로 간주해 파일을 성급히 삭제하지 않는다.

신규 영구 손실 경로는 이번 범위에서 추가 재현되지 않았다.

### Yjs 협업

- Yjs update는 브로드캐스트/ACK 전에 SQL durable log에 기록된다.
- 첫 문서 bootstrap은 현재 SQL 문서와 의미적으로 일치해야 한다.
- materialization은 브라우저 snapshot이 아니라 잠긴 durable update log에서 재구성된다.
- snapshot 저장과 오래된 update 삭제는 같은 트랜잭션에서 수행된다.
- 다중 인스턴스 stale room, materialization checkpoint provenance, 협업 삭제 전 cross-tab recovery fence가 존재한다.

협업 검증 스크립트는 현재 수정본의 160개 파일 연결·프로토콜·구문 검사를 통과했다.

### 첨부파일

- 최종 파일 publish는 overwrite 가능한 rename 대신 exclusive hard-link claim을 사용한다.
- 파일과 디렉터리를 fsync한다.
- DB write 결과가 불명확하면 파일을 보수적으로 보존한다.
- 삭제 정리는 owner lock 아래 DB 존재를 재확인한 뒤 수행한다.
- 백업/복원은 크기·CRC32·SHA-256과 generation journal을 검증한다.

신규 첨부 바이트 손실 경로는 이번 범위에서 추가 재현되지 않았다.

### 브라우저 복구와 전환

- draft/recovery가 durable storage에 기록되기 전에 live mutation을 노출하지 않는다.
- 페이지·블록 파괴 작업 전에 다른 탭의 미확인 recovery를 검사한다.
- transition lease, source scope, malformed storage fail-closed 검사가 유지된다.

신규 영구 손실 경로는 이번 범위에서 추가 재현되지 않았다.

## 6. 검증 결과

통과:

- `node --experimental-strip-types --test tests/*.node.test.mjs`
  - 신규 4개 포함 전체 43개 내구성 테스트 통과
- `node scripts/verify-data-loss-guards.mjs`
  - 신규 백업 metadata 취약/수정 상태 재현 포함 통과
- `node --experimental-strip-types scripts/verify-collaboration.mjs`
  - 160개 파일 검사 통과
- `node scripts/lockfile-registry.mjs`
  - 347개 resolved URL 허용 registry 검사 통과
- 수정된 독립 무결성 모듈 TypeScript 검사
  - 빈 외부 type root를 사용한 단독 `tsc --noEmit` 통과
- 신규 재현 스크립트 및 통합 verifier 구문 검사 통과

## 7. 환경 제한

이 샌드박스의 `NPM_CONFIG_REGISTRY`는 프로젝트 `.npmrc`보다 우선하는 내부 Artifactory로 강제됐다. 해당 미러에서 `zod@3.25.76`이 404를 반환해 `npm ci --ignore-scripts`가 완료되지 않았고, npm이 만든 부분 설치 `node_modules`는 최종 산출물에서 제거했다.

따라서 다음은 이 환경에서 완료할 수 없었다.

- 전체 정식 `tsc -p tsconfig.json` 빌드
- Vitest 전체 단위·통합 테스트
- 실제 MariaDB 프로세스를 사용한 통합/장애 주입 테스트

실패 로그상 소스 오류가 아니라 `@types/node`, `vitest`, `mariadb`, `zod` 등 의존성 파일이 비어 있거나 누락된 상태가 원인이었다. 정상 npm registry와 MariaDB를 사용할 수 있는 배포 환경에서 최종 게이트로 다음을 실행해야 한다.

```bash
npm ci
npm run check
```

## 8. `.git` 보존

- `.git` 디렉터리를 삭제·초기화·commit·gc·checkout하지 않았다.
- 감사 시작과 수정 후 모두 28개 파일이다.
- 시작/수정 후 재귀 파일 SHA-256 매니페스트가 모두 `1b4e2af32b04862634c25f2d94fb295c627a632686de5da1c6e01ba1c2d275c2`로 일치한다.
- 최종 ZIP 생성 후 ZIP 내부 `.git`을 다시 바이트 단위 검증한다.

## 9. 변경 파일

수정:

- `src/lib/structured-metadata-integrity.ts`
- `src/lib/data-transfer.ts`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- `docs/README.md`

추가:

- `scripts/reproduce-backup-metadata-loss.mjs`
- `tests/backup-metadata-integrity.node.test.mjs`
- `docs/data-loss-audit-2026-07-30-backup-restore-metadata-ko.md`
- 관련 `audit-logs/` 검증 로그

## 10. 웹 교차검증에 사용한 공식 자료

- MariaDB JSON Data Type / JSON_VALID: JSON 문법 검증과 application-level 구조 검증은 별개의 계층임
- MariaDB Transactions / START TRANSACTION / COMMIT / ROLLBACK: 복원 교체의 원자성 기준
- Yjs Document Updates: update의 commutative, associative, idempotent 성질과 durable update log 검토 기준
- MDN IndexedDB durability: 브라우저 로컬 복구를 영구 서버 저장과 동일하게 간주하지 않아야 하는 기준
