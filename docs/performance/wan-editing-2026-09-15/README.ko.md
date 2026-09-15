# BrainVault 외부망 문서 편집 지연 — 분석·수정·회귀 테스트 보고서

작성 기준: 2026-09-15 · 입력: `BrainVault.zip` · 결과: 전체 프로젝트 수정본

## 1. 결론과 검증 상태

외부망의 왕복 지연이 여러 번 누적되는 **일반(비협업) 문서의 Enter/블록 삽입 경로**와, 변경 없는 블록에 대한 **불필요한 저장 PATCH**를 확인하고 수정했다. 새 내용의 서버 확정 전 표시, 인증 생략, 저장 내구성 완화로 속도를 얻는 방식은 사용하지 않았다.

추가한 성능·안전성 테스트 92개는 모두 통과했다. 동일 환경에서 원본은 936개 중 872개 통과/64개 실패, 수정본은 1,028개 중 964개 통과/64개 실패였다. 실패 테스트 이름 집합은 정확히 동일했다. 기존 소유자 검증 테스트 한 파일의 소스 형태 검사 2개는 선택적 메타데이터 콜백과 줄바꿈을 허용하도록 조정했으며, 소유자/SQL 조건 검사는 유지하고 실제 헬퍼 실행 테스트를 추가했다.

**그러나 전체 공식 CI, 실제 MariaDB 통합 테스트, 실제 브라우저/한글 IME 및 운영 외부망 E2E는 완료하지 못했다. 따라서 이 결과는 “모든 원본 기능과 보안에 대한 무결점 인증”이나 “운영 환경 배포 승인”이 아니다.** 아래 환경 제한과 원본 실패를 구분해서 확인해야 한다.

## 2. 조사 범위와 증거 수준

| 항목 | 확인 방식 | 판단 |
|---|---|---|
| Enter·블록 생성·순서 저장·문서 재조회 | 실제 소스 경로 추적 및 실제 함수 실행 | 중복 직렬 HTTP 경로 확인 |
| 변경 없는 블록 저장 | `saveBlockRow()` 실제 함수 실행 | 불필요한 PATCH 재현 |
| WAN 지연 증폭 | 요청마다 200ms를 지연시키는 HTTP 테스트 더블 | 왕복 수 감소 재현; 실제 WAN 아님 |
| 저장 큐·복구 저장소·세션 경계 | 기존 테스트 + 추가 경계 테스트 | 실행 가능한 범위 비교 |
| 국가/VPN/STUN 정책 | 관련 소스 조사 | 기존 캐시 존재; 보안 정책 미변경 |
| 실제 서버·리버스 프록시·DB·브라우저 | 접근/의존성/정책 제한 | 운영 원인 전체를 단정할 수 없음 |

사용자가 보고한 현상을 Enter, 블록 추가, 포커스 이동 때 체감한다면 이번 수정 경로와 직접 맞닿는다. **Enter 없이 한 블록에서 글자만 입력해도 계속 느린 경우의 원인이 이것 하나라고 단정하지 않는다.** 일반 입력은 이미 비동기 저장과 디바운싱을 사용한다. 대규모 DOM, 로컬 IndexedDB 지연, 브라우저 확장, 실제 프록시/서버 응답 시간은 별도 확인 대상이다.

## 3. 원본에서 확인한 지연 경로

`public/app.js`의 일반 Enter 처리는 `saveBlockRow(row)` 완료 후 `appendBlock(row)`를 호출한다. `appendBlock()`은 `insertBlockRelative()`로 이어지고, 기존 구현은 생성 후 재정렬과 `openPage()`를 통한 전체 문서 재조회를 진행한다.

```text
원본의 대표 경로
PATCH 현재 블록
  → POST 새 블록 생성
  → POST 형제 블록 전체 재정렬
  → GET 문서 전체
  → 문서 재렌더링/포커스 복원
```

블록이 이미 저장되어 있고 글자가 바뀌지 않았어도 `saveBlockRow()`는 복구 초안을 만들고 PATCH를 보냈다. 또 마지막 위치에 정확히 생성된 블록도 재정렬하고 문서 전체를 다시 읽었다. 포커스 이동에 따른 저장이 추가될 수 있다.

재정렬 중에는 `blockOrderSaving`, `openPage()` 중에는 페이지 편집 잠금이 작동한다. 이 잠금 자체는 데이터 안전을 위한 장치이므로 없애지 않았다. **잠금이 필요 없는 작업까지 거치도록 만든 중복 경로를 줄였다.**

Chrome 공식 문서는 TTFB에 네트워크 왕복 지연과 서버 준비 시간이 포함된다고 설명한다. 따라서 이미 연결이 맺어진 상황에서도 종속된 요청 4개가 직렬로 실행되면 각 응답 대기가 누적된다. HTTP/2를 사용한다고 애플리케이션의 순차 `await` 의존성이 사라지는 것은 아니다. 네트워크 대기만 단순화하면 원본 대표 경로는 약 `4 × 요청 지연`이다. [1][2]

## 4. 수정 내용

### 4.1 변경 없는 직접 저장을 생략

인증 경계를 먼저 확인하고, 비협업 분기에만 최적화를 적용했다. 서버에서 이미 확인한 블록과 실제 편집 payload가 같고, 복구 초안/충돌/예상 버전/저장 오류/저장 중 상태/예약 저장/활성 큐/인증에 묶인 미처리 편집이 모두 없을 때만 새 PATCH를 만들지 않는다.

단순히 문자열이 같다는 이유로 대기 중인 저장을 생략하지 않는다. 체크박스와 구조화된 메타데이터도 비교한다. 충돌 초안, 결과 불명의 요청, 큐 직렬화, mutationId 재사용과 내구성 절차는 기존 경로를 그대로 사용한다. Yjs 협업 저장 분기도 변경하지 않았다.

### 4.2 서버 확정 응답으로만 삽입 화면 반영

새 모듈 `public/block-insertion-result.js`의 `planConfirmedBlockInsertion()`은 빠른 반영이 가능한지 검증한다. 조건이 하나라도 맞지 않으면 `null`을 반환하고 기존 재정렬/정식 재조회 경로를 이용한다.

검증에는 다음이 포함된다: 생성 응답의 `pageContentVersionAuthoritative === true`, 시작 문서 버전에서 생성만 있으면 정확히 +1/생성 후 재정렬이면 정확히 +2, 현재 문서 버전 일치, 정확한 페이지 소속과 부모, 기존/새 블록 ID 집합의 완전성, 형제 순서, 블록별 버전, 중복 위치, 고아 블록/순환/과도한 깊이, 유효한 서버 수정 시각.

마지막 위치에 생성된 블록의 순서가 이미 맞으면 재정렬도 생략한다. 중간 삽입은 기존 재정렬 API를 유지하되, 응답에 포함된 전체 블록 목록이 완전하고 버전도 일치하면 추가 GET을 하지 않는다. 재정렬 후 새 블록은 **생성 시점의 version 1이 아니라 재정렬 응답의 최신 버전**으로 반영한다.

이 방식은 서버 저장 전 낙관적 표시가 아니다. 모든 쓰기는 기존 서버 API에서 성공한 뒤 화면에 반영한다. 버전 검증으로 갱신 손실을 방지한다는 원칙은 HTTP 조건부 갱신/낙관적 잠금 설명과도 일치한다. 단, 본 프로젝트의 검증 수단은 기존 JSON 버전·mutationId 계약이며 새 ETag 프로토콜을 도입한 것은 아니다. [3]

### 4.3 내구성·화면 전환·인증 경쟁 조건

성공한 저장 후 복구 레코드 삭제가 IndexedDB에 아직 반영 중이면 로컬 내구성 완료만 기다린다. 그 뒤 인증 세대, 탐색 세대, 선택 문서 객체, 페이지 화면, 편집 권한/잠금, 협업 모드, 미저장 편집과 복구 충돌을 다시 확인한다.

그 대기 중 로그아웃/문서 이동/동일 문서 재열기/권한 변경/새 입력이 생기면 이전 응답으로 새 화면을 덮어쓰지 않는다. 추가된 대기 이후에도 낡은 문서 의도로 재정렬이나 재조회를 전송하지 않도록 호출부를 보호했다. HTTP 401/403/404를 로컬 성공으로 바꾸는 동작은 하지 않는다.

### 4.4 문서 수정 시각과 최근 문서 UI 보존

전체 GET을 생략하면서 문서 수정 시각만 예전 값으로 남지 않도록 생성·재정렬 응답에 `pageUpdatedAt`을 추가했다. `advancePageContentVersion()`이 원래 수행하던 소유자 한정 SELECT의 결과를 선택적 콜백으로 전달하므로 **SQL 요청 수를 늘리지 않는다.** 소유자 WHERE 절, 최대 안전 버전 경계, 인증/공유/워크스페이스 검증은 유지했다.

클라이언트는 기존 `applyPageSummaryUpdate()`를 사용해 수정 시각과 최근 문서 표시를 갱신한다. 이 필드가 없는 구버전 서버와 조합되면 빠른 경로를 사용하지 않고 기존 방식으로 돌아간다.

## 5. 변경 파일과 변경하지 않은 영역

기존 실행 파일 변경: `public/app.js`, `src/routes/block.routes.ts`.
새 실행 모듈: `public/block-insertion-result.js`.

새 검증 파일: `tests/block-insertion-result.node.test.mjs`, `tests/wan-editing-latency.node.test.mjs`, `tests/block-insertion-timestamp.node.test.mjs`, `tests/helpers/wan-editing-harness.mjs`, `scripts/reproduce-wan-editing-latency.mjs`.
기존 테스트 형태 조정: `tests/block-content-version-owner-scope.node.test.mjs` 한 파일.

`.git`, 인증 미들웨어, 저장 큐, IndexedDB 복구 구현, Yjs 협업 구현, 의존성/lockfile, Node 보안 하한, TLS/CORS/CSP/쿠키 정책, 국가/VPN/STUN 정책, 배포 프록시 설정, DB 스키마를 변경하지 않았다. 원본 파일 삭제는 없다. `change-manifest.json`과 `existing-files-changes.patch`에 변경 내역을 포함했다.

## 6. 모의 지연 재현 결과

실제 `app.js`에서 함수를 추출해 Node VM에서 실행했다. DOM, 복구 저장소, 서버는 명시적인 테스트 더블이며 요청마다 200ms를 지연시켰다. 원본과 수정본에 동일한 모델을 적용했다. 각 행은 단일 실행 관측치이며 CPU 스케줄링 때문에 정확히 200의 배수는 아니다.

| 작업 | 직렬 요청 수: 원본 → 수정 | 원본 관측 시간 | 수정 관측 시간 |
|---|---:|---:|---:|
| 저장 완료된 블록 끝 Enter | 4 → 1 | 809.11 ms | 204.00 ms |
| 저장 완료된 블록 중간 Enter | 4 → 2 | 813.50 ms | 415.21 ms |
| 미저장 변경이 있는 블록 끝 Enter | 4 → 2 | 803.54 ms | 412.25 ms |
| 미저장 변경이 있는 블록 중간 Enter | 4 → 3 | 839.36 ms | 602.89 ms |

위 값은 실제 브라우저 키 입력 지연, 실제 사용자 외부망 RTT, 서버 처리량, DB 성능 또는 대규모 문서 렌더링 성능 측정치가 아니다. 원본/수정 모두 새 블록은 한 번만 생성되는지 확인했다. 최적 경로에서도 저장 전 서버 확정을 기다리는 정책은 남아 있으므로 외부망 지연을 완전히 0으로 만들지는 않는다.

재현 명령:

```sh
node scripts/reproduce-wan-editing-latency.mjs --latency-ms 200
# 별도로 추출해 둔 원본 app.js와 비교
node scripts/reproduce-wan-editing-latency.mjs --latency-ms 200 --source /path/to/original/app.js
```

기록은 `latency-before.json`, `latency-after.json`에 있다. 테스트 더블은 서버 인증/DB 통합 테스트를 대체하지 않는다.

## 7. 회귀 테스트 결과

| 실행 | 전체 | 통과 | 실패 | 해석 |
|---|---:|---:|---:|---|
| 원본의 Node 테스트 직접 실행 | 936 | 872 | 64 | 수정 전 기준선 |
| 수정본의 같은 실행 + 새 테스트 | 1,028 | 964 | 64 | 원본과 실패 이름 집합 동일 |
| 새 테스트만 별도 실행 | 92 | 92 | 0 | 빠른 경로/보수적 복귀/경계 조건 |

새 테스트 구성은 응답/트리 검증 44개, 실제 앱 함수의 편집·지연·경계 동작 41개, 타임스탬프와 소유자 한정 서버 헬퍼 7개다. 블록 끝/중간/빈 문서/중첩/희소 순서, 변경 없는 저장, 체크박스/메타데이터 변경, 복구 충돌, 저장 큐, 동일 mutationId 재전송, 재정렬 실패, 401/403/404, 로그아웃/탐색/동일 페이지 교체/권한/협업 전환/추가 입력/스토리지 실패 등을 포함한다.

실행 명령:

```sh
node --test --test-concurrency=4 tests/*.node.test.mjs
node --test tests/block-insertion-result.node.test.mjs tests/wan-editing-latency.node.test.mjs tests/block-insertion-timestamp.node.test.mjs
node --check public/app.js
node --check public/block-insertion-result.js
node scripts/lockfile-registry.mjs
```

JavaScript 구문 검사 통과, 수정 TypeScript 파일의 파싱/타입 제거 및 transpile 구문 진단 0건, lockfile의 허용된 레지스트리 URL 352개 검증 통과. **transpile은 전체 프로젝트의 의미론적 타입 검사(`tsc`) 통과를 뜻하지 않는다.**

기존 실패 64개에는 `.ts` 로더/패키지 부재와 원본에서도 발생한 소스 assertion 실패가 함께 있다. 이를 전부 환경 문제로 간주하거나 이번 작업에서 무관한 코드를 고쳐 숨기지 않았다. 전체 실패 이름은 `test-results.json`, 상세 로그는 `logs/baseline-node.log`, `logs/modified-node.log`에 있다.

## 8. 완료하지 못한 검증과 이유

실행 환경은 Node 22.16.0 / npm 10.9.2다. 프로젝트 원본은 `^22.23.2 || ^24.18.1 || >=26.5.1`을 요구하고 `engine-strict=true`이므로 `npm ci`가 EBADENGINE으로 중단됐다. 이 하한을 낮추거나 `--force`로 설치하지 않았다. Node 22.23.2는 공식 보안 릴리스이므로, 하한 완화로 검사만 통과시키는 조치는 적절하지 않다. [4]

로컬에 vitest/tsx 등 의존성이 없고 레지스트리 DNS 접근도 실패했다. `npm test`는 lockfile 검사 후 vitest 부재로 중단, `npm run build`는 Mermaid 검증 패키지 다운로드에서 EAI_AGAIN으로 중단됐다. `verify:security`/`verify:collaboration`은 tsx 부재, `verify:data-loss`는 tsx를 요구하는 자식 재현 실행에서 중단됐다.

Chromium 실제 페이지 이동은 `ERR_BLOCKED_BY_ADMINISTRATOR`로 차단됐다. 브라우저 정책을 바꾸거나 보안 설정을 우회하지 않았다. 따라서 실제 브라우저 DOM/포커스/스크롤/한글 IME, 실제 DB 트랜잭션, 협업 WebSocket, 프록시를 포함한 E2E는 미검증이다. 관련 시도 로그도 포함했다.

## 9. 운영 반영 전 검증 절차

운영 편집을 안전하게 저장한 뒤 원본 프로젝트와 DB를 백업한다. **테스트는 운영 DB가 아닌 분리된 테스트 환경에서 실행한다.** 원본이 요구하는 지원 Node 버전과 정상적인 레지스트리 접근을 준비한 뒤 다음 공식 검증을 실행한다.

```sh
node --version
npm ci
npm run check
npm run verify:security
```

현재 보고서의 64개 실패가 지원 환경에서 해결되는지/기존 assertion 문제가 남는지도 확인해야 한다. 단순히 새 실패가 없다는 이유로 전체 릴리스 게이트를 통과한 것으로 취급하지 않는다.

브라우저 확인에는 한글 조합 중 Enter, 연속 Enter, Shift+Enter, 블록 시작/중간/끝 삽입, 구조화된 블록, 체크박스, 되돌리기/다시 실행, 새로고침 후 내용 유지, 저장 중 이동/로그아웃, 오프라인과 재연결, 협업 전환, 다중 탭·계정, 첨부파일과 권한 거부를 포함한다. 새 문서뿐 아니라 대표적인 큰 문서도 사용한다.

서버 응답에 새 시각 필드가 필요하므로 **서버 코드와 public 자산을 함께 배포하고 정상 빌드 후 서버를 재시작**한다. DB 스키마 변경이나 데이터 마이그레이션은 없다. 기존 브라우저 편집을 저장하지 않은 채 강제 새로고침하거나 프로젝트를 덮어쓰지 않는다. `.git`을 지우거나 Git 초기화/정리 명령을 실행할 필요가 없다.

## 10. 남는 외부망 지연을 구별하는 방법

수정 후에도 증상이 남으면 동일 문서·동일 브라우저 조건으로 LAN/WAN을 비교한다. Chrome Network의 Timing/Initiator/Waterfall에서 PATCH, 생성 POST, reorder POST, 문서 GET의 실제 연쇄를 확인한다. TTFB가 큰지, Content Download가 큰지, 메인 스레드 렌더링이 큰지 나누어 본다. [1]

첫 외부 접속에만 큰 지연이 있으면 국가/VPN/STUN 정보의 콜드 경로도 조사하되, 정책을 끄는 것이 해결책이라고 단정하지 않는다. 모든 입력이 느리면 IndexedDB와 렌더링 프로파일도 확인한다. 여러 요청이 서버에서 느리면 프록시/서버/DB 로그를 상관 분석한다.

HAR의 기본 민감 헤더 제외 옵션을 사용하더라도 요청 본문에 문서 내용이 남을 수 있다. 외부 공유 전 쿠키·토큰·이메일·문서 본문·서버 주소를 별도로 제거해야 한다. [1]

## 11. .git 및 원본 보존

원본 `.git`의 일반 파일은 **28개**, 디렉터리를 포함한 ZIP 항목은 **44개**다. Git 명령을 실행하지 않고 파일별 SHA-256과 ZIP 내 날짜/외부 속성을 대조한다. 압축본 최종 대조 결과는 `archive-verification.json`에 기록한다. `original-git-manifest.json`에는 원본 기준값을 담았다. 원본 파일 삭제는 없으며, 기존 수정 대상 3개 외 모든 원본 일반 파일은 내용이 같다.

## 12. 공식 기술 자료

[1] Chrome DevTools — Network features reference, Timing breakdown / Initiators / sanitized HAR.
https://developer.chrome.com/docs/devtools/network/reference/

[2] MDN — Round Trip Time (RTT).
https://developer.mozilla.org/en-US/docs/Glossary/Round_Trip_Time

[3] MDN — HTTP conditional requests, Avoiding the lost update problem with optimistic locking.
https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests

[4] Node.js — Node.js 22.23.2 (LTS), 2026-07-29 security release.
https://nodejs.org/en/blog/release/v22.23.2

자료는 설계 원칙과 검증 도구의 공식 근거다. BrainVault의 구체적 원인·요청 수·테스트 결과는 업로드된 소스와 동봉한 실행 기록을 근거로 한다.
