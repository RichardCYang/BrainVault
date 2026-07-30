# BrainVault 협업 블록 삭제 데이터 무결성 심층 감사

- 감사일: 2026-07-30
- 기준 Git 커밋: `46f8d825449c29ede71500391cb706e7046141d5`
- 대상: 첨부된 BrainVault 전체 소스와 `.git` 이력
- 중점 범위: Yjs 브라우저 복구, 다중 탭 삭제 경합, Web Lock 전환 fence, 협업 materialization, 첨부파일 블록 교체

## 결론

전체 데이터 저장 경로를 재검토한 결과, 기존 구현에는 **같은 브라우저의 다른 탭에 아직 서버 ACK를 받지 못한 협업 편집 복구본이 남아 있는데도 해당 블록을 삭제할 수 있는 High 심각도 무결성 결함**이 있었다.

일반 페이지의 블록 삭제는 다른 탭의 direct-draft를 검사하고, 페이지 보관·영구 삭제·공유 해제는 Yjs recovery를 검사했다. 그러나 협업 페이지의 블록 삭제만 `session.deleteBlock()`을 직접 호출해 다음 방어를 우회했다.

- owner/page 단위 Web Lock 및 localStorage 전환 lease
- 다른 탭에 저장된 collaboration recovery 검사
- 삭제 전 peer-tab flush 대기
- 삭제 업데이트가 서버 ACK 및 SQL materialization까지 완료되기 전 전환 lease 유지

이 상태에서 탭 B의 오프라인 편집과 탭 A의 블록 삭제가 겹치면, 탭 B의 업데이트가 나중에 서버에 수락되더라도 삭제된 최상위 block key는 다시 보이지 않을 수 있다. 이후 ACK 처리로 브라우저 recovery가 제거되면 사용자가 편집 내용을 되찾을 명시적 복구본도 사라지는 손실 창이 생긴다.

수정본은 협업 블록 삭제와 첨부파일로 빈 블록을 교체하는 경로를 동일한 destructive transition으로 통합해 다음을 보장한다.

1. 삭제 전 현재 탭의 pending Yjs 업데이트를 ACK/materialization까지 flush한다.
2. 전환 storage event가 다른 동일 출처 탭에 전달될 시간을 준다.
3. 다른 계정까지 포함해 대상 페이지의 local collaboration recovery를 fail-closed로 검사한다.
4. recovery가 하나라도 남아 있거나 storage 검사가 불확실하면 삭제를 실행하지 않는다.
5. 삭제가 허용된 경우 삭제 업데이트가 서버에 ACK되고 SQL에 materialize될 때까지 Web Lock/lease를 유지한다.
6. 첨부파일 업로드 중 빈 블록 교체도 더 이상 `session.deleteBlock()`을 직접 호출하지 않는다.

## 신규 결함: 미확인 협업 복구본과 블록 삭제의 경합

### 심각도

**High — 사용자 편집 내용의 영구 비가시화 및 복구본 제거 가능성**

필요 조건:

- 동일한 origin을 사용하는 브라우저 탭이 둘 이상 열려 있음
- 대상 페이지가 공유 협업 모드임
- 한 탭에 서버 ACK 전의 durable Yjs recovery가 존재함
- 다른 탭에서 같은 블록을 삭제하거나 빈 블록을 첨부파일로 교체함

영향:

- 다른 탭의 편집 내용이 서버 업데이트로는 수락되지만 삭제된 block key 아래에서 보이지 않을 수 있음
- ACK 후 local recovery가 제거되면 명시적인 사용자 복구 경로가 사라짐
- 삭제 요청은 정상 성공으로 보이므로 손실을 즉시 인지하기 어려움
- 첨부파일 업로드의 “빈 블록 교체”도 동일한 우회 경로를 사용했음

### 근본 원인

기존 `public/app.js`의 협업 분기는 다음과 같이 파괴적 전환과 recovery 검사를 건너뛰었다.

```js
if (isCollaborativePage()) {
  const session = state.collaborationSession;
  if (!session?.isReady) throw new Error(t("sharing.syncRequired"));
  return {
    deletedIds: session.deleteBlock(blockId, {
      cascade: options.includeDescendants !== false
    })
  };
}
```

반면 direct-mode 블록 삭제는 이미 `withPagePersistenceTransition(pageId, "block-delete", ...)`과 `assertNoPendingLocalBlockDrafts(...)`를 사용했다. 페이지 보관, 영구 삭제, 마지막 공유 해제도 `assertNoPendingLocalCollaborationRecovery(...)`를 사용했다. 즉, 협업 블록 삭제만 프로젝트 전체의 파괴적 작업 정책에서 벗어나 있었다.

첨부파일 업로드에서도 빈 소스 블록을 교체할 때 다음 직접 호출이 존재했다.

```js
session.deleteBlock(blockId, {
  cascade: false,
  allowDisconnected: true
});
```

이 경로는 recovery 검사뿐 아니라 동기화 준비 상태 검사도 완화했다.

## 재현

프로젝트에 다음 명령을 추가했다.

```bash
npm run reproduce:collaboration-block-delete-loss
```

재현기는 다음 세 층을 검증한다.

1. **취약 상태 모델**
   - peer recovery가 존재하지만 삭제가 이를 무시함
   - 삭제 후 recovery 업데이트가 ACK됨
   - 명시적 recovery가 제거됨
   - 편집 블록이 보이지 않아 손실 창이 성립함

2. **수정 상태 모델**
   - pending recovery가 발견됨
   - 삭제가 실행되기 전에 차단됨
   - 원래 블록과 recovery가 모두 남음

3. **실제 소스 순서 검증**
   - owner/page Web Lock 전환 존재
   - peer flush 후 recovery 검사
   - recovery 검사 후에만 `session.deleteBlock()` 실행
   - 삭제 후 `flushMaterialization({ compact: false })` 완료 전 lease 해제 금지
   - 첨부 교체 경로의 직접 `session.deleteBlock()` 제거

설치된 `yjs` 패키지가 존재하는 환경에서는 재현기가 실제 Yjs 문서를 만들어 “최상위 `Y.Map` key 삭제 후 오프라인 nested edit 전체 상태 적용”도 실행한다. 이번 격리 실행 환경은 내부 npm mirror 장애로 `node_modules`를 설치하지 못해 해당 선택적 runtime 항목은 `available: false`로 기록했다. 소스 경로, 상태 전이, 방어 순서 재현은 의존성 없이 실행하고 통과했다.

## 수정 내용

### 1. 협업 파괴적 전환 공통화

`public/app.js`에 `withCollaborativeDestructiveTransition()`을 추가했다.

```js
async function withCollaborativeDestructiveTransition(pageId, kind, action) {
  return withPagePersistenceTransition(pageId, kind, async () => {
    await flushPendingPageEdits({
      allowLocked: true,
      collaborationCompact: false
    });
    assertNoPendingLocalCollaborationRecovery(pageId);

    const session = state.selectedPage?.id === pageId
      ? state.collaborationSession
      : null;
    if (!session?.isReady) throw new Error(t("sharing.syncRequired"));

    const result = await action(session);
    await session.flushMaterialization({ compact: false });
    return result;
  });
}
```

핵심 순서는 `peer flush → recovery 검사 → 삭제 → ACK/materialization → lease 해제`다.

### 2. 협업 블록 삭제를 공통 fence로 전환

`deleteBlockWithVersionCheck()`의 협업 분기는 이제 직접 삭제하지 않고 공통 전환을 사용한다.

```js
return withCollaborativeDestructiveTransition(
  pageId,
  "block-delete",
  async (session) => ({
    deletedIds: session.deleteBlock(blockId, {
      cascade: options.includeDescendants !== false
    })
  })
);
```

이 변경은 컨텍스트 메뉴 삭제, 빈 블록 삭제, 키보드 기반 삭제 등 공통 helper를 사용하는 모든 협업 경로에 적용된다.

### 3. 첨부파일 빈 블록 교체 우회 제거

첨부 업로드의 협업 분기에서 직접 `session.deleteBlock()` 호출을 제거하고 다음 guarded helper를 사용한다.

```js
await deleteBlockWithVersionCheck(blockId, {
  includeDescendants: false
});
```

업로드 API가 이미 완료된 뒤 recovery 때문에 교체가 차단되더라도 원본 소스 블록은 보존된다. 업로드된 첨부는 SQL의 canonical attachment로 남고 이후 협업 bootstrap/reconcile에서 다시 채택할 수 있으므로, 실패가 원본 편집 삭제로 이어지지 않는다.

### 4. 회귀 테스트와 통합 검증

추가 파일:

- `tests/collaboration-destructive-delete.node.test.mjs`
- `scripts/reproduce-collaboration-block-delete-recovery-loss.mjs`

갱신 파일:

- `public/app.js`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`
- `docs/README.md`

## 검증 결과

의존성 없이 실행 가능한 최종 검증:

```text
node --experimental-strip-types --test tests/*.node.test.mjs
39 tests passed, 0 failed
```

```text
node scripts/verify-data-loss-guards.mjs
OK
```

```text
node --experimental-strip-types scripts/verify-collaboration.mjs
OK
```

```text
node scripts/reproduce-collaboration-block-delete-recovery-loss.mjs
vulnerable loss window reproduced; fixed recovery fence verified
```

추가된 회귀 테스트는 다음을 검사한다.

- recovery 검사가 destructive action보다 먼저 실행되는지
- 삭제 action 이후 materialization이 끝날 때까지 전환 lease를 유지하는지
- 협업 삭제가 공통 fence를 사용하는지
- 첨부 교체가 직접 `session.deleteBlock()`을 호출하지 않는지
- 취약/수정 상태 모델에서 복구본과 블록 보존 결과가 반대로 나타나는지

검증 로그는 `audit-logs/`에 포함했다.

## 심층 검토 중 다시 확인한 기존 방어선

이번 감사에서는 신규 결함 외에도 다음 경로를 재검토했다.

- MariaDB strict transactional SQL mode와 commit ambiguity 처리
- 페이지·블록 version snapshot/CAS 삭제
- 서버 권위 Yjs durable log와 materialization update ID fence
- cross-instance collaboration compaction freshness
- 브라우저 durable-before-visible recovery write
- 페이지 보관·영구 삭제·공유 해제의 local recovery fail-closed 검사
- 첨부파일 hard-link claim, fsync, DB commit 후 삭제 검증
- 전체 백업 ZIP CRC32/SHA-256 stream 재검증
- restore journal, attachment generation marker, page share 복원
- page-scoped block parent 복합 외래키
- malformed/empty localStorage 레코드의 보수적 보존

위 경로에서는 현재 working tree 기준으로 별도의 신규 영구 소실 경로를 재현하지 못했다.

## 잔여 위험과 운영 권고

이번 수정이 차단하는 범위는 **동일 origin에서 localStorage와 Web Locks를 공유하는 탭**이다. 완전히 오프라인인 다른 기기/브라우저의 아직 알려지지 않은 편집은 현재 탭이나 서버가 삭제 시점에 관찰할 수 없다. 하드 삭제와 오프라인 편집을 동시에 허용하는 협업 제품에서는 이 상황을 완전히 제거하려면 다음 중 하나가 필요하다.

- 서버 측 블록 버전 히스토리/휴지통
- 일정 기간 보존되는 soft-delete tombstone과 복원 UI
- 삭제된 블록에 뒤늦게 도착한 편집을 별도 conflict copy로 승격하는 정책

현재 수정은 관찰 가능한 동일 브라우저 recovery를 조용히 버리는 취약점을 닫지만, 다기기 오프라인 충돌에 대한 제품 수준의 복구 보장은 별도 기능으로 추가하는 것이 안전하다.

## 검증 환경 제한

`npm ci --ignore-scripts --no-audit --no-fund`는 현재 실행 환경의 내부 npm mirror가 `zod-3.25.76.tgz`를 404로 반환해 완료되지 않았다. 따라서 이 환경에서 다음 항목은 실행하지 못했다.

- 전체 Vitest suite
- 정식 `tsc` build/type-check
- 실제 MariaDB 통합 테스트
- 설치된 `yjs@13.6.31`을 사용하는 runtime CRDT 재현
- 실제 브라우저 다중 탭 E2E

배포 전 정상 개발 환경에서 다음 게이트를 추가 실행해야 한다.

```bash
npm ci
npm run check
npm run reproduce:collaboration-block-delete-loss
```

실제 브라우저 E2E에서는 다음을 확인해야 한다.

1. 탭 B의 WebSocket을 끊고 블록을 편집해 recovery를 생성한다.
2. 탭 A에서 같은 블록 삭제를 시도한다.
3. 삭제가 recovery pending 메시지로 차단되는지 확인한다.
4. 탭 B를 다시 연결해 ACK/materialization을 완료한다.
5. 탭 A에서 재시도하면 삭제가 성공하는지 확인한다.
6. 같은 절차를 빈 블록의 첨부파일 교체에도 적용한다.

## `.git` 보존

최종 전달본은 원본 ZIP을 새 디렉터리에 다시 풀어 그 위에 수정된 **비 `.git` 파일만** 덮어쓰는 방식으로 조립했다. 따라서 `.git` 디렉터리를 삭제·초기화·재생성하지 않았고, 최종 ZIP의 `.git` 파일 목록과 SHA-256은 원본 ZIP과 바이트 단위로 다시 비교했다.

## 참고한 자료

- Yjs 공식 저장소 및 Shared Types 문서: CRDT 업데이트의 자동 병합, 공유 `Map`/중첩 타입 모델
- MDN IndexedDB 문서: transaction 완료/중단 및 브라우저 durable storage의 한계
- OWASP Code Review Guide: race condition과 transactional integrity/rollback 검토 지침
