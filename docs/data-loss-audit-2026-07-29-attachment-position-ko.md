# BrainVault 데이터 손실 무결성 후속 심층 감사 및 수정 보고서

감사일: 2026-07-29 (Asia/Seoul)  
대상: 업로드된 `BrainVault.zip` 전체 소스, 보존된 Git 메타데이터, 협업·복원·첨부파일 내구성 경로  
후속 감사 성격: 2026-07-29 브라우저 recovery-write 감사 이후의 독립 재검토

## 1. 최종 결론

기존 업로드본은 앞선 감사에서 확인된 10개 치명적 데이터 손실 방어를 포함하고 있었고, 해당 재현기와 정적 가드는 다시 통과했다. 그러나 협업 첨부 블록의 위치를 재접속 때 보정하는 경로에서 독립적인 **11번째 Critical 무결성 취약점**을 추가로 확인했다.

취약 버전에서는 사용자가 첨부 블록을 다른 부모 또는 순서로 이동하고 서버의 Yjs ACK까지 받은 뒤, 관계형 materialization 전에 재접속하면 다음 일이 가능했다.

1. durable Yjs 로그에는 새 위치가 존재한다.
2. `blocks` SQL 행에는 아직 이전 위치가 남아 있다.
3. 재접속 HTTP 응답이 이전 SQL 위치를 보낸다.
4. WebSocket은 durable Yjs 로그를 재생해 새 위치를 복원한다.
5. 클라이언트의 attachment reconciliation이 그 새 위치를 오래된 SQL `parentBlockId`와 `sortOrder`로 다시 덮는다.
6. 이 덮어쓰기가 새로운 로컬 Yjs 업데이트로 서버에 저장·ACK된다.
7. 다음 materialization이 오래된 위치를 SQL에 다시 기록한다.

결과적으로 이미 서버가 수락하고 ACK한 사용자의 첨부 이동/계층/정렬 편집이 재접속 때문에 영구적으로 사라질 수 있었다. 첨부 파일 바이트 자체는 남지만, 사용자가 확정한 문서 구조 데이터가 손실된다.

이번 수정은 다음 권위 규칙을 강제한다.

> 서버 SQL은 첨부 파일의 불변 내용과 파일 메타데이터에 권위가 있고, 이미 Yjs 문서에 존재하는 첨부의 가변 위치는 durable Yjs 상태가 권위가 있다.

심각도: **Critical**

## 2. 취약 코드 경로

문제의 중심은 `public/collaboration.js`의 `reconcileServerAttachments()`였다.

재접속 시 서버는 두 경로로 서로 다른 시점의 상태를 전달한다.

- HTTP collaboration session: 현재 관계형 `blocks` 스냅샷
- WebSocket history: durable `page_yjs_updates` 로그

관계형 스냅샷은 Yjs materialization 주기 때문에 정상적으로 뒤처질 수 있다. 하지만 취약 구현은 서버에서 받은 attachment candidate의 모든 필드를 기존 Yjs map에 적용했다.

```text
canonical SQL attachment
  ├─ immutable content/metadata   ← 서버 권위로 덮어써도 안전
  └─ parentBlockId/sortOrder      ← materialization 전에는 오래될 수 있음
```

`sync-complete` 처리에서 durable Yjs history가 먼저 적용된 뒤 `mergeCanonicalAttachments()`가 호출되므로, 오래된 SQL 위치가 최신 Yjs 위치 위에 새 로컬 변경으로 기록되었다. 같은 문제가 지연된 `canonical-attachment` 메시지가 이미 이동된 attachment에 도착하는 경우에도 발생할 수 있었다.

## 3. 재현 가능한 영구 손실 순서

결정론적 재현기는 다음 상태를 사용한다.

```text
ACK된 durable Yjs 위치
parentBlockId = section_after
sortOrder     = 1

아직 materialize되지 않은 SQL 위치
parentBlockId = section_before
sortOrder     = 7
```

취약 병합 결과:

```json
{
  "reconnectPublishedLocation": {
    "parentBlockId": "section_before",
    "sortOrder": 7
  },
  "staleSqlLocationRepublishedAsNewYjsUpdate": true,
  "acknowledgedMoveSurvived": false,
  "permanentLossWindowReproduced": true
}
```

수정 병합 결과:

```json
{
  "reconnectPublishedLocation": {
    "parentBlockId": "section_after",
    "sortOrder": 1
  },
  "acknowledgedMoveSurvived": true,
  "canonicalImmutableContentPreserved": true,
  "missingAttachmentUsesSqlLocation": true,
  "permanentLossWindowClosed": true
}
```

실행 명령:

```bash
npm run reproduce:attachment-position-loss
```

재현기는 외부 패키지, 브라우저, MariaDB 없이 취약 병합과 수정 병합을 같은 입력으로 실행한다.

## 4. 근본 원인

근본 원인은 **eventually materialized view를 최신 협업 권위 상태로 잘못 사용한 것**이다.

Yjs update는 서버 ACK 시 `page_yjs_updates`에 영구 저장된다. 반면 일반 REST 읽기·검색·백업을 위한 `pages`/`blocks` materialization은 지연될 수 있다. 따라서 두 저장소가 잠시 다를 때 다음처럼 필드별 권위를 구분해야 한다.

| 데이터 | 권위 저장소 | 이유 |
| --- | --- | --- |
| attachment ID/type | SQL + 검증된 Yjs identity | 파일 행과의 연결 및 타입 불변성 |
| 파일명, MIME, 크기 metadata | SQL | 업로드 endpoint가 생성한 서버 권위 값 |
| attachment 삭제 | Yjs tombstone | 협업 삭제 의도 및 materialization 입력 |
| 이미 존재하는 attachment의 부모/순서 | durable Yjs | ACK된 최신 협업 편집 |
| Yjs에 아직 없는 신규 attachment의 부모/순서 | SQL | 업로드 직후 canonical adoption bootstrap |

기존 구현은 마지막 두 경우를 구분하지 않고 항상 SQL 위치를 사용했다.

## 5. 적용한 수정

### 5.1 필드별 권위 병합 모듈

신규 파일 `public/collaboration-attachment-reconcile.js`에 순수 함수 `reconcileCanonicalAttachment()`를 추가했다.

- 기존 Yjs attachment가 있으면 `parentBlockId`와 `sortOrder`를 보존한다.
- Yjs에 attachment가 실제로 없을 때만 SQL 위치를 채택한다.
- type, markdown, checked, attachment metadata는 canonical SQL 값을 유지한다.
- 현재 Yjs 부모가 삭제되었거나 존재하지 않으면 오래된 SQL 부모로 되돌아가지 않고 root(`null`)로 실패 폐쇄한다.
- self-parent와 유효하지 않은 sort 값도 정규화한다.

### 5.2 tombstone-aware active ID 계산

`reconcileServerAttachments()`가 사용할 parent 후보 집합에서 attachment tombstone ID를 제외했다. 삭제된 블록을 유효한 부모로 간주해 구조를 되살리는 경로를 막았다.

### 5.3 재접속과 canonical broadcast에 동일 규칙 적용

- 재접속의 `mergeCanonicalAttachments()`
- 업로드 이후 `canonical-attachment` WebSocket 알림
- 화면 전환 중 HTTP 업로드 응답을 adoption하는 경로

모두 동일한 reconciliation 규칙을 사용하도록 `adoptAttachment()`를 변경했다.

### 5.4 구버전 writer 차단

수정 서버와 캐시된 취약 브라우저가 혼재하면 구버전 탭이 다시 stale SQL 위치를 발행할 수 있다. 이를 막기 위해 양방향 호환성 fence를 추가했다.

- collaboration session body: `documentEpochProtocol: 2`
- WebSocket subprotocol: `brainvault-yjs-v2`

새 서버는 protocol 1 클라이언트의 session 발급을 `COLLABORATION_CLIENT_REFRESH_REQUIRED`로 거부한다. 또한 배포 전 발급된 구버전 ticket이 rolling restart 직후 새 서버에 도달하더라도 WebSocket subprotocol 불일치로 upgrade가 거부된다. 새 클라이언트도 구버전 서버와 연결되지 않는다.

## 6. 회귀 테스트

신규 Node 기본 테스트 4개를 추가했다.

1. 기존 attachment는 Yjs 위치를 유지하고 canonical 내용/metadata를 사용한다.
2. Yjs에 없는 신규 attachment는 SQL 위치를 채택한다.
3. 현재 Yjs 부모가 사라졌을 때 stale SQL 부모로 fallback하지 않는다.
4. self-parent와 비정상 sort 값을 fail-closed 정규화한다.

기존 browser recovery durability 테스트 5개와 함께 실행된다.

```text
npm run test:durability
tests: 9
pass: 9
fail: 0
```

## 7. 정적·상태기계 검증 연결

### `npm run verify:collaboration`

검증 항목에 다음을 추가했다.

- collaboration client가 순수 reconciliation helper를 import하는지
- 기존 Yjs map을 먼저 읽는지
- tombstone을 active parent 집합에서 제외하는지
- `brainvault-yjs-v2`가 서버 upgrade protocol인지
- 취약/수정 재현 결과가 모두 기대값인지
- 전체 실행 가능한 JavaScript/TypeScript 구문 검사

최종 결과:

```text
[verify-collaboration] OK ... stale-SQL attachment-position fencing ... syntax for 137 file(s).
```

### `npm run verify:data-loss`

검증 항목에 다음을 추가했다.

- SQL attachment 위치를 무조건 재적용하는 구식 경로가 제거됐는지
- Yjs 위치와 SQL canonical content의 필드별 권위가 유지되는지
- attachment 위치 손실 재현기가 취약/수정 상태를 모두 입증하는지

최종 결과:

```text
[verify-data-loss-guards] OK ... stale-SQL attachment-position fencing ...
```

## 8. 기존 손실 방어 재검증

다음 기존 재현기를 수정 후 다시 실행했다.

```text
npm run reproduce:materialization-loss
vulnerable.permanentLossWindowReproduced=true
fixed.legacyCheckpointRequiresRematerialization=true
fixed.permanentLossWindowClosed=true

npm run reproduce:cross-instance-loss
vulnerable.permanentLossWindowReproduced=true
fixed.staleNormalWriteRejected=true
fixed.staleRoomInvalidated=true
fixed.permanentLossWindowClosed=true

npm run reproduce:recovery-write-loss
vulnerable.permanentLossWindowReproduced=true
fixed.storageFailure.rejectedWithDurabilityError=true
fixed.storageFailure.unprotectedEditBecameVisible=false
fixed.permanentLossWindowClosed=true
```

또한 다음 경로를 수동 재추적했다.

- Yjs update 저장, ACK, broadcast, reconnect recovery, compaction
- 서버 권위 materialization과 destructive checkpoint
- 페이지/블록 삭제 및 정확한 version snapshot
- 공유 시작/종료와 document epoch 교체
- attachment claim, fsync, DB commit ambiguity, 삭제 후 파일 정리
- 전체 ZIP export/restore fingerprint, journal, generation marker, crash recovery
- 다중 탭 Web Locks, durable lease, storage enumeration failure
- page/tag/share 변경이 restore fingerprint에 반영되는 경로

이번 후속 감사에서 11번째 문제 외에 추가적인 미수정 Critical 데이터 손실 경로는 확인되지 않았다. 이는 아래 실행 제한을 포함한 소스·상태기계 감사 결론이다.

## 9. 의존성 설치 및 통합시험 한계

실행 환경이 강제로 주입한 npm registry는 기존 lockfile의 `zod-3.25.76.tgz`를 제공하지 못했고, public registry override 설치도 완료되지 않았다. 따라서 깨끗한 dependency install이 필요한 다음 항목은 이 환경에서 실행하지 못했다.

- `npm run build`
- 전체 Vitest suite
- 실제 MariaDB 기반 integration/e2e 시험
- 실제 브라우저 다중 탭 및 WebSocket 재접속 시험

`package-lock.json`과 의존성 버전은 변경하지 않았다. 정상 registry와 MariaDB가 있는 배포 환경에서 다음을 추가 실행해야 한다.

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

이번 핵심 수정은 외부 의존성이 없는 순수 모듈로 분리했고, Node 기본 테스트, 결정론적 재현, 전체 source wiring 및 구문 검사로 직접 검증했다.

## 10. 배포 안전 조건

1. 모든 구버전 BrainVault 애플리케이션 writer를 drain/stop한다.
2. 수정본을 배포하고 서버 프로세스를 재시작해 기존 WebSocket을 종료한다.
3. 사용자에게 모든 열린 BrainVault 탭을 새로고침하게 한다.
4. 브라우저의 BrainVault recovery/localStorage를 삭제하지 않는다.
5. protocol 1 session 오류는 의도된 fail-closed 동작이므로 새로고침으로 protocol 2 client를 로드한다.
6. 다중 인스턴스 운영 시 기존 문서의 권고대로 shared pub/sub와 분산 room coordination을 사용한다.
7. 배포 전 정상 환경에서 전체 build/Vitest/MariaDB 검증을 실행한다.

## 11. 변경 파일

신규:

- `public/collaboration-attachment-reconcile.js`
- `scripts/reproduce-attachment-position-loss.mjs`
- `tests/collaboration-attachment-reconcile.node.test.mjs`
- `docs/data-loss-audit-2026-07-29-attachment-position-ko.md`

주요 변경:

- `public/collaboration.js`
- `src/routes/collaboration.routes.ts`
- `src/lib/collaboration-server.ts`
- `scripts/verify-collaboration.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- collaboration/API/OpenAPI/verification 문서와 관련 테스트

삭제된 파일은 없다. `package-lock.json`은 변경하지 않았다.

## 12. `.git` 보존

업로드 ZIP 내부 `.git`을 권위 원본으로 사용해 경로, 크기, SHA-256을 파일별로 비교했다.

- `.git` 일반 파일: `28`
- 업로드 원본 `.git` manifest SHA-256: `def4035c5d75c673656e4d3e836d921e07a7374a011eebf460a366f22a7d26c4`
- `.git` 디렉터리 삭제, 재초기화, 커밋: 없음
- 최종 패키징 전에 ZIP 원본 바이트를 동일 경로에 재확인하고, 패키지 재추출본에서도 byte-for-byte 검증한다.

## 13. 최종 판정

재현된 attachment 위치 영구 손실 창은 수정본에서 닫혔다.

- ACK된 Yjs 위치를 stale SQL snapshot이 덮지 않는다.
- 서버 권위 attachment 내용/metadata는 계속 보존된다.
- 신규 SQL attachment는 Yjs에 없을 때만 채택된다.
- tombstone/invalid parent는 fail-closed 처리된다.
- 구버전 HTTP/WebSocket writer는 protocol fence로 차단된다.
- 기존 10개 데이터 손실 방어와 신규 11번째 방어의 무의존 검증이 통과한다.

전체 의존성·실브라우저·MariaDB 통합시험은 9절의 환경 제한으로 미실행이므로 운영 배포 전 반드시 추가해야 한다.
