# BrainVault 데이터 손실 무결성 심층 감사 및 수정 보고서

감사일: 2026-07-28 (Asia/Seoul)

## 결론

업로드된 프로젝트에는 문서 세대 격리, 브라우저 복구, 파괴적 작업 잠금, 서버 권위 Yjs 재물질화와 관련된 8개 치명적 데이터 손실 취약점의 수정이 이미 포함되어 있었다. 해당 방어를 코드 경로와 재현 스크립트로 다시 검증하는 과정에서, 별도의 **9번째 치명적 취약점**을 확인하고 수정했다.

새 취약점은 동일 페이지를 서로 다른 애플리케이션 프로세스가 각각 메모리에 로드할 때 발생한다. 프로세스 B가 프로세스 A의 최신 Yjs 업데이트를 받지 못한 상태에서도 일반 업데이트를 DB에 추가할 수 있었고, 그 결과 B의 불완전한 문서가 숫자상 최신 업데이트 ID를 갖게 되었다. 이후 B가 전체 상태 스냅샷을 저장하면 기존 검사에 통과하면서 A의 편집이 포함된 과거 업데이트 행을 삭제할 수 있었다.

심각도: **Critical**

## 재현된 영구 손실 순서

1. 프로세스 A와 B가 같은 페이지의 durable tip `0`을 각각 로드한다.
2. A가 `edit-A`를 반영하고 DB 업데이트 `1`을 커밋한다.
3. 프로세스 로컬 fan-out 때문에 B는 `edit-A`를 받지 못한다.
4. 기존 서버는 일반 업데이트에 durable-tip 검사를 하지 않아, B의 `edit-B`를 업데이트 `2`로 커밋한다.
5. DB의 증분 이력에는 일시적으로 A와 B가 모두 있지만, B의 메모리 문서에는 B만 있고 `maxUpdateId`는 `2`가 된다.
6. B가 base ID `2`로 전체 상태 스냅샷을 보내면 기존 snapshot-only 검사를 통과한다.
7. 서버는 B만 포함한 스냅샷을 새 행으로 저장한 뒤 이전 행들을 삭제한다.
8. `edit-A`가 durable history에서 영구 삭제된다.

의존성 없는 결정론적 재현 결과:

```json
{
  "baselineCommit": "741dcc1a650e253f4556948a94a233f6fe1bf60e",
  "vulnerable": {
    "durableBeforeCompaction": ["edit-A", "edit-B"],
    "processBRoomContainsEditA": false,
    "staleSnapshotAccepted": true,
    "durableAfterCompaction": ["edit-B"],
    "permanentLossWindowReproduced": true
  },
  "fixed": {
    "staleNormalWriteRejected": true,
    "staleRoomInvalidated": true,
    "retryAfterReloadAccepted": true,
    "durableAfterCompaction": ["edit-A", "edit-B"],
    "permanentLossWindowClosed": true
  }
}
```

## 근본 원인

Yjs 업데이트는 전달되어 적용된 업데이트 집합에 대해서는 순서와 중복에 무관하게 병합될 수 있다. 그러나 프로세스 B의 문서에는 A의 업데이트 자체가 전달되지 않았다. 기존 구현은 스냅샷에 대해서만 DB의 최신 ID를 확인했고, 일반 업데이트에는 `room.maxUpdateId`와 durable tip의 동일성을 확인하지 않았다.

따라서 다음 불변식이 깨졌다.

> 숫자상 최신인 room은 최신 durable update를 모두 적용한 Yjs 문서여야 한다.

일반 stale 쓰기가 먼저 허용되면서 불완전한 room이 최신 숫자 ID를 획득했고, 이후 전체 상태 압축이 누락된 상태를 유일한 durable history로 만들었다.

## 적용한 수정

### 모든 WebSocket 쓰기에 durable-room freshness fence 적용

`src/lib/collaboration-protocol.ts`에 `assessCollaborationWriteCheckpoint()`를 추가했다.

- 일반 업데이트와 스냅샷 모두 `roomUpdateId === durableUpdateId`일 때만 허용한다.
- 스냅샷은 추가로 `snapshotBaseUpdateId === durableUpdateId`여야 한다.
- stale room과 stale snapshot base를 서로 다른 거부 사유로 구분한다.

### DB 반영 전 fail-closed 처리

`src/lib/collaboration-server.ts`에서 모든 업데이트 트랜잭션이 다음 순서를 따른다.

1. 페이지 행을 `FOR UPDATE`로 잠근다.
2. collaboration state 행을 잠그고 `documentEpoch`를 재검증한다.
3. DB의 현재 `MAX(page_yjs_updates.id)`를 읽는다.
4. room의 `maxUpdateId`와 durable tip을 비교한다.
5. 불일치하면 INSERT와 과거 이력 DELETE를 모두 수행하지 않는다.
6. candidate Yjs 문서를 폐기하고 해당 프로세스의 room 전체를 무효화한다.
7. 연결을 `1011`로 닫아 durable history를 새로 로드하게 한다.

거부된 로컬 편집은 기존 브라우저 recovery 사본과 클라이언트 Yjs 문서에 남는다. 재접속 시 durable history를 적용한 뒤 미확인 전체 상태를 다시 전송하므로, A와 B 편집이 모두 포함된 상태로 재시도된다.

### 재현 도구와 회귀 방지

- `scripts/reproduce-cross-instance-compaction-loss.mjs` 추가
- `tests/collaboration-write-checkpoint.test.ts` 추가
- `scripts/verify-collaboration.mjs`에 checkpoint와 재현 실행 추가
- `scripts/verify-data-loss-guards.mjs`에 source wiring 및 재현 검증 추가
- 기존 materialization 재현기가 현재 `HEAD`를 취약 기준으로 잘못 가정하던 문제를 수정하고, 보존된 Git 이력에서 실제 취약 리비전을 자동 탐색하도록 변경

## 기존 8개 치명적 방어 재검증 범위

1. 페이지 ID를 재사용하는 Yjs 문서 교체에서 구세대 offline recovery가 신세대 문서로 합쳐지는 문제
2. 다른 탭의 durable direct draft가 남은 상태에서 삭제·아카이브·복원이 진행되는 문제
3. 복구 저장소 검사 실패를 안전한 빈 상태로 해석하는 fail-open 문제
4. 복구 탭이 원본 탭의 storage source key를 계속 사용해 원본 복구본을 덮어쓰는 문제
5. 부분 손상된 recovery record를 일부만 파싱한 뒤 축약 상태로 덮어쓰는 문제와 empty-string 존재성 오류
6. 비원자적 `localStorage` lease를 Web Lock과 동일한 배타 잠금으로 취급한 문제
7. authoritative Web Lock이 유지되는 동안 만료 lease가 삭제되어 편집이 다시 열리는 문제
8. 최신 Yjs update ID가 브라우저가 별도로 보낸 title/block 내용까지 인증한다고 잘못 가정한 문제

문서/블록 삭제 및 재정렬, save coalescing, attachment claim/fsync/commit ambiguity, export/restore fingerprint와 generation journal, collaboration materialization 및 destructive checkpoint 경로도 추가 검토했다. 이번 검토에서 위 9개 외의 새로운 치명적 결함은 확인되지 않았다. 이는 코드 감사 결론이며, 실행하지 못한 실제 MariaDB/브라우저 통합시험을 대체하지는 않는다.

## 실행 검증

다음 명령은 최종 작업 트리에서 성공했다.

```text
npm run lockfile:check
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.

npm run reproduce:materialization-loss
vulnerable.permanentLossWindowReproduced=true
fixed.legacyCheckpointRequiresRematerialization=true
fixed.permanentLossWindowClosed=true

npm run reproduce:cross-instance-loss
vulnerable.permanentLossWindowReproduced=true
fixed.staleNormalWriteRejected=true
fixed.staleRoomInvalidated=true
fixed.permanentLossWindowClosed=true

npm run verify:collaboration
[verify-collaboration] OK ... syntax for 131 file(s).

npm run verify:data-loss
[verify-data-loss-guards] OK ... cross-instance durable-room freshness fencing ...
```

## 실행하지 못한 검증

깨끗한 `npm ci --no-audit --no-fund`를 재시도했으나, 실행 환경의 패키지 게이트웨이가 기존 lockfile 의존성 `zod-3.25.76.tgz` 요청에 HTTP 503을 반환했다. 로컬 캐시에도 해당 tarball이 없어 다음 항목은 이 환경에서 실행하지 못했다.

- `npm run build`
- 전체 Vitest suite
- 실제 MariaDB 기반 통합시험

의존성 버전과 `package-lock.json`은 변경하지 않았다. 정상 npm registry와 MariaDB가 있는 환경에서 배포 전 다음을 실행해야 한다.

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## 배포 안전 조건

- 구버전 프로세스와 수정 프로세스를 rolling 방식으로 겹쳐 실행하지 않는다.
- **모든 구버전 collaboration writer를 먼저 drain/stop한 뒤 수정본을 시작한다.** 구버전 프로세스에는 새 freshness fence가 없다.
- 수정된 프로세스끼리 우발적으로 겹치면 stale room 쓰기는 fail-closed로 차단되지만, fan-out 자체는 여전히 프로세스 로컬이다. 정상 운영은 단일 active process를 유지한다.
- 수평 확장이 필요하면 shared pub/sub와 분산 room/update coordination을 추가해야 한다.
- 이미 취약 압축으로 삭제된 과거 업데이트는 DB만으로 복원할 수 없다. 과거에 다중 인스턴스가 겹쳤다면 백업과 브라우저 recovery 데이터를 보존·점검한다. 정상 스냅샷과 누락 스냅샷은 모두 유효한 Yjs 전체 업데이트가 될 수 있어, 삭제 이후에는 신뢰할 수 있는 DB-only 판별 표지가 없다.
- 기존 문서 세대 및 materialization 수정에 필요한 migration 021, 022를 애플리케이션 제공 전에 적용한다.
- 구버전 브라우저 탭은 새로고침하되, browser recovery storage는 삭제하지 않는다.

## `.git` 보존 검증

업로드 직후 `.git` 아래 모든 일반 파일 28개의 상대 경로와 SHA-256을 기록했고, 수정 후 동일 목록을 다시 계산했다.

- 사전 manifest SHA-256: `77863f731549a0c87c9df7bf7e2d4ee2e4e2b997aa2454950777e78932d74584`
- 수정 후 manifest: byte-for-byte 일치
- `.git` 삭제, 초기화, 커밋, index 변경 없음

제공 압축본 후보를 별도 경로에 안전하게 재추출한 뒤 전체 209개 파일과 30개 디렉터리의 바이트 manifest가 작업 트리와 일치함을 확인했다. 재추출된 `.git`도 업로드 직후 manifest와 일치했고, 두 재현 명령과 두 무의존 검증 명령을 재추출본에서 다시 실행해 모두 통과했다.
