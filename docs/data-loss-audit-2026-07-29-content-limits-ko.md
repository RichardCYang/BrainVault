# BrainVault 데이터 보존 후속 감사 및 수정 보고서

감사일: 2026-07-29 (Asia/Seoul)  
대상: 업로드된 `BrainVault.zip` 전체 소스와 보존된 `.git` 이력  
중점: 편집 입력, 브라우저 복구본, Yjs 영속화, DB 반영, 첨부파일, 백업·복원

## 1. 결론

새로운 **High 심각도 데이터 손실 결함 1건**을 확인하고 수정했다.

공유 페이지에서 제목이 160자를 넘거나 일반 블록 본문이 20,000자를 넘으면, 기존 구현은 화면에 초과 부분을 남겨 둔 채 Yjs 문서와 브라우저 복구본에는 제한 길이까지만 조용히 기록했다. 사용자는 저장된 것으로 인식하지만 새로고침하면 초과 부분이 사라질 수 있었다.

수정 후에는 다음 불변식이 적용된다.

```text
화면에 저장 완료로 표시되는 협업 편집
    ⇒ 동일한 전체 값이 브라우저 recovery와 Yjs 저장 후보에 포함됨
```

허용 길이를 초과한 값은 더 이상 잘라서 저장하지 않는다. 일반 입력 UI가 서버 제한을 넘지 못하게 하고, 스크립트·브라우저 확장·향후 코드 변경이 UI 제한을 우회하더라도 협업 mutation을 만들기 전에 명시적으로 거부한다.

기존의 브라우저 초안, 저장 큐, 삭제·복원 전환 잠금, 서버 권위 Yjs materialization, 첨부파일 claim/fsync, 백업·복원 journal 경로도 다시 검토했다. 이번 범위에서 수정 후 남아 있는 별도의 Critical/High 영구 손실 경로는 확인하지 못했다.

## 2. 확인한 영구 손실 순서

취약 구현에서는 다음 순서가 가능했다.

1. 사용자가 공유 페이지 제목에 161자 또는 블록 본문에 20,001자를 붙여넣는다.
2. DOM 입력에는 전체 문자열이 남는다.
3. 제목 저장 경로는 `slice(0, 160)`, 블록 정규화 경로는 `slice(0, 20_000)`을 적용한다.
4. 잘린 값만 Yjs staging 문서와 브라우저 recovery에 들어간다.
5. 편집 행은 저장 완료 상태로 표시된다.
6. 새로고침하면 서버/Yjs에 없던 마지막 부분이 복구되지 않는다.

비협업 편집은 서버의 길이 검증이 요청을 거부하고 브라우저 direct draft에 전체 입력이 남기 때문에 동일한 silent-loss 동작은 아니었다. 문제는 협업 경로가 UI 값과 영속 후보를 다르게 취급한 데 있었다.

## 3. 적용한 수정

### 3.1 잘라내기 대신 mutation 전 실패 폐쇄

`public/editor-content-limits.js`에 제목과 본문 제한 및 공통 검증기를 추가했다.

- 제목: 160자
- 블록 본문: 20,000자
- 정확한 경계값은 그대로 반환한다.
- 초과값은 `EDITOR_CONTENT_LIMIT_EXCEEDED` 오류로 전체 mutation 전에 거부한다.

`public/collaboration.js`의 다음 경로가 모두 공통 검증기를 사용한다.

- `setTitle`
- `normalizeBlock`, `upsertBlock`, `upsertBlocks`
- Yjs document snapshot 읽기
- 관계형 페이지에서 협업 문서를 초기화하는 bootstrap
- collaboration session document 수신

따라서 로컬 저장 후보뿐 아니라 inbound/bootstrap 상태도 조용히 축약하지 않는다.

### 3.2 UI와 서버 제한 일치

- 페이지 제목 입력에 `maxlength="160"`을 추가했다.
- 일반 텍스트 블록 textarea에 `maxLength = 20_000`을 적용했다.
- `schedulePageTitleSave()`가 Yjs 호출 전에 제목을 자르던 코드를 제거했다.
- 협업 스냅샷을 앱 상태에 적용할 때도 공통 검증기를 사용한다.
- 백업 manifest의 블록 본문도 20,000자 제한을 검증해, 복원 뒤 협업 전환 시 처음으로 축약되는 상태를 만들지 않는다.

UI 제한은 정상 입력을 안내하고, 저장 계층 검증은 UI 제한 우회와 미래 회귀를 차단한다.

### 3.3 첨부 업로드 교착 방지

첨부 업로드는 기존에 페이지 행을 먼저 잠근 뒤 소유자 행을 잠갔다. 반면 export/restore와 첨부 정리는 소유자 행 다음 페이지 행 순서였다. 동시 실행 시 `page → user`와 `user → page`의 잠금 역전으로 교착·저장 실패가 발생할 수 있었다.

업로드도 다음 순서로 통일했다.

```text
사전 접근 확인
→ owner user row FOR UPDATE
→ page row FOR UPDATE 및 접근 재검증
→ owner 불변성 확인
→ parent 재검증
→ 파일 영속 이동
→ block INSERT와 content_version 증가
```

사전 조회와 잠금 사이에 페이지 소유자가 달라진 비정상 세대 변경은 409로 실패 폐쇄한다. 파일 이동은 두 잠금과 재검증 뒤에만 실행된다.

### 3.4 실패한 빌드의 부분 산출물 차단

기존 `npm run build`는 TypeScript 오류가 있어도 일부 `dist` 파일을 갱신할 수 있었다. 수정 코드가 배포되지 않고 이전 산출물과 섞이는 운영 위험을 막기 위해:

- 빌드 전에 검증된 `dist` 경로만 정리한다.
- `noEmitOnError: true`를 적용했다.
- TypeScript 오류를 모두 수정했다.
- Vitest와 `node:test` 전용 파일을 분리했다.
- 기본 `npm test`가 일반 테스트와 내구성 테스트를 모두 실행하게 했다.
- `npm run check`에 build, 전체 테스트, 두 데이터 손실 검증기를 묶었다.

## 4. 검증 결과

최종 명령:

```bash
npm run check
```

결과:

```text
TypeScript build: PASS
Vitest:             58 files, 316 tests, 316 pass
Durability tests:   13 tests, 13 pass
verify:data-loss:   PASS
verify:collaboration: PASS
```

새 회귀 테스트는 다음을 확인한다.

- 제목과 본문 정확한 경계값 보존
- 경계 초과값을 잘라내지 않고 거부
- 제목 저장 호출 전에 `.slice()`가 다시 들어오지 않음
- title/block validation이 collaboration mutation보다 먼저 실행됨
- snapshot/bootstrap도 동일한 strict 검증 사용
- UI `maxlength`가 서버 제한과 일치
- 첨부 업로드의 `user → page → file move → INSERT` 순서
- 최신 라우트 방어 로직과 일치하도록 충돌·재정렬·페이지 목록 mock 회귀 복구

## 5. 감사 범위

다음 경로를 소스와 테스트로 재검토했다.

- direct title/block draft의 localStorage 선행 저장과 실패 롤백
- revision/mutation ID, 응답 유실 재시도, 최신 편집 rebase
- 페이지·블록 삭제, 아카이브, 공유 전환, 전체 복원의 브라우저 recovery 차단
- Yjs recovery의 durable-before-visible 순서와 ACK 뒤 정리
- 다중 프로세스 stale room durable-tip fence
- 서버 권위 Yjs materialization과 destructive checkpoint
- 첨부 파일 exclusive claim, fsync, commit 결과 불명 시 파일 보존, 삭제 후 재확인
- ZIP export/restore의 fingerprint, SHA-256/CRC, staging, generation journal
- 마이그레이션 재실행 방어와 기본 운영 문서

## 6. 남은 운영 전제와 한계

이번 결론은 소스 감사와 자동 테스트 결과다. 이 실행 환경에서는 실제 MariaDB 프로세스를 사용한 강제 종료/재시작 시험과 실제 브라우저 다중 탭 E2E를 수행하지 못했다. 운영 배포 전에는 별도 환경에서 동시 업로드·export/restore, DB commit 직전·직후 종료, 디스크 공간 부족, 브라우저 강제 종료를 포함한 시험이 필요하다.

또한 다음 전제를 지켜야 한다.

1. 내장 collaboration room fan-out은 process-local이다. 공유 pub/sub와 분산 room coordinator를 추가하기 전에는 한 개의 활성 애플리케이션 프로세스를 사용한다.
2. `ATTACHMENT_UPLOAD_DIR`는 DB와 함께 백업되는 영속 볼륨이어야 한다. 다중 호스트에서는 모든 writer가 같은 파일 저장소와 복구 journal을 보아야 한다.
3. MariaDB와 첨부 볼륨을 같은 논리 시점에 정기 백업하고 실제 복원 훈련을 수행한다.
4. 사용자 ZIP은 소유한 페이지의 materialized 내용과 첨부파일을 보존하지만 공유 권한 목록과 Yjs 변경 이력은 보관하지 않는다. 복원된 소유 페이지는 공유되지 않은 상태가 된다.
5. 스키마 변경은 단일 migration job으로 실행하고, 운영 DB에는 사전 백업과 advisory lock/checksum 기반 배포 절차를 추가하는 것이 권장된다.

## 7. 변경 파일 요약

핵심 제품 코드:

- `public/editor-content-limits.js`
- `public/app.js`
- `public/collaboration.js`
- `public/index.html`
- `src/routes/block.routes.ts`
- `src/lib/data-transfer.ts`

빌드·검증:

- `scripts/clean-dist.mjs`
- `package.json`
- `tsconfig.json`
- `public/i18n.d.ts`
- `tests/editor-content-limits.node.test.mjs`
- `tests/editor-content-limits-ui.test.ts`
- 최신 구현과 어긋난 route/UI 테스트 mock 및 assertion

Git 이력은 재작성하지 않았으며, 전달 압축에는 업로드본의 `.git` 디렉터리를 포함한다.
