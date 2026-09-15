# BrainVault CPU·메모리 자원 효율성 검증 및 수정 보고서

검증일: 2026-09-15  
입력: 사용자가 제공한 `BrainVault.zip`  
수정 범위: 운영 JavaScript 3개 파일, 재현·회귀 테스트와 감사 자료 추가

## 1. 결론과 배포 판단

**실제로 재현되는 불필요한 작업 4건을 확인하고 수정했다.** 협업 문서의 반복 트리 검색, 사용하지 않는 로컬 문서 서명 생성, 블록 순서 복구의 중첩 포함 검사, 편집 이력의 중복 깊은 복제가 대상이다.

가장 넓게 실행한 동일 조건 비교에서 원본은 **1,212건 중 1,195건 통과·17건 실패**, 수정본은 **1,264건 중 1,247건 통과·17건 실패**였다. 실패한 테스트의 이름은 정확히 같으며, 추가한 Node 회귀 52건은 모두 통과했다. 별도의 실제 Chromium 구성요소 검사도 **23건 모두 통과**했다. 이 숫자들을 서로 독립적인 전체 테스트 수로 합산하지 않는다. 추가 52건은 수정본 1,264건에 포함된다.

**전체 서비스의 기능·보안이 완전히 보장되었다거나 전체 테스트가 모두 통과했다고 판단하지 않는다.** 현재 환경의 Node.js 버전은 원본 프로젝트의 지원 하한보다 낮다. 원래의 `engine-strict`를 유지한 설치는 차단되었고, npm 레지스트리 DNS 접근도 실패했다. `npm test`, 전체 빌드, 공식 보안·협업 검증을 끝까지 실행하지 못했다. 실제 MariaDB·HTTP 서버·다중 사용자 WebSocket·운영 배포를 연결한 전체 E2E는 수행하지 않았다. 지원 버전과 의존성이 갖추어진 환경에서 이 검증을 마친 뒤 운영 배포를 판단해야 한다.

**`.git`에는 쓰기 작업이나 Git 명령을 수행하지 않았다.** 원본의 44개 `.git` ZIP 항목(일반 파일 28개 포함)을 그대로 보존하는 방식으로 패키징하며, 파일 바이트 SHA-256과 ZIP에 기록된 타임스탬프·속성 등을 검사하는 읽기 전용 검증 스크립트를 제공한다. 최종 압축파일 검증 결과는 별도로 제공되는 `BrainVault_archive_verification.json`을 확인한다.

## 2. 수정 내역

### 2.1 협업 문서 트리의 반복 전체 검색 — `public/app.js`

`buildCollaborationBlockTree()`가 들어오는 블록마다 `getBlockById()`로 기존 문서를 다시 재귀 검색했다. 기존 문서와 새 스냅샷이 같은 순서로 n개 블록을 가지는 재현에서는 기존 블록 방문 횟수가 `n(n+1)/2`였다. 6,000블록이면 **18,003,000번**이다.

스냅샷 처리 중에만 존재하는 `Map`을 한 번 구성하고 기존 블록을 조회하도록 변경했다. 같은 재현에서 기존 트리 방문은 **6,000번**이다. 최초의 유효한 입력 블록을 만났을 때만 인덱스를 생성하므로 빈 스냅샷에서는 기존 트리를 스캔하지 않는다.

보존한 동작은 기존 ID의 첫 번째 깊이 우선 검색 결과 선택, 중복 입력의 첫 블록 선택, 버전·생성/수정 시각·HTML 캐시 보존, 첨부 메타데이터 병합, 부모 연결·순환 방지·깊이 제한·정렬이다. 인덱스를 전역이나 페이지 간 캐시로 두지 않아 다른 페이지/계정의 이전 객체가 재사용되지 않는다.

트리 검색 부분의 반복 작업을 없앤 것이며, 전체 함수가 모든 입력에서 반드시 O(n)이라는 뜻은 아니다. 원래의 정렬과 깊이 제한 검사는 남아 있다. 스냅샷마다 참조 인덱스를 잠시 만드는 O(n) 추가 공간과 검색 CPU 절감 사이의 교환이다.

### 2.2 로컬 협업 편집의 미사용 서명 생성 — `public/app.js`

`applyCollaborationSnapshot()`은 이전/다음 블록 서명을 모두 계산한 다음 `source === "local"`에서 반환했다. 이 경로는 서명을 전혀 사용하지 않는데도 문서 전체를 두 번 직렬화했다.

로컬 경로에서는 이 두 호출만 생략한다. 문서 트리 재구성·제목 유효성 검사·선택 문서와 목록 상태 업데이트·종료 전 보호 등의 기존 동작은 유지된다. 원격·복구 경로의 서명 비교는 그대로 두었으므로 원격 변경 감지, 렌더링, 포커스 복원, 이력 초기화 경로를 제거하지 않았다.

측정한 로컬 스냅샷 전체 처리 시간에는 2.1의 개선 효과도 함께 포함된다. 그 시간 감소 전부를 서명 생략 하나의 효과로 해석하지 않는다.

### 2.3 순서 복구 데이터 검증의 중첩 배열 탐색 — `public/draft-store.js`

`normalizeBlockOrderDraft()`는 중복을 검사할 때 `Set`을 생성해 버린 뒤, `previousIds`의 각 ID가 `orderedIds`에 포함되는지 `includes()`로 재검사했다. 10,000개 순서를 뒤집는 입력에서 **50,005,000번의 원소 비교**가 발생했다.

이미 필요한 유일성 검사용 `Set`을 보관해 포함 검사에도 재사용한다. 같은 입력에서 **10,000번의 `has()` 호출**로 바뀐다. 중복 ID, 외부 ID, 부모 불일치, 안전 정수 범위를 넘는 버전, 비정상 정렬, getter, 숨겨진/알 수 없는 속성 등 거부 조건은 없애지 않았다. 반환하는 배열/항목의 외부 참조 분리도 유지한다.

이는 검증을 생략하는 최적화가 아니다. MDN이 설명하는 것처럼 `Set.has()`는 평균적으로 같은 크기 배열의 대부분을 탐색하는 방법보다 유리하다. ECMAScript가 모든 엔진에 최악 시간 O(1)을 보장한다고 주장하지 않는다. [외부 자료 1]

### 2.4 편집 이력의 중복 깊은 복제 — `public/editor-history.js`

변경 이력 한 건을 기록할 때 이미 내부 소유인 이전 기준값을 다시 복제하고, 새 입력을 이력과 다음 기준값 용도로 별도로 복제하고 있었다. 같은 구조화 블록 객체를 여러 벌 보유했다.

이전 기준값은 이미 외부 입력에서 분리된 내부 스냅샷이므로 재사용한다. 새 입력은 한 번 깊게 복제한 다음 이력과 다음 기준값이 내부적으로 공유한다. 내부 구현은 스냅샷 내용을 직접 변경하지 않고 새 스냅샷으로 교체한다. 외부로 전달하는 `peek()`와 입력을 받는 `seed()`의 방어적 복제, undo/redo의 기준값 복구는 유지한다.

일반 변경 기록에서는 본문 복제 3회가 1회로 줄고, 메타데이터 복제 1회는 유지된다. 따라서 100회 기록의 전체 clone 호출은 **400회 → 200회**, clone에 전달되는 JSON 문자량은 **7,841,174 → 2,613,992 UTF-16 code units**였다. 문자량은 할당 바이트를 직접 계측한 수치가 아니다.

이력 제한(기본 최대 80항목, 이력 바이트 예산 8MiB)과 유지된 이력 깊이를 줄여 얻은 효과가 아니다. 해당 바이트 예산은 기존 이력의 논리적 계산값이며 모든 기준값/브라우저 힙 전체에 대한 엄격한 상한이라는 뜻도 아니다.

## 3. 성능 재현 방법과 최종 측정

수정 전 원문에서 추출한 실제 함수와 수정 후 실제 소스를 같은 하네스에서 실행한다. 별도의 단순화된 알고리즘 모형을 성능 결과로 대신하지 않는다. 원본 압축파일과 원본 소스의 SHA-256은 `tests/fixtures/resource-efficiency-baseline.json`, 수정 후 소스 해시는 측정 JSON에 있다. 이 fixture는 테스트 전용이며 앱이 로드하지 않는다.

시간 측정은 조건별 준비 실행 2회 후 7회 측정의 중앙값이다. 연산 횟수 계측은 시간 측정과 분리했고, 결과 데이터의 동일성은 별도로 비교했다. 메모리는 조건별 별도 Node 프로세스 5개를 사용해 같은 자료를 생성하고 명시적 GC 후 유지된 JS 힙 증가량을 비교했다. 프로세스 CPU 시간, 시간 샘플 전체, RSS·external 값도 원자료에 남겼다.

환경: Linux x64, Node.js v22.16.0, V8 12.4.254.21-node.26, Intel Xeon Platinum 8573C, 보고된 논리 CPU 5개. 공유 실행 환경이므로 일시 정지·스케줄링·JIT·GC에 따른 변동이 있다. 특정 실행의 속도 배율을 운영 환경 보장치나 CI의 고정 통과 기준으로 사용하지 않는다. 특히 원본 6,000블록 시간에는 큰 이상치가 있으므로 7개 샘플을 함께 제공한다.

| 재현 작업 | 원본 시간 중앙값 | 수정 후 중앙값 | 시간 이외의 확인 지표 |
|---|---:|---:|---|
| 협업 트리 1,000블록 | 8.893ms | 1.055ms | 기존 노드 방문 500,500 → 1,000 |
| 협업 트리 3,000블록 | 66.928ms | 3.764ms | 기존 노드 방문 4,501,500 → 3,000 |
| 협업 트리 6,000블록 | **375.229ms** | **6.125ms** | 기존 노드 방문 18,003,000 → 6,000 |
| 2,500블록 로컬 스냅샷 적용 | **65.891ms** | **3.306ms** | 문서 서명 생성 2 → 0 |
| 1,000개 순서 복구 검증 | 3.737ms | 1.395ms | 순차 비교 500,500 → Set 조회 1,000 |
| 5,000개 순서 복구 검증 | 93.127ms | 3.698ms | 순차 비교 12,502,500 → Set 조회 5,000 |
| 10,000개 순서 복구 검증 | **257.482ms** | **14.347ms** | 순차 비교 50,005,000 → Set 조회 10,000 |
| 구조화 편집 이력 100회 기록 | **127.679ms** | **89.454ms** | clone 호출 400 → 200 |

48개 구조화 블록을 동일하게 편집한 뒤 유지되는 힙 증가량의 프로세스 간 중앙값은 **8,416,056바이트(8.026MiB) → 5,645,384바이트(5.384MiB)**였다. 해당 재현에서 약 **32.9% 감소**했으며 양쪽의 이력 깊이·논리적 보유 바이트는 동일했다. 이력을 비우고 외부 확인용 clone 참조도 제거한 뒤 측정한 작은 잔여 증가량도 원자료에 있다.

이 수치를 “앱 전체 메모리가 32.9% 감소했다”, “메모리 누수가 모두 없어졌다”, “서버 처리량이 61배 증가했다”로 확대 해석하지 않는다. 프런트엔드 함수의 미세 벤치마크이며, 서버·DB·전체 DOM 렌더링·수일간 장시간 유휴 동작의 통합 성능 측정이 아니다. 힙, 프로세스 RSS, external 메모리는 서로 다른 지표다. [외부 자료 3, 4]

원자료: `results/resource-benchmark.json`.

## 4. 기능·보안 회귀 결과

### 4.1 원본/수정본의 동일 명령 비교

```sh
node --experimental-strip-types --test --test-concurrency=4 tests/*.node.test.mjs
```

| 버전 | 실행 결과 수 | 통과 | 실패 | 취소/건너뜀 |
|---|---:|---:|---:|---:|
| 원본 압축파일 그대로 추출 | 1,212 | 1,195 | 17 | 0 / 0 |
| 수정본 | 1,264 | 1,247 | 17 | 0 / 0 |

실패 테스트 이름 집합의 추가·삭제는 모두 0이다. 원래 테스트 파일은 수정하거나 제거하지 않았고, 실패하는 단언을 완화하여 통과시키지도 않았다. 이 명령은 환경 제약 아래 실행 범위를 넓히기 위한 보조 검증이다. 원본의 공식 `npm test` 또는 지원 런타임에서의 검증을 대체했다고 간주하지 않는다.

원래 Node 로더만 사용한 초기 비교에서는 양쪽에 67개 실패가 있었으나, TypeScript 직접 실행을 추가하면서 모듈 로딩이 가능해진 테스트들이 실행되어 위와 같은 최종 비교가 되었다. 두 실행의 테스트 수 차이는 일부 파일이 로드되지 못하면 내부 개별 테스트까지 집계되지 않는 데에도 영향을 받는다.

기록: `results/regression-comparison-strip.json`, `logs/baseline-strip.log`, `logs/modified-strip.log`.

### 4.2 새로 추가한 Node 회귀 52건 — 모두 통과

테스트에는 평면/중첩 트리, 버전·HTML·첨부 메타데이터, 입력 불변성, ID 중복, 빈 입력과 iterable, 부모 순환·고아·깊이 127/128/129/140, 500회 결정적 무작위 트리 비교가 포함된다. 로컬/원격/복구 스냅샷의 상태·렌더링 요청·포커스·이력 효과를 비교하고 실제 제목 제한 모듈의 160/161자 경계도 검사한다.

순서 복구에서는 대형 역순 입력, 다양한 비정상 payload, 500회 결정적 무작위 비교, 실제 draft-store 공개 API의 저장/로드·계정 범위 분리·오래된 승인과 정확한 승인·스토리지 용량 오류 및 잘못된 payload에서 원본 저장 바이트 보존을 검사한다.

편집 이력에서는 native structuredClone 및 JSON fallback 각각의 외부 참조 분리, undo/redo, 새 편집의 redo 제거, 묶음 기록, 제한/초과 크기/빈 변경, 페이지 전환을 검사한다. 각 복제 방식에서 결정적 무작위 조작 2,000회씩 총 4,000회 비교하며 매 단계의 결과·이력 상태·peek를 확인한다.

`app.js` 함수 테스트의 UI 주변은 명시적 spy이다. 실제 DB 저장·네트워크·모든 UI 이벤트를 통째로 실행하는 테스트라고 설명하지 않는다.

### 4.3 실제 Chromium 구성요소 검사 23건 — 모두 통과

Chromium 144.0.0.0에서 실제 JS 엔진과 DOM을 사용했다. 수정 함수의 3,000블록 평면/중첩 재현, 스냅샷 출처별 동작, 실제 제목 제한, 10,000개 순서 복구, 비정상 입력 거부, native/JSON fallback 각각 1,000회 이력 조작 비교, clone 횟수를 검사했다.

원본의 변경하지 않은 HTML sanitizer도 실제 DOM에서 실행해 script/SVG와 이벤트 속성 제거, 위험 링크 거부, 허용 링크 속성·스타일·iframe 출처, 체크박스와 details 작동, AI 제어 요소의 명시적 허용 여부를 검사했다. 이 검사는 제한된 대표 입력 집합이며 포괄적인 보안 감사나 모든 XSS 변종의 부재 증명은 아니다.

이 환경은 브라우저의 HTTP/localhost 탐색이 `ERR_BLOCKED_BY_ADMINISTRATOR`로 차단되어 `set_content`와 메모리 내 평가로 구성요소를 실행했다. 브라우저 정책을 변경하지 않았다. 로그인한 실제 앱 화면 전체 또는 서버 응답을 연결한 E2E가 아니다.

기록: `results/browser-regression.json`, `logs/browser-regression.log`.

### 4.4 끝까지 실행하지 못한 공식 명령

| 명령 | 실제 결과 |
|---|---|
| `npm ci --offline --no-audit --no-fund` | EBADENGINE: 실제 Node 22.16.0이 원본 지원 조건 밖 |
| `npm test` | lockfile 검사 통과 후 `vitest: not found` |
| `npm run build` | Mermaid 패키지 다운로드 DNS 오류 `EAI_AGAIN`; 전체 빌드 완료 못 함 |
| `npm run verify:data-loss` | 필요한 tsx 실행 의존성 부재로 중단 |
| `npm run verify:security` | tsx 모듈 부재로 중단 |
| `npm run verify:collaboration` | tsx 모듈 부재로 중단 |
| `npm run lockfile:check` | **통과: 352개 resolved URL 검사** |

원본 런타임 조건 `^22.23.2 || ^24.18.1 || >=26.5.1` 및 npm `>=10.9.0`, `.npmrc`, `package.json`, `package-lock.json`은 바꾸지 않았다. 버전 조건을 낮추거나 설치 스크립트/무결성 검사를 우회하지 않았다. 의존성이 없어 공식 명령을 완료하지 못한 상황을 통과로 집계하지 않는다.

수정 JS 3개 및 Node 하네스/테스트/벤치마크 3개에 `node --check`를 실행해 모두 통과했다. 브라우저 검증 Python 스크립트의 구문 검사도 통과했다. 정적 구문 검사는 의미·동작·보안의 완전한 검증이 아니다.

### 4.5 원본에서부터 동일하게 실패한 17개 결과

9개는 모듈/로더·실행 의존성 제약, 8개는 소스 패턴 또는 스키마 기대값의 단언 불일치였다. 후자에는 custom-icon 경로 개수 5 대 4, 백업 스키마의 `custom_icon_page_publications` 분류, 인증/복구/import/SSRF 소스 패턴 등이 포함된다. 이것만으로 기존 코드가 안전하다거나 테스트만 낡았다고 단정하지 않는다. 이번 성능 패치와 별개로 원본 코드와 테스트 기대값을 대조하여 검토할 사항이다.

| 번호 | 실패 이름 | 관측 분류 |
|---:|---|---|
| 1 | `tests/ai-chat-timestamp-integrity.node.test.mjs` | 모듈/로더 의존성 실행 제한 |
| 2 | `the HTTP reproduction demonstrates legacy cross-user disclosure and fixed isolation` | 모듈/로더 의존성 실행 제한 |
| 3 | `custom icon mutations revalidate authentication inside the storage transaction` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 4 | `authentication route source retains all hardened ordering guarantees` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 5 | `tests/backup-metadata-integrity.node.test.mjs` | 모듈/로더 의존성 실행 제한 |
| 6 | `every created database table has an explicit backup-scope classification` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 7 | `identity-rebinding reproducer proves vulnerable and fixed states` | 모듈/로더 의존성 실행 제한 |
| 8 | `standalone reproduction shows the vulnerable collision and remediated rejection` | 모듈/로더 의존성 실행 제한 |
| 9 | `bookmark fetch path preserves the SSRF, redirect, port, pinning, deadline, and body guards` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 10 | `custom icon reads require authentication, ownership or an owner-controlled shared-page publication, and private caching` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 11 | `workspace restore carries and revalidates auth, device-session, and workspace-generation scope` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 12 | `read mode reuses the existing secured bookmark preview API without changing save serialization` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 13 | `standalone reproduction proves the vulnerable and corrected backup states` | 모듈/로더 의존성 실행 제한 |
| 14 | `the standalone reproduction demonstrates the metadata gap and the fail-closed remediation` | 모듈/로더 의존성 실행 제한 |
| 15 | `bookmark preview modes share the same egress policy and translated IPv6 is classified` | 원본부터 동일한 소스/스키마 단언 불일치 |
| 16 | `tests/structured-metadata-integrity.node.test.mjs` | 모듈/로더 의존성 실행 제한 |
| 17 | `tests/theme-preference-persistence.node.test.mjs` | 모듈/로더 의존성 실행 제한 |

## 5. 원본 기능·보안·데이터 보존을 위한 범위 제한

운영 코드에서 수정한 파일은 `public/app.js`, `public/draft-store.js`, `public/editor-history.js`뿐이다. 서버 인증·권한/공유 범위·CSRF/Origin·비밀번호/패스키·세션·보안 헤더·SSRF·업로드·HTML sanitizer·DB 스키마/마이그레이션·백업/복원·WebSocket 수신 크기 및 작업 상한 코드는 원본 바이트를 유지한다. 원본 파일을 삭제하지 않았다.

관련 기존 회귀 테스트에는 협업 연결/업그레이드 예약/작업 큐·바이트 상한, 권한 재검증, 큰 상태 처리의 동시성 제한, WebSocket 경계, 편집 이력과 초안 무결성 등이 포함되어 있다. 이미 있는 제한 장치를 없애는 방향의 성능 변경은 하지 않았다. 전체 시스템의 나머지 자원 문제나 장시간 누수가 없다는 결론은 내리지 않는다.

운영 소스 변경의 SHA-256과 바이트 수는 `results/source-changes.json`, 검토용 diff는 `source-diff.patch`에 있다. 기존 원본 테스트 파일, 환경 설정, lockfile은 그대로 보존된다. 추가된 파일은 재현·검증·보고 용도이고 앱 초기화 경로에 import되지 않는다.

## 6. 재실행 방법

프로젝트 루트에서 변경 지점의 독립 검증과 성능 재현:

```sh
node --test tests/resource-efficiency.node.test.mjs
node --expose-gc scripts/benchmark-resource-efficiency.mjs > resource-benchmark.local.json
```

실제 브라우저 구성요소 검증은 Python Playwright 및 Chromium이 설치된 환경에서 실행한다. `--chromium`은 로컬 실행 파일 경로에 맞게 지정하며 생략 시 PATH/Playwright 설치를 사용한다. 프로젝트 런타임 의존성을 바꾸는 단계는 아니다.

```sh
python scripts/verify-resource-efficiency-browser.py --chromium /usr/bin/chromium --output browser-regression.local.json
```

지원되는 Node/npm와 원래 lockfile 의존성, 테스트에 필요한 정상 환경이 갖추어진 뒤 공식 검증을 수행한다. 실패를 그대로 조사하고 `--force`나 engine-strict 비활성화로 우회하지 않는다.

```sh
npm ci
npm test
npm run verify:security
npm run verify:data-loss
npm run verify:collaboration
npm run build
```

데이터베이스를 연결한 실제 로그인·편집·저장 후 새로고침·재접속/복구·undo/redo·협업 동시 편집·권한 강등/계정 전환·백업 복원·첨부/표/수식/차트 표시의 최종 통합 확인은 별도로 필요하다. 사용자 실제 데이터 대신 검증용 데이터베이스와 복사본으로 실행해야 한다.

원본과 결과 ZIP의 보존 여부를 검사한다. 이 검증은 압축을 풀거나 `.git`에 쓰지 않는다.

```sh
python scripts/verify-resource-efficiency-archive.py /path/to/BrainVault.zip /path/to/BrainVault_resource_optimized.zip --output archive-verification.local.json
```

## 7. 증거 파일 안내

이 보고서 디렉터리는 `docs/performance/resource-efficiency-2026-09-15/`이다. `results/`에는 성능의 모든 샘플, 동일 조건 회귀 비교, 브라우저 결과, 공식 명령의 종료 상태, 구문 검사, 소스 해시와 `.git` 해시 목록이 있다. `logs/`에는 원본과 수정본의 전체 최종 비교 로그, 새 테스트, 브라우저 검사, 설치/빌드/보안 검증의 실제 출력이 있다. 최종 ZIP 파일 전체 해시와 압축 후 `.git` 검사 결과는 ZIP 밖에 별도 제공하여 자기 참조 해시 문제를 피한다.

## 8. 외부 자료와 해석 기준

외부 문서는 최적화/메모리 측정 해석의 기준으로 사용했으며 이 프로젝트의 성능 개선 수치를 대신하는 근거가 아니다. 프로젝트별 수치와 통과 여부의 근거는 제공된 로컬 실행 로그·JSON이다.

1. MDN, Set — 평균 sublinear 접근, includes 대비 has의 성능 및 동등성 규칙. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Set
2. MDN, Window.structuredClone() — 객체의 깊은 복제 의미와 한계. https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone
3. Node.js, Understanding and Tuning Memory — heapUsed·heapTotal·RSS·external 및 GC 해석. https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory
4. Chrome DevTools, Fix memory problems — 메모리 증가, 할당 빈도, GC 및 실제 누수 구분. https://developer.chrome.com/docs/devtools/memory-problems
5. Node.js, Don't Block the Event Loop — 입력 크기에 따른 동기 연산량과 긴 작업의 영향. https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
