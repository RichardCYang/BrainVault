# BrainVault 데이터 손실 무결성 심층 감사 및 수정 보고서

감사일: 2026-07-29 (Asia/Seoul)  
감사 대상 기준 커밋: `3b2cc823a20e092ecb4258d93347d9232c48f072`  
대상: 업로드된 `BrainVault.zip` 전체 소스와 보존된 Git 메타데이터

## 1. 최종 결론

업로드본에는 2026-07-28 감사에서 확인된 9개 치명적 데이터 손실 방어가 이미 포함되어 있었다. 이번 감사에서는 해당 방어의 연결 상태와 재현 스크립트를 다시 검증하고, 브라우저 저장 실패 경계에서 독립적인 **10번째 치명적 무결성 취약점**을 재현했다.

취약 구현은 사용자의 편집을 화면 또는 라이브 Yjs 문서에 먼저 반영한 뒤 브라우저 복구 저장소에 기록했다. `localStorage.setItem()`이 저장공간 부족, 사이트 저장 비활성화, 손상된 기존 레코드 보호 등의 이유로 실패해도 그 반환값이 편집의 커밋 조건으로 사용되지 않았다. 이 상태에서 네트워크 연결이 서버의 영구 저장 확인 전에 끊기고 탭 또는 렌더러가 종료되면, 최신 편집은 서버에도 브라우저에도 존재하지 않아 영구 소실될 수 있었다.

심각도: **Critical**

이번 수정은 다음 불변식을 강제한다.

> 사용자에게 보이거나 서버로 전송 가능한 편집은, 그 편집을 포함한 브라우저 복구 사본이 먼저 내구화되었거나 서버가 이미 영구 저장을 확인한 경우에만 존재해야 한다.

협업 편집은 별도의 Yjs 스테이징 문서에서 후보 상태를 만들고, 전체 문서 복구 스냅샷 저장 성공을 확인한 뒤에만 라이브 문서에 증분 업데이트를 적용하도록 변경했다. 일반 제목·블록 편집은 직접 초안 저장에 실패하면 네트워크 전송을 시작하지 않고 마지막 내구 상태로 화면을 복원한다. 저장 실패로 거부된 블록을 이전 자동저장 타이머가 뒤늦게 전송하는 2차 경로도 함께 차단했다.

## 2. 감사 범위와 방법

다음 경로를 중심으로 데이터가 생성되고, 내구화되고, 삭제되는 순서를 추적했다.

- 브라우저 직접 초안: 페이지 제목, 블록 내용, 블록 순서
- 브라우저 Yjs 복구 스냅샷과 WebSocket ACK 처리
- Yjs 증분 업데이트, 스냅샷 압축, 관계형 materialization
- 페이지/블록 삭제, 아카이브, 공유 전환, 전체 복원
- 첨부파일 claim, fsync, DB commit 이후 정리
- 다중 탭 Web Locks와 전파 lease
- 다중 애플리케이션 인스턴스의 durable-room freshness
- 복구 레코드 손상, 문서 세대, source ID 격리

검증 방법은 다음을 결합했다.

1. 저장·전송·ACK·삭제 순서에 대한 소스 수준 상태기계 감사
2. 취약 순서와 수정 순서를 함께 출력하는 무의존 결정론적 재현기
3. 내구화 선행 조건을 검증하는 Node 기본 테스트 러너 회귀 테스트
4. 기존 materialization 및 cross-instance compaction 손실 재현의 재실행
5. 전체 JavaScript/TypeScript 소스 wiring 및 구문 검증
6. 원본 ZIP과 수정 작업 트리의 바이트 비교
7. 원본 `.git` 파일별 SHA-256 manifest 보존 검증

## 3. 10번째 치명적 취약점: 복구 저장 실패 후 편집 선반영

### 3.1 협업 편집의 취약 순서

기존 `public/collaboration.js`의 로컬 업데이트 순서는 다음과 같았다.

1. `setTitle()`, `upsertBlock()` 등의 호출이 라이브 Yjs 문서를 즉시 변경한다.
2. Yjs `update` 이벤트가 발생해 화면 상태와 애플리케이션 메모리가 최신 편집을 반영한다.
3. 이벤트 처리기가 전체 문서를 브라우저 복구 저장소에 기록한다.
4. 저장 결과가 `false`여도 라이브 변경은 유지된다.
5. WebSocket이 동기화 상태이면 증분 업데이트 전송을 시도한다.

이 순서에서는 3번이 실패한 뒤 5번이 서버 ACK 전에 실패하거나 연결이 끊기면, 최신 편집의 유일한 사본은 현재 탭의 휘발성 메모리뿐이다.

### 3.2 일반 제목·블록 편집의 유사 경로

직접 저장 모드에서도 DOM 입력이 먼저 바뀐 뒤 `persistPageTitleDraft()` 또는 `persistBlockDraft()`가 호출되었다. 이전 구현은 일부 핵심 호출부에서 `false`를 무시하고 상태 갱신, 자동저장 예약 또는 API 저장 경로를 계속 진행했다.

다음 조합에서 동일한 영구 손실 창이 생겼다.

1. 사용자가 제목 또는 블록을 편집한다.
2. 로컬 초안 저장이 실패한다.
3. 서버 요청이 전송되지 않거나, 커밋 전에 연결이 끊긴다.
4. 탭/브라우저/렌더러가 종료된다.
5. 재접속 시 서버의 이전 값만 복원된다.

### 3.3 영구 손실 재현 조건

모든 조건이 동시에 필요하지만 현실적인 장애 조합이다.

- 브라우저 저장 쓰기 실패
  - quota 초과
  - 사이트 저장 비활성화
  - 브라우저 정책 또는 저장소 오류
  - 애플리케이션이 보존해야 하는 unreadable 기존 레코드와의 충돌
- 서버의 durable ACK 이전 네트워크 단절 또는 전송 실패
- 그 뒤 탭/프로세스 종료 또는 페이지 재로드

브라우저 Web Storage 표준은 새 값을 저장할 수 없으면 `QuotaExceededError`가 발생할 수 있고, 사용자가 저장을 비활성화한 경우도 명시적인 실패 사유로 설명한다. 따라서 복구 쓰기 실패는 이론적 가정이 아니라 정상 API 계약 안의 상태다.

## 4. 결정론적 재현 결과

추가한 명령:

```bash
npm run reproduce:recovery-write-loss
```

취약 상태 모델의 핵심 결과:

```json
{
  "liveBeforeCrash": "critical edit",
  "serverBeforeCrash": "before edit",
  "recoveryWriteSucceeded": false,
  "reloaded": "before edit",
  "permanentLossWindowReproduced": true
}
```

수정 상태에서 저장 실패를 주입한 결과:

```json
{
  "rejectedWithDurabilityError": true,
  "liveAfterRejectedEdit": "before edit",
  "serverAfterRejectedEdit": "before edit",
  "unprotectedEditBecameVisible": false,
  "permanentLossWindowClosed": true
}
```

정상 저장·ACK 경로에서 검증한 순서:

```text
persist-full-recovery
→ apply-live-update
→ server-commit-and-ack
→ clear-recovery
```

즉, 저장 실패 시 보호되지 않은 편집이 라이브 문서에 나타나지 않고, 성공 시에는 전체 복구 사본이 라이브 노출보다 먼저 존재한다.

## 5. 근본 원인

근본 원인은 복구 저장 결과를 단순 경고 신호로만 취급하고 편집 커밋의 선행조건으로 사용하지 않은 것이다.

Yjs 업데이트는 전달된 업데이트 집합에 대해서는 순서와 중복에 강하게 병합된다. 그러나 브라우저 저장에도 서버 durable history에도 들어가지 못한 업데이트는 CRDT 특성으로 복구할 수 없다. 이번 문제는 병합 충돌이 아니라 **모든 내구 저장소에서 업데이트 자체가 빠지는 문제**다.

기존 구현이 위반한 상태 불변식은 다음과 같다.

```text
visible(edit) OR publishable(edit)
    ⇒ durable_browser_recovery(edit) OR durable_server_ack(edit)
```

수정 후에는 신규 편집에 대해 다음 순서가 강제된다.

```text
prepare candidate
→ persist full recovery candidate
→ expose to live document/DOM
→ transmit
→ retain recovery until all local writes are ACKed
→ clear recovery
```

## 6. 적용한 수정

### 6.1 Yjs 스테이징 문서 도입

`public/collaboration.js`에 라이브 문서와 분리된 `localMutationDoc`을 추가했다.

- 각 로컬 편집 전에 라이브 문서에서 스테이징 문서에 빠진 상태만 동기화한다.
- 제목/블록 추가·변경·삭제는 스테이징 문서 안에서 먼저 수행한다.
- 편집 후 스테이징 문서 전체를 복구 후보로 인코딩한다.
- 같은 트랜잭션에서 발생한 증분 업데이트를 라이브 적용 후보로 보관한다.
- mutator 또는 인코딩이 실패하면 스테이징 문서를 폐기해 부분 변경이 다음 편집으로 누출되지 않게 한다.

### 6.2 내구화 선행 커밋 게이트

새 파일 `public/collaboration-durability.js`에 `commitPreparedCollaborationMutation()`을 추가했다.

이 함수는 다음을 보장한다.

1. 전체 복구 후보와 라이브 증분 업데이트가 비어 있지 않은지 검증한다.
2. 전체 복구 후보를 저장한다.
3. 비어 있지 않은 recovery generation을 받은 경우에만 라이브 업데이트를 적용한다.
4. 저장 실패는 `COLLABORATION_RECOVERY_WRITE_FAILED` 코드가 있는 전용 오류로 변환한다.
5. 라이브 적용이 예외를 내더라도 복구 사본은 이미 저장된 상태다.

라이브 문서에는 `PREPARED_LOCAL_ORIGIN`으로 적용해, 이미 선행 저장한 업데이트를 이벤트 처리기가 다시 “적용 후 저장” 순서로 처리하지 않도록 했다.

### 6.3 예상치 못한 라이브 적용 실패 처리

복구 저장 성공 후 라이브 Yjs 적용이 실패하는 비정상 상황에서는 다음을 수행한다.

- 내구 복구 사본을 삭제하지 않는다.
- 스테이징 문서를 폐기한다.
- 세션을 `needsRecovery` 상태로 전환한다.
- ready/synced 상태를 해제한다.
- WebSocket을 닫고 다음 연결에서 durable recovery를 다시 적용하게 한다.

따라서 저장과 라이브 적용 사이의 예외도 데이터 손실이 아닌 재동기화로 수렴한다.

### 6.4 일반 제목·블록 편집 fail-closed

`public/app.js`의 직접 초안 경로를 다음과 같이 변경했다.

- 제목 초안 저장 성공 전에는 페이지 요약 상태와 문서 트리를 새 제목으로 게시하지 않는다.
- 제목 저장 실패 시 revision을 되돌리고 마지막 내구 제목으로 입력값을 복원한다.
- 블록 초안 저장 실패 시 서버 요청과 자동저장을 예약하지 않는다.
- 실패한 DOM 행을 서버 상태 또는 직전 내구 초안으로 다시 렌더링한다.
- 충돌 초안을 현재 탭 source로 승격할 때도 새 사본 저장이 실패하면 승격 상태를 되돌린다.
- 협업 세션의 내구화 오류는 같은 로컬 저장 실패 메시지로 사용자에게 표시한다.

### 6.5 선반영 메모리 상태 제거

다음 편집은 저장 성공 전 애플리케이션 상태 객체를 직접 바꾸지 않도록 수정했다.

- callout 유형
- 텍스트 정렬 metadata
- 협업 블록 드래그 재정렬

metadata는 렌더된 행의 dataset/컨트롤에서 후보 payload를 구성하고, 내구 저장 또는 협업 커밋 성공 후 스냅샷을 통해 상태에 반영한다. 협업 재정렬이 실패하면 기존 순서로 상태를 복원하고 다시 렌더링한다.

### 6.6 거부된 편집의 지연 전송 차단

저장 실패 후 DOM 행을 교체해도, 이전 입력 행을 캡처한 자동저장 타이머가 남아 있으면 저장소가 회복된 뒤 사용자가 이미 거부된 편집을 서버에 전송할 수 있었다.

이를 막기 위해 durable 상태 복원 시 해당 block ID의 다음 항목을 즉시 제거한다.

- `blockSaveTimers`
- `blockSaveRows`
- 예약된 timeout

이미 서버로 전송 중인 이전의 내구 편집은 취소하지 않는다. 거부된 최신 DOM 변경만 지연 전송할 수 없게 한다.

## 7. 추가/변경 파일

- `public/collaboration-durability.js` — 신규 내구화 선행 커밋 게이트
- `public/collaboration.js` — Yjs 스테이징 및 fail-closed 적용
- `public/app.js` — 직접 초안 실패 롤백, 선반영 제거, stale timer 차단
- `scripts/reproduce-collaboration-recovery-write-loss.mjs` — 취약/수정 상태 재현기
- `tests/collaboration-durability.node.test.mjs` — 무의존 회귀 테스트 5개
- `scripts/verify-data-loss-guards.mjs` — 정적 불변식과 재현 실행 연결
- `package.json` — 재현 및 테스트 명령 추가
- `docs/data-loss-audit-2026-07-29-ko.md` — 본 보고서
- `docs/README.md` — 새 감사 보고서 링크

`package-lock.json`과 의존성 버전은 변경하지 않았다.

## 8. 회귀 테스트 및 실행 결과

### 8.1 신규 단위 테스트

명령:

```bash
npm run test:durability
```

결과:

```text
tests 5
pass 5
fail 0
```

검증 항목:

1. recovery save가 `null`이면 라이브 적용 금지
2. 저장소 예외를 원인으로 보존하고 라이브 적용 금지
3. 전체 복구 후보 저장이 라이브 적용보다 먼저 실행됨
4. 라이브 적용 실패 시점에는 복구가 이미 내구화됨
5. 빈 업데이트는 저장·적용 부작용 전에 거부됨

### 8.2 신규 재현기

```text
vulnerable.permanentLossWindowReproduced=true
fixed.storageFailure.rejectedWithDurabilityError=true
fixed.storageFailure.unprotectedEditBecameVisible=false
fixed.success.durableBeforeVisible=true
fixed.permanentLossWindowClosed=true
```

### 8.3 기존 치명적 손실 재현기 재검증

`reproduce-collaboration-materialization-loss.mjs`:

```text
vulnerable.permanentLossWindowReproduced=true
fixed.legacyCheckpointRequiresRematerialization=true
fixed.permanentLossWindowClosed=true
```

`reproduce-cross-instance-compaction-loss.mjs`:

```text
vulnerable.permanentLossWindowReproduced=true
fixed.staleNormalWriteRejected=true
fixed.staleRoomInvalidated=true
fixed.permanentLossWindowClosed=true
```

### 8.4 전체 무의존 가드

```text
[verify-data-loss-guards] OK: durable-before-visible browser edits, destructive ordering,
server-authoritative collaboration materialization, cross-instance durable-room freshness fencing,
provenance-fenced checkpoints, owner-scoped atomic browser exclusion,
expiry-safe transition fencing, cross-tab recovery isolation,
lossless malformed-record handling, seven locale messages,
boundary-safe convergent storage snapshots, and fail-closed recovery inspection.
```

### 8.5 협업 및 소스 구문 검증

```text
[verify-collaboration] OK: source wiring, exact Yjs dependency pins,
recovery acknowledgement safety, document-lineage isolation,
server-authoritative materialization provenance,
cross-instance durable-room freshness, hierarchy invariants,
RFC 6455 protocol behavior, and syntax for 134 file(s).
```

### 8.6 lockfile 검증

```text
[lockfile-registry] OK: 347 resolved URL(s) use approved portable registry hosts.
```

## 9. 기존 9개 치명적 방어 재검증

이번 수정과 함께 다음 기존 방어의 wiring과 재현 결과를 다시 확인했다.

1. 페이지 ID 재사용 시 구세대 Yjs recovery가 신세대 문서로 합쳐지는 문제
2. 다른 탭의 durable draft가 있는 상태에서 삭제·아카이브·복원을 진행하는 문제
3. recovery 저장소 검사 실패를 빈 상태로 해석하는 fail-open 문제
4. 복구 탭이 원본 탭 source key를 덮어쓰는 문제
5. 부분 손상 recovery record를 축약해 다시 저장하는 문제와 empty-string 존재성 오류
6. 비원자적 `localStorage` lease를 상호배제 잠금으로 취급한 문제
7. Web Lock이 유지되는 동안 만료 lease가 제거되어 편집이 재개되는 문제
8. 최신 Yjs update ID가 별도 브라우저 payload까지 인증한다고 가정한 materialization 문제
9. stale 다중 인스턴스 room이 누락된 상태를 최신 snapshot으로 압축하는 문제

문서/블록 파괴적 작업, attachment commit 경계, export/restore journal 및 fingerprint 경로도 다시 추적했으며, 이번 감사에서 10번째 문제 외에 추가적인 미수정 Critical 데이터 손실 경로는 확인되지 않았다. 이는 아래의 실행 제한을 포함한 코드 감사 결론이다.

## 10. 실행하지 못한 검증과 한계

깨끗한 의존성 설치는 실행 환경의 npm 패키지 게이트웨이가 기존 lockfile 의존성 tarball을 제공하지 못해 완료되지 않았다. 외부 public registry DNS 접근도 이 환경에서 허용되지 않았다.

따라서 다음은 실행하지 못했다.

- `npm run build`
- 전체 Vitest suite
- 실제 브라우저에서 quota/저장 비활성화 주입 통합시험
- 실제 MariaDB를 사용하는 end-to-end 트랜잭션 시험

이 제한을 보완하기 위해 신규 핵심 커밋 게이트를 외부 의존성이 없는 순수 모듈로 분리해 Node 기본 테스트 러너로 직접 검증했고, 전체 소스 wiring 및 세 개의 영구 손실 상태기계 재현을 실행했다. 배포 전 정상 npm registry, 지원 브라우저, MariaDB가 있는 환경에서 다음을 추가 실행해야 한다.

```bash
npm ci
npm run build
npm test
npm run db:migrate
```

## 11. 배포 및 운영 권고

- 기존 2026-07-28 감사의 배포 조건을 유지한다.
- 구버전 collaboration writer와 수정본을 동시에 운영하지 않는다.
- 모든 구버전 프로세스를 drain/stop한 뒤 수정본을 시작한다.
- migration 021, 022를 애플리케이션 트래픽보다 먼저 적용한다.
- 구버전 브라우저 탭은 새로고침하되 브라우저 recovery storage를 삭제하지 않는다.
- 저장 실패 메시지가 표시되면 해당 편집은 의도적으로 반영되지 않은 것이므로 브라우저 저장 설정과 quota를 복구한 뒤 다시 입력한다.
- 다중 애플리케이션 인스턴스가 필요하면 process-local fan-out 대신 shared pub/sub 및 분산 room coordination을 추가한다.
- 과거 취약 버전에서 이미 모든 내구 사본을 잃은 편집은 현재 DB만으로 복원할 수 없다. 백업과 각 사용자 브라우저의 recovery 데이터를 보존한다.

## 12. `.git` 보존 검증

검증 기준은 추출 후 작업 트리가 아니라 업로드 ZIP 내부의 `.git` 원본 바이트로 정했다. Git의 읽기 동작도 index의 stat cache를 갱신할 수 있으므로, ZIP 내부 28개 파일의 SHA-256 manifest를 직접 계산해 최종 상태와 비교했다. 비교 과정에서 작업 트리의 `.git/index` 한 파일만 ZIP 원본과 달라진 것을 확인했고, **`.git` 디렉터리를 삭제하거나 재생성하지 않은 채** 해당 파일을 같은 경로에 원본 바이트로 복원했다.

- `.git` 일반 파일 수: `28`
- 업로드 ZIP 원본 `.git` manifest SHA-256: `816d6ea60ac0731bc4c79c18bb80b5cb3f16725cbc787dcc776937d1ae502f02`
- 최종 작업 트리 `.git` manifest: `byte-for-byte 일치`
- `.git` 디렉터리 삭제/초기화/커밋: 없음

최종 ZIP을 별도 디렉터리에 재추출해 213개 일반 파일과 30개 디렉터리의 전체 바이트 manifest가 작업 트리와 일치함을 확인했다. 재추출본에서 신규 테스트, 세 재현기, 두 무의존 검증을 다시 실행한 뒤에도 `.git` manifest가 업로드 ZIP 원본과 일치했다.

## 13. 최종 판정

재현된 신규 영구 손실 창은 수정본에서 닫혔다.

- 저장 실패 시 편집은 라이브 Yjs/서버 전송 경로로 진입하지 않는다.
- 직접 편집 UI는 마지막 내구 상태로 복원된다.
- 성공 경로에서는 전체 복구 사본이 라이브 노출보다 먼저 저장된다.
- 서버 ACK 전에는 recovery가 유지된다.
- 거부된 블록 변경을 stale autosave가 나중에 전송할 수 없다.
- 기존 9개 데이터 손실 방어의 재현 및 source guard가 계속 통과한다.

전체 의존성 설치, 실제 브라우저 및 MariaDB 통합시험은 실행 환경 제한으로 미실행 상태이므로, 운영 배포 전 10절의 검증을 반드시 추가해야 한다.

## 14. 참고 표준 및 공식 문서

- WHATWG HTML Living Standard, Web Storage
- Yjs 공식 문서, Document Updates
- W3C Web Locks API
- MariaDB 공식 문서, START TRANSACTION / COMMIT
