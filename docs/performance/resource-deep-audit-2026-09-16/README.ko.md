# BrainVault CPU·메모리 자원 심층 재현·수정·회귀 검증 보고서

검증일: 2026-09-16 · 대상: 이번에 첨부된 `BrainVault.zip`

## 1. 결론과 검증 한계

실제로 재현한 자원 낭비 **두 종류**를 수정했다. 첫째는 최종 검색 요약 20,000 UTF-16 코드 유닛만 필요하지만 전체 메타데이터를 큰 문자열로 합친 다음 잘라내던 경로다. 둘째는 이미 유효한 ID가 있는데도 기본값 인수 평가 때문에 사용하지 않을 UUID를 생성하던 경로다.

기존 운영 소스 **8개만 수정**, 운영용 보조 모듈 **2개 추가**했다. 기존 기능의 저장 형식, 전체 메타데이터 정규화, 보안 검증, ID 생성 알고리즘, 종속성, 런타임 보안 하한은 변경하지 않았다. 원본 테스트를 수정·삭제하거나 통과시키기 위해 기대값을 완화하지 않았다.

**회귀 비교 결과는 양호하지만 전체 배포 승인/보안 무결성 보증은 아니다.** 원본부터 실패하는 테스트 17건이 있으며, 지원 런타임·의존성·외부 네트워크·DB가 갖춰지지 않아 공식 전체 테스트, 빌드, 로그인/API/DB를 포함한 종단간 테스트를 완료하지 못했다. 확인할 수 없는 부분을 통과로 기록하지 않았다.

원본 `node --experimental-strip-types --test tests/*.node.test.mjs` 결과는 **1,342건 중 1,325 통과·17 실패**다. 수정 후 기존 테스트만 실행해도 같은 결과였다. 신규 98건을 합친 최종 실행은 **1,440건 중 1,423 통과·17 실패**다. 기존 통과 테스트 이름의 다중집합이 최종 통과 목록에 모두 포함되고, 실패 목록도 원본과 일치한다. 신규 Node 테스트 98건, 신규 Chromium 컴포넌트 테스트 92건, 기존 다른 자원 최적화 브라우저 회귀 테스트 재실행 23건은 모두 통과했다.

## 2. 입력, 기준본, 변경 통제

입력 ZIP SHA-256:

```text
1a017a8c791d615b59b9836b9b8ff1a95df31abef239def164efc6a6d4816f17
```

- 원본 ZIP의 모든 기존 항목을 유지한다. `.git`에 Git 쓰기 명령을 실행하지 않는다.
- 이번 기준본 8개 소스는 `tests/fixtures/resource-deep-audit-baseline.json`에 원본 내용·파일별 SHA-256과 함께 보관했다. 테스트가 각 해시를 검증한다.
- 실제 변경 목록과 해시는 `change-manifest.json`, 사람이 읽을 수 있는 차이는 `source-changes.diff`에 있다. 기존 CRLF 줄바꿈을 유지했다. diff만 비교 편의를 위해 LF로 정규화했다.
- 기존 감사 보고서/fixture는 모두 보존하되 이번 결과로 재사용하지 않았다. 이번 보고서와 로그는 `docs/performance/resource-deep-audit-2026-09-16/`에 분리했다.
- `.git`은 **44개 ZIP 항목: 파일 28개, 디렉터리 16개**다. 작업 사본의 28개 파일 해시를 원본과 비교했고, 최종 ZIP에서는 압축 해제 내용뿐 아니라 ZIP 메타데이터와 원시 local record(헤더·압축 바이트·descriptor 포함)를 비교한다. 최종 검증 결과는 ZIP과 함께 제공하는 `BrainVault_archive_verification.json`이다.

## 3. 재현 1 — 최종 길이 제한 전에 전체 문자열을 생성

### 원인과 영향

AI 대화, 아코디언, 데이터베이스, 시간표, 간트 요약 함수가 배열 전체를 만들거나 모든 필드를 순회해 `.join(...)`한 후 `.slice(0, 20000)` 했다. 서버의 AI 대화·아코디언에도 같은 패턴이 있었다. 출력이 20,000자로 제한돼도 그 이전의 큰 문자열 생성 및 일부 필드 가공 비용은 그대로 든다.

이번 V8 실험에서는 잘린 요약만 유지해도 큰 연결 문자열이 힙에 남는 현상도 관측됐다. 이는 해제 불가능한 영구 누수를 입증한 것이 아니라, **필요한 20,000자보다 훨씬 큰 backing 문자열을 불필요하게 보유하는 현상**이다. 실험은 요약을 놓은 뒤의 GC 수치도 기록한다.

### 수정

`joinSummaryPrefix`가 정규화된 문자열 iterator에서 기존 순서대로 필요한 접두부만 조립한다. 남은 출력 길이를 넘는 나머지 필드의 검색용 가공은 하지 않는다. 전체 메타데이터의 정규화는 iterator를 사용하기 **전에 원래대로 모두 실행**한다.

AI 대화는 원래의 두 줄바꿈 `\n\n`을, 나머지는 `\n`을 보존한다. 데이터베이스는 원래 제목/속성명 빈 문자열의 구분자는 남기고 빈 셀만 제외했으므로, 다른 블록과 달리 `skipEmpty: false`를 사용한다. 길이 제한은 기존 JavaScript `.slice()`와 동일한 UTF-16 코드 유닛 기준이며, 한글·emoji·고립 surrogate·NUL·부분 구분자 경계까지 차등 테스트했다.

**요약만 최적화한다.** AI 답변/질문, 아코디언 본문, 데이터베이스 행/셀, 일정의 메모를 20,000자로 잘라 저장하는 변경이 아니다. 캐시나 전역 입력 참조도 추가하지 않았다. 트리뷰 요약은 첨부본에서 이미 최적화돼 있었으므로 이번에는 변경하지 않았다.

### 결정론적 연산량 재현

시험 JSON은 모두 4 MiB 이하이다. 이는 크기 조건 확인이며, 실제 API가 해당 데이터를 받아 DB에 저장하는 전체 검증을 대신하지 않는다. 원본/수정본은 같은 fixture를 사용하고 요약 문자열이 완전히 같음을 먼저 확인했다. 필드 계수는 요약 조립 경로만 계측하며 전체 메타데이터 정규화 횟수를 의미하지 않는다.

| 블록 | 시험 JSON UTF-8 바이트 | 원본 join 결과 길이 | 수정 조립 길이 | 요약 필드 방문 수 |
|---|---:|---:|---:|---:|
| AI 대화 | 1,252,851 | 1,251,455 | 20,000 | 177 → 6 |
| 아코디언 | 403,707 | 400,603 | 20,000 | 101 → 7 |
| 데이터베이스 | 3,218,349 | 3,201,696 | 20,000 | 1609 → 19 |
| 시간표 | 148,456 | 135,620 | 20,000 | 402 → 62 |
| 간트 | 70,519 | 55,346 | 20,000 | 1001 → 362 |

길이는 UTF-16 코드 유닛이다. 위 결정론적 테스트는 하드웨어 성능이나 임의의 시간 임계값에 의존하지 않는다.

## 4. 재현 2 — 버려지는 UUID 기본값 연산

다음과 같은 호출의 기본값 표현식은 첫 번째 인수가 유효해도 먼저 평가된다:

```js
safeId(item.id, createId("accordion-item"))
```

유효성/정규화 결과가 비었을 때만 **기존 `createId()`**를 호출하도록 바꿨다. 아코디언·트리뷰의 `safeId`, 시간표·간트의 문자열 정규화에 적용했다. ID 생성 함수 자체, 사용 가능한 환경에서의 암호학적 UUID 생성, 기존 fallback, 중복 ID 처리, 길이 제한은 그대로다. 누락된 ID에 새 ID를 주는 기능은 유지한다.

| 블록 | 유효한 ID를 가진 항목 수 | 원본 UUID 호출 | 수정 UUID 호출 |
|---|---:|---:|---:|
| 아코디언 | 50 | 51 | 1 |
| 시간표 | 200 | 201 | 1 |
| 간트 | 200 | 202 | 2 |
| 트리뷰 | 300 | 301 | 1 |

각 수치는 정규화 1회 기준이다. 잔여 1~2회는 원래의 기본 데이터 생성 과정이다. 추가 변경 위험을 줄이기 위해 이 경로는 건드리지 않았다. 새 ID는 무작위 값이므로 원본·수정본에서 특정 난수 값 자체가 같을 것을 요구하지 않고, 형식·고유성·기존 ID 보존·중복 해소·누락 처리의 계약을 검증했다.

## 5. CPU 및 메모리 실측

### 환경과 방법

- Node `v22.16.0`, V8 `12.4.254.21-node.26`, `linux`/`x64`.
- CPU: `Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz`. 공유 실행환경이므로 스케줄링·GC 노이즈가 있을 수 있다.
- Chromium `144.0.7559.96`, TypeScript 5.8.3.
- CPU/경과시간: 두 버전 각각 20회 예열 후, **표본 7개 × 표본당 30회**. 원본/수정본 측정 순서를 번갈아 실행한다. 시간 측정에는 계측용 카운터를 넣지 않은 실제 함수 본문을 사용한다. 전체 정규화 비용을 포함한다.
- CPU 시간은 `process.cpuUsage()`의 user+system 합이다. 경과시간과 같지 않으며 GC 작업 등에 따라 달라진다. 아래는 각각의 표본 중앙값이다.
- 메모리: 버전별·블록별 **별도 Node 프로세스 5회**, `--expose-gc`, 서로 다른 입력으로 만든 **요약 24개만 유지**. 입력 참조는 놓고 GC 전후 `heapUsed`, `heapTotal`, RSS, external, arrayBuffers를 기록한다. 두 버전의 결과 해시가 같은지 확인한다.

### 요약 1회당 시간 (밀리초)

| 블록 | 원본 경과시간 | 수정 경과시간 | 원본 CPU 시간 | 수정 CPU 시간 |
|---|---:|---:|---:|---:|
| AI 대화 | 6.1601 | 0.1488 | 6.5979 | 0.1474 |
| 아코디언 | 2.5979 | 0.1356 | 2.7651 | 0.1352 |
| 데이터베이스 | 13.7373 | 0.3802 | 13.7924 | 0.5876 |
| 시간표 | 1.3487 | 0.5190 | 1.5775 | 0.6053 |
| 간트 | 1.3798 | 1.2237 | 1.4932 | 1.2364 |
| 트리뷰 | 0.8098 | 0.6394 | 0.8136 | 0.6390 |

모든 정규화 단독 측정과 표본 원자료도 `benchmark.json`에 공개했다. 수정하지 않은 AI 대화/데이터베이스 정규화 단독 시간도 약간 변동했으므로, 작은 시간 차이를 모두 개선/퇴행으로 해석하지 않는다. 트리뷰의 이번 차이는 UUID 불필요 호출 제거 영향이며 과거 요약/트리 인덱스 개선을 새 성과로 계산한 것이 아니다.

### 요약 24개 유지 시 추가 힙 중앙값

| 블록 | 원본 추가 heapUsed 바이트 | 수정 추가 heapUsed 바이트 | 감소율 |
|---|---:|---:|---:|
| AI 대화 | 30,012,168 | 460,368 | 98.47% |
| 데이터베이스 | 76,738,448 | 376,464 | 99.51% |

이는 **기준 GC 이후 대비 추가 힙**이며 전체 프로세스 RAM/RSS, 실제 사용자 세션 24개, 전체 서버 부하를 뜻하지 않는다. Node/V8 버전·문자열 내용·입력 크기·동시 작업에 따라 절대값은 바뀐다. 운영체제 allocator 때문에 RSS가 즉시 감소하지 않을 수 있으므로 RSS와 JS 힙을 혼동하지 않았다. 본 결과로 앱 전체가 같은 비율로 빨라지거나 메모리를 절약한다고 주장하지 않는다.

## 6. 회귀 테스트

| 구분 | 전체 | 통과 | 실패 | 비고 |
|---|---:|---:|---:|---|
| 원본 기존 Node suite | 1,342 | 1,325 | 17 | 수정 전 동일 환경 |
| 수정본 기존 Node suite | 1,342 | 1,325 | 17 | 신규 테스트 추가 전 |
| 수정본 최종 Node suite | 1,440 | 1,423 | 17 | 기존 1,342 + 신규 98 |
| 신규 Node 집중 실행 | 98 | 98 | 0 | 위 최종 suite에 포함, 중복 합산 금지 |
| 신규 Chromium 컴포넌트 | 92 | 92 | 0 | 실제 DOM/native ESM |
| 기존 자원 최적화 Chromium 검사 재실행 | 23 | 23 | 0 | 기존 스크립트를 수정 없이 재실행 |
| 수정 JS/스크립트 문법 및 신규 helper strict 타입 검사 | 해당 파일 | 통과 | 0 | 전체 프로젝트 빌드가 아님 |

### 새로 추가한 Node 검증 범위

원본 소스 8개의 해시, JS/TS helper 출력 동일성, 구분자/빈 문자열/UTF-16 경계, iterator 조기 종료 및 finally 정리, iterator의 선행 오류 전파, 4,000개의 seeded UTF-16 차등 사례, 5개 요약 함수의 7개 언어 × 100개 시나리오(3,500회) 비교, 정상/대용량/비정상/누락 입력, 전체 정규화 및 입력 불변성, 데이터베이스 빈 헤더와 셀 타입, 원본·수정 서버 요약 함수 본문, 반복 정규화와 ID 보존, 빈/중복/과도하게 긴/prototype 형태 ID를 검증했다. 결정론적 요약 필드 방문·조립 길이 검사도 포함한다.

서버 요약 테스트는 **실제 함수 본문을 분리해 실행**하되 변경하지 않은 의존 정규화 함수를 주입한다. `zod`, 아이콘 스키마, Express/DB까지 불러오는 서버 통합 테스트라고 주장하지 않는다. 서버 검증/정규화 소스가 이번 변경에서 유지됨은 별도로 비교한다.

### 새로 추가한 실제 브라우저 검증 범위

6개 블록의 native ESM과 실제 의존 모듈 로딩, 정상/대용량 요약과 전체 메타데이터 동일성, 7개 언어, 초기 DOM/ARIA/추출 데이터, 제목 편집, dirty 콜백, 요약 접두부 밖의 본문/셀 편집, 저장된 HTML 형태 문자열의 비실행, 읽기 전용 이벤트 처리, 기존 ID 보존 및 새 ID 생성을 검사했다.

이 환경은 Chromium의 탐색 정책으로 일반 URL 이동이 차단돼 있다. 정책을 해제하지 않고 `about:blank`에서 실제 소스를 **import 경로만 Blob URL로 바꿔 native ESM으로 실행**했다. 따라서 배포된 HTTP 정적 자산 서빙/CSP/인증/DB의 종단간 검증이 아니다. `about:blank`는 secure context가 아니므로 브라우저에서는 원래의 UUID fallback이 실행되며, 보안 컨텍스트의 UUID 선택/함수 보존은 Node 및 소스 검사 범위에 해당한다. 운영 코드의 CSP나 난수 생성 보안은 바꾸지 않았다.

### 원본부터 존재한 실패 17건

로그상 9건은 `tsx`/`zod` 누락 또는 native TypeScript 실행의 `.js`→`.ts` 해석 제약이고, 8건은 소스 문자열/정규식/개수·테이블 목록 기대값 불일치다. 이 불일치를 이번 최적화가 만들지는 않았지만, 모두 무해한 낡은 테스트라고 단정할 근거도 없다. 보안·백업 관련 실패가 포함되므로 정식 의존성/런타임 환경에서 별도 확인해야 한다.

1. `tests/ai-chat-timestamp-integrity.node.test.mjs`
2. `the HTTP reproduction demonstrates legacy cross-user disclosure and fixed isolation`
3. `custom icon mutations revalidate authentication inside the storage transaction`
4. `authentication route source retains all hardened ordering guarantees`
5. `tests/backup-metadata-integrity.node.test.mjs`
6. `every created database table has an explicit backup-scope classification`
7. `identity-rebinding reproducer proves vulnerable and fixed states`
8. `standalone reproduction shows the vulnerable collision and remediated rejection`
9. `bookmark fetch path preserves the SSRF, redirect, port, pinning, deadline, and body guards`
10. `custom icon reads require authentication, ownership or an owner-controlled shared-page publication, and private caching`
11. `workspace restore carries and revalidates auth, device-session, and workspace-generation scope`
12. `read mode reuses the existing secured bookmark preview API without changing save serialization`
13. `standalone reproduction proves the vulnerable and corrected backup states`
14. `the standalone reproduction demonstrates the metadata gap and the fail-closed remediation`
15. `bookmark preview modes share the same egress policy and translated IPv6 is classified`
16. `tests/structured-metadata-integrity.node.test.mjs`
17. `tests/theme-preference-persistence.node.test.mjs`

자세한 로그: `logs/baseline-node.log`, `logs/modified-existing-node.log`, `logs/final-node.log`. 테스트 이름 다중집합 비교 결과: `regression-comparison.json`.

## 7. 공식 검증을 완료하지 못한 이유

프로젝트가 선언한 Node 엔진 범위는 `^22.23.2 || ^24.18.1 || >=26.5.1`이고 `.npmrc`의 `engine-strict=true`를 유지했다. 현재 실행환경은 Node 22.16.0이다. `npm ci --ignore-scripts --offline`은 `EBADENGINE`으로 실패했다. 의존성을 우회 설치하거나 lockfile/보안 하한을 낮추지 않았다.

실제로 실행한 공식 명령 결과:

| 명령 | 결과 |
|---|---|
| `npm test` | lockfile registry 검사 352건 통과 후 `vitest: not found`로 중단 |
| `npm run build` | Mermaid vendor 단계에서 `registry.npmjs.org` DNS `EAI_AGAIN`; 전체 `tsc` 단계에 도달하지 못함 |
| `npm run verify:data-loss` | 내부 실행에 필요한 `tsx` 없음 |
| `npm run verify:collaboration` | `tsx` 없음 |
| `npm run verify:security` | `tsx` 없음 |

명령별 종료 코드와 로그 경로는 `standard-commands.json`에 있다. MariaDB 및 로그인된 실제 애플리케이션 환경도 없으므로 저장/복구/공유/동시편집의 전체 네트워크 시나리오, 장시간 힙 프로파일, 실제 운영 동시접속 부하는 미검증이다. 따라서 이번 파일은 **확인된 개선과 회귀 근거를 포함한 수정본**이지 전체 배포 준비 완료 인증본이 아니다.

## 8. 변경 파일과 보안 영향 범위

기존 변경 파일:

```text
public/ai-chat-block.js       요약만 변경
public/accordion-block.js     요약 + 유효 ID의 불필요 UUID 호출 제거
public/database-block.js      요약만 변경
public/timetable-block.js     요약 + 유효 ID의 불필요 UUID 호출 제거
public/gantt-block.js         요약 + 유효 ID의 불필요 UUID 호출 제거
public/treeview-block.js      유효 ID의 불필요 UUID 호출만 제거
src/lib/ai-chat.ts            요약만 변경
src/lib/accordion.ts          요약만 변경
```

신규 운영 파일: `public/summary-prefix.js`, `src/lib/summary-prefix.ts`.

새 helper를 서버 dist 경로에서 브라우저 디렉터리로 교차 import하지 않도록 양쪽에 작은 모듈을 두고 출력 동일성을 테스트했다. 종속성은 추가하지 않았다. 인증·권한·세션·암호화·CSP·입력 스키마·SSRF·파일 경로 방어·DB 트랜잭션·마이그레이션·백업 형식·저장 및 복구 코드·협업 프로토콜을 수정하지 않았다. 정규화를 뒤로 미루거나 생략하지 않았고 입력을 캐싱하지 않는다.

이러한 변경 범위 통제와 회귀 검사는 위험을 줄이는 근거지만, 보안 코드가 무변경이라는 사실만으로 애플리케이션 전체가 안전함을 증명하지는 않는다.

## 9. 재현 명령

원본/수정본을 서로 다른 디렉터리에 풀고, 원본과 수정본의 `.git`에 쓰기 작업을 하지 않는다. 실제 배포 대상은 프로젝트의 Node 엔진 범위를 충족시켜야 한다.

이번 제한 환경과 같은 독립 실행 검사:

```sh
node --experimental-strip-types --test tests/*.node.test.mjs
node --experimental-strip-types --test tests/summary-prefix-resource.node.test.mjs tests/normalizer-uuid-resource.node.test.mjs
node --experimental-strip-types scripts/benchmark-resource-deep-audit.mjs --output benchmark-rerun.json
python scripts/verify-resource-deep-audit-browser.py --browser /path/to/chromium --output browser-rerun.json
python scripts/verify-resource-efficiency-browser.py --chromium /path/to/chromium --output prior-browser-rerun.json
python scripts/verify-resource-deep-audit-archive.py ORIGINAL_BrainVault.zip BrainVault_resource_fixed.zip --output archive-rerun.json
```

Python 브라우저 검사는 Playwright와 Chromium 설치가 필요하다. 벤치마크 시간은 절대 임계값으로 판정하지 않으며 먼저 원본/수정 결과 동일성과 결정론적 계수를 확인한다.

지원 런타임과 정상 네트워크/의존성/테스트 DB를 준비한 배포 전 검증:

```sh
npm ci
npm test
npm run build
npm run verify:data-loss
npm run verify:collaboration
npm run verify:security
```

해당 명령의 기존 환경 설정/DB 요건은 원본 프로젝트 문서를 따른다. 본 보고서는 이러한 정식 실행을 성공했다고 간주하지 않는다.

## 10. 관련 공식 문서

외부 문서는 측정·언어 의미를 확인하는 참고 자료이고, 이 프로젝트의 문제 재현 근거는 첨부 로그/fixture/스크립트다.

1. Node.js, Don't Block the Event Loop: https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop
2. Node.js, `process.memoryUsage()` 및 `process.cpuUsage()`: https://nodejs.org/api/process.html
3. Node.js, Understanding and Tuning Memory: https://nodejs.org/learn/diagnostics/memory/understanding-and-tuning-memory
4. MDN, `Crypto.randomUUID()`의 보안 난수 UUID v4: https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID
5. MDN, `for...of`의 조기 종료 및 iterator 정리: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...of

기능/보안 무회귀를 절대 보증하지 않으며, 검증한 범위·실패·환경 제약·측정 원자료를 함께 제공한다.
