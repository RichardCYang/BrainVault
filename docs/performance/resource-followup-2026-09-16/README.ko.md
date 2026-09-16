# BrainVault CPU·메모리 자원 사용 후속 검증 및 수정 보고서

검증일: 2026-09-16 · 입력: `BrainVault.zip` · 원본 SHA-256: `332d9ab43bc74f865b0a46f13a02d57cbaf3140ce70f16a9518104cedb73ac50`

## 1. 결론과 검증 한계

재현된 문제를 세 영역에서 수정했다. 운영 코드 변경은 `src/lib/websocket.ts`, `src/lib/treeview.ts`, `public/treeview-block.js` 세 파일뿐이다. 전체 원본 파일은 보존하고, 기존 테스트·의존성·잠금 파일·보안 설정·데이터베이스 스키마는 변경하지 않았다. `.git`은 별도로 원본 바이트와 ZIP 메타데이터를 보존·검증한다.

**수정 전후 동일 조건 비교에서 새 실패는 없었다. 그러나 전체 기능·보안 검증이 전부 성공했다는 뜻은 아니다.** 원본부터 대체 Node 테스트 경로에서 17건이 실패했고, 수정본에서도 같은 17건이 실패했다. 여기에는 환경/로더 문제 9건과 기존 단언 실패 8건이 있다. 원본의 단언 실패를 모두 무해하거나 단순한 테스트 오류라고 확정하지 않았다. 이번 성능 수정과 관계없는 검사를 삭제하거나 기대값을 완화하지 않았다.

실행 환경은 Node v22.16.0, npm 10.9.2, V8 12.4.254.21-node.26, Linux x64, AMD EPYC 9V74 80-Core Processor이다. 프로젝트가 요구하는 Node 범위 `^22.23.2 || ^24.18.1 || >=26.5.1`에 미달한다. `npm ci --ignore-scripts --offline`는 `EBADENGINE`으로 중단됐고, `registry.npmjs.org` DNS 조회도 실패했다. 공식 빌드와 Vitest·DB 연동 통합 검증은 완료하지 못했다. 런타임 보안 하한을 낮추거나 `.npmrc`의 엄격한 엔진 검사를 끄지 않았다. 공식 Node 22.23.2 릴리스 자료는 참고문헌 [5]를 참조한다.

## 2. 재현된 문제와 수정

### 2.1 WebSocket: 사용이 끝난 대형 수신 버퍼의 장기 보유

**원인.** 수신 프레임을 조립하는 `readBuffer`는 기하급수적으로 커지지만, 프레임을 모두 소비해 읽을 데이터가 0바이트가 돼도 연결이 살아 있는 동안 최대 용량을 보유했다. 이는 무제한 누적 누수라기보다, 연결별 최고점 용량을 불필요하게 오래 유지하는 문제다.

**재현.** 연결에 1MiB 바이너리 메시지를 마스킹된 프레임으로 보내고 32KiB 단위로 수신했다. 원본은 메시지를 모두 처리한 뒤에도 연결당 2MiB를 보유했다. 8개 연결이면 유휴 수신 버퍼만 16MiB다. 결정적 시계 테스트에서는 60초 유휴 후에도 원본 용량이 유지됐다. 네이티브 타이머와 실제 TCP/HTTP Upgrade 연결에서도 큰 메시지를 처리한 뒤 원본/수정본의 차이를 확인했다.

**수정.** 버퍼가 64KiB를 초과하고 완전히 소비된 경우에만 5초 유휴 타이머를 예약한다. 타이머 실행 시 읽지 않은 데이터가 있으면 해제하지 않는다. 연속 프레임에서는 동일한 타이머를 `refresh()`로 재사용하고, 종료 경로에서는 취소한다. `unref()`로 정리 타이머만 남아 프로세스 종료를 막지 않도록 했다. 이 두 API의 동작은 Node 공식 문서 [1]에 근거한다.

부분 헤더·부분 페이로드, 분할 메시지, 처리 중인 비동기 핸들러의 데이터, 큐에 들어간 메시지는 삭제하지 않는다. 이미 복사된 페이로드/분할 메시지와 수신용 임시 버퍼가 독립적인지 테스트했다. 연결 자체도 닫지 않는다. 기존 마스킹·UTF-8·프레임·메시지·출력 큐 제한은 유지했다.

**절충.** 5초 이상 쉰 다음 다시 큰 프레임이 오면 버퍼를 재할당한다. 연속 수신 중에는 재사용하며, 작은 메시지에 추가 유휴 타이머를 만들지 않는다. 5초는 타이머 지연값으로, 이벤트 루프가 바쁘면 실제 콜백 실행은 늦어질 수 있다. 생산 환경 전체 부하에서 최적의 지연값을 검증한 것은 아니다.

### 2.2 TreeView: 같은 노드 목록을 반복 스캔하고 같은 인덱스를 반복 생성

**서버 재현.** 최대 300개 노드의 정적 HTML을 생성하면 자식 찾기가 전체 배열을 반복 검사하여 90,300번의 부모 ID 비교를 수행했다. 모든 노드에 메모가 있으면 메모 경로마다 ID→노드 맵을 다시 생성해 90,000개의 맵 항목을 만들었다.

**브라우저 재현.** 실제 Chromium DOM에서 평면 300노드 편집기를 만들 때 자식·형제 검색 과정의 전체 배열 부모 ID 비교가 180,300회였다. 렌더링 내부의 중복 형제 검색과 위치 찾기도 있었다.

**수정.** 해당 렌더/순회 호출의 정규화된 데이터에 대해서만 부모 ID→자식 배열 인덱스를 한 번 생성한다. 서버 메모 경로용 ID 인덱스도 메모가 있을 때 한 번만 만든다. 인덱스 구성은 각각 300개 노드 방문으로 끝나며, 기존 전체 배열 부모 비교는 제거된다. 브라우저의 형제 순서와 위치는 현재 순회 중인 배열/인덱스를 이용한다. `Map`의 평균 접근 시간에 관한 표준 요구는 [3]을 참조한다. 전체 렌더의 모든 비용이 O(n)이 됐다는 주장은 하지 않는다.

장기 전역 캐시는 추가하지 않았다. 구조 변경 핸들러는 현재 데이터로 다시 판단하고 편집기를 갱신한다. 오래된 부모 관계/노드 인덱스가 편집 이후에 사용되지 않는지 들여쓰기·내어쓰기·이동·삭제·자식 승계·추가를 실제 DOM에서 비교했다. 깊은 트리의 정규화, 경로 문자열 생성, 긴 HTML 출력 등 필요한 비용은 남는다.

### 2.3 TreeView 요약: 최종 20,000 단위만 필요하지만 수백만 단위를 먼저 생성

**원인.** 프런트엔드와 서버 모두 모든 메모/트리를 문자열로 합친 뒤 마지막에 `.slice(0, 20000)`했다. 이 제한은 이번에 새로 도입한 제한이 아니라 원본부터 있었던 요약 길이 제한이다.

**재현.** 300개 노드 × 8,000 UTF-16 코드 단위 메모로 전체 결합 문자열은 2,408,904 단위지만 최종 출력은 20,000 단위였다. 이 Node/V8 환경에서는 이러한 요약 24개만 보유해도 GC 후 큰 문자열의 메모리가 남는 현상이 재현됐다. 수정 전후 결과 문자열은 정확히 일치한다.

**수정.** 전체 입력 정규화와 보안상 길이/형태 검사부터 수행한 다음, 동일한 순서·줄바꿈으로 기존 상한의 접두부만 조립한다. 상한에 도달하면 불필요한 후속 순회/결합을 멈춘다. 원본 메모, 저장 메타데이터, 정적 HTML의 전체 메모 출력은 줄이지 않는다. 대형 메모 사례에서는 7번의 줄 추가 시도로 접두부가 완성된다.

19,999/20,000/20,001 경계와 이모지의 UTF-16 경계까지 원본 결과와 대조했다. 실제 노트 내용을 새로 잘라낸 것이 아니다. GC에서 객체의 도달 가능성이 중요한 이유는 [4]를 참조한다. 문자열 표현과 회수 정도는 엔진/버전에 따라 달라질 수 있으므로, 아래 수치를 모든 지원 런타임의 고정값으로 해석하지 않는다.

## 3. 성능 측정 결과

### 3.1 함수 수준 시간

다음 값은 워밍업 후 7개 표본, 표본당 10회 실행의 중앙값이며 단위는 ms/호출이다. 시간 측정에는 계수용 코드 삽입을 사용하지 않았다. CPU 시간은 `process.cpuUsage()`의 사용자+시스템 시간이며, V8 보조 스레드 활동 등이 포함될 수 있어 경과 시간과 같지 않다. 원자료와 모든 표본은 `resource-benchmark.json`에 있다.

| 실제 함수 / 입력 | 원본 경과 시간 | 수정 경과 시간 | 원본 CPU 시간 | 수정 CPU 시간 |
|---|---:|---:|---:|---:|
| 서버 HTML / 평면 300노드 | 6.628 | 1.273 | 8.242 | 2.320 |
| 서버 HTML / 균형 300노드 | 7.457 | 1.827 | 9.367 | 3.098 |
| 서버 HTML / 깊이 300 사슬 | 44.663 | 36.851 | 49.940 | 41.701 |
| 서버 요약 / 300 × 8,000 | 2.218 | 0.131 | 2.901 | 0.351 |
| 프런트엔드 요약 함수 / 300 × 8,000 | 2.564 | 0.478 | 3.747 | 0.941 |

프런트엔드 요약 함수의 위 시간은 Node에서 해당 실제 JS 모듈을 실행한 값이다. 별도의 실제 Chromium DOM 편집기 생성·부착·레이아웃 측정은 300노드, 7표본 중앙값 **41.5 → 35.8 ms**였다. 이 브라우저 측정은 앱 CSS나 로그인·서버를 포함하지 않는 컴포넌트 측정이다. DB 처리량, 전체 앱 반응 속도, 실사용자의 평균 CPU 절감률로 환산하면 안 된다. 실행 순서·JIT·GC·호스트 부하의 영향을 받는 시간값보다 반복 연산 횟수와 출력 동일성 검사를 더 강한 근거로 삼았다.

### 3.2 메모리

| 합성 부하 / 지표 | 원본 | 수정본 |
|---|---:|---:|
| 대형 입력의 20,000단위 요약 24개 보유, GC 후 추가 `heapUsed` 중앙값 | 110.303 MiB | 1.152 MiB |
| 1MiB 메시지 처리 후 8개 연결의 유휴 수신 버퍼 실제 용량 | 16 MiB | 0 MiB |
| 같은 8개 연결에서 GC 후 추가 `arrayBuffers` 중앙값 | 16 MiB | 0 MiB |

메모리 조건별로 **별도 프로세스 5회**를 실행하고, 측정 전/후 명시적 GC를 수행했다. 두 버전 모두 최종 요약 합계는 480,000 UTF-16 단위다. 연결·객체 자체의 메모리가 0이 된다는 의미가 아니라, 이 수신 버퍼의 추가 보유가 0이라는 뜻이다. WebSocket 메모리 벤치마크의 유휴 시간은 결정적 시계로 진행했으며, 실제 5초대 네이티브 타이머 테스트는 별도로 통과했다.

`heapUsed`, `arrayBuffers`, `external`, RSS는 다르다. Node `Buffer`는 `arrayBuffers` 및 `external` 통계에 포함되며, 할당기 때문에 참조를 해제해도 OS의 RSS가 즉시 같은 양만큼 감소하지 않을 수 있다.[2] 이 보고서는 힙/버퍼 감소를 전체 프로세스 RSS 감소로 바꾸어 주장하지 않는다. [6]에서 경고하는 운영 프로세스의 강제 힙 스냅샷은 생성하지 않았다.

## 4. 회귀 테스트 결과

| 검사 | 결과 | 범위/주의 |
|---|---|---|
| 원본 대체 Node 전체 경로 | 1,264건 중 1,247 통과 / 17 실패 | 제공 런타임, `--experimental-strip-types` |
| 수정본 동일 전체 경로 | 1,342건 중 1,325 통과 / 17 실패 | 원본의 통과 항목 전부 유지; 같은 실패 집합 |
| 이번에 추가한 Node 검사만 | 78 / 78 통과 | 전체 경로에도 포함되므로 중복 합산하지 않음 |
| Chromium 컴포넌트 회귀 | 24 / 24 통과, 페이지 오류 0 | 실제 DOM/이벤트/키보드, 앱 전체 E2E 아님 |
| 실제 TCP/HTTP Upgrade 회귀 | 원본·수정본 2 / 2 통과 | 위 추가 Node 78건에 포함 |
| 수정된 TypeScript 두 파일의 제한적 strict 검사 | 원본·수정본 모두 종료 코드 0 | 전역 TS 5.8.3 / Node 타입 25.1.0 사용; 전체 빌드 대체 아님 |
| 변경/추가 JS 문법 검사 | 통과 | `node --check` |
| 잠금 파일 호스트 검사 | 통과 | 승인된 레지스트리 URL 352개 |
| 공식 `npm run build` | 실패 | Mermaid vendor 다운로드 단계의 DNS 실패 |
| 공식 `npm test` | 실패 | Vitest 미설치, 이후 공식 durability 단계 도달 못함 |
| 공식 data-loss/collaboration/security 검증 | 완료 못함 | `tsx` 누락으로 중단 |

### 변경 경로의 검증 내용

TreeView는 서버·프런트엔드별 결정적 무작위/비정상 트리 500개씩, 평면/균형/깊은 트리, 빈 입력, 중복 ID, 고아 노드, 순환, `__proto__` 같은 ID, 길이 상한, 악성 문자열, 요약 경계를 실제 원본 함수와 비교했다. 서버 HTML의 이스케이프와 전체 메모 보존도 확인했다.

브라우저는 제목/노드/메모 편집, 추가/삭제, 들여쓰기/내어쓰기, 형제 이동, 부모 삭제 후 자식 승계, 접기/펼치기, 선택·포커스·화살표/Home/End/Enter, 읽기 전용 변경 차단, dirty 알림, ARIA 속성, 7개 언어를 비교했다. 앱 CSS·반응형 시각 디자인·브라우저 전체 인증 흐름은 이 테스트 범위가 아니다.

WebSocket은 작은/대형 프레임, 헤더 길이 경계, 부분 수신 중 타이머 실행, 분할 UTF-8, 중간 ping, 비동기 처리/큐, 타이머 재사용과 취소, 유휴 후 재수신, 100개 결정적 분할/결합 스트림을 비교했다. 무마스킹, 잘못된 UTF-8·opcode·제어 프레임·continuation·RSV·close 길이, 초과 길이에서 기존 종료 코드 1002/1007/1009를 유지했다. 실제 네이티브 WebSocket 클라이언트와 loopback HTTP 서버로 바이너리/텍스트/빈 문자열 echo, ping/pong, 정상 종료도 확인했다. 인증된 협업 세션과 MariaDB는 연결하지 않았다.

### 원본부터 존재한 17건의 실패

상세 진단은 `baseline-failures.json`, 필터링하지 않은 로그는 `logs/baseline-node.log`와 `logs/current-node-final.log`에 있다. 실패 항목 이름과 기존 통과 항목의 보존은 `regression-summary.json`에서 기계적으로 비교했다. “기존 실패라서 안전하다”는 판정이 아니라 “이번 변경에서 새 실패는 관찰되지 않았다”는 판정이다.

| 번호 | 실패한 검사 | 관찰된 분류 |
|---:|---|---|
| 1 | tests/ai-chat-timestamp-integrity.node.test.mjs | 환경·로더/의존성 |
| 2 | the HTTP reproduction demonstrates legacy cross-user disclosure and fixed isolation | 환경·로더/의존성 |
| 3 | custom icon mutations revalidate authentication inside the storage transaction | 원본에도 있는 단언 실패 |
| 4 | authentication route source retains all hardened ordering guarantees | 원본에도 있는 단언 실패 |
| 5 | tests/backup-metadata-integrity.node.test.mjs | 환경·로더/의존성 |
| 6 | every created database table has an explicit backup-scope classification | 원본에도 있는 단언 실패 |
| 7 | identity-rebinding reproducer proves vulnerable and fixed states | 환경·로더/의존성 |
| 8 | standalone reproduction shows the vulnerable collision and remediated rejection | 환경·로더/의존성 |
| 9 | bookmark fetch path preserves the SSRF, redirect, port, pinning, deadline, and body guards | 원본에도 있는 단언 실패 |
| 10 | custom icon reads require authentication, ownership or an owner-controlled shared-page publication, and private caching | 원본에도 있는 단언 실패 |
| 11 | workspace restore carries and revalidates auth, device-session, and workspace-generation scope | 원본에도 있는 단언 실패 |
| 12 | read mode reuses the existing secured bookmark preview API without changing save serialization | 원본에도 있는 단언 실패 |
| 13 | standalone reproduction proves the vulnerable and corrected backup states | 환경·로더/의존성 |
| 14 | the standalone reproduction demonstrates the metadata gap and the fail-closed remediation | 환경·로더/의존성 |
| 15 | bookmark preview modes share the same egress policy and translated IPv6 is classified | 원본에도 있는 단언 실패 |
| 16 | tests/structured-metadata-integrity.node.test.mjs | 환경·로더/의존성 |
| 17 | tests/theme-preference-persistence.node.test.mjs | 환경·로더/의존성 |

## 5. 보존·수정 범위

변경한 운영 코드 세 파일의 원본/수정 SHA-256은 `source-changes.json`, 내용 차이는 `source-changes.patch`에 있다. 기존 CRLF 줄바꿈을 유지했다. `package.json`, `package-lock.json`, `.npmrc`, 환경설정 예제, DB 마이그레이션, 인증/인가 미들웨어, 저장/복원·첨부·네트워크 정책, 기존 테스트는 모두 원본 바이트와 동일하다. 새로운 테스트 보조 코드와 원본 fixture는 운영 모듈에서 import하지 않는다.

원본 `.git`에는 **44개 ZIP 항목, 일반 파일 28개**가 있다. 패키징 시 `.git`을 새로 초기화하거나 재작성하지 않고 원본 ZIP의 로컬 헤더·압축 데이터·데이터 디스크립터를 그대로 복사한다. 내용 SHA-256뿐 아니라 날짜·권한 속성·extra/comment·압축 메타데이터와 원시 로컬 레코드를 대조한다. 검증 프로그램은 ZIP을 읽기만 하고 Git 명령을 실행하지 않는다. 원본 파일을 제거하거나 `.git` 안에 새 파일을 추가하지 않는다.

원본 커밋/인덱스는 그대로이므로, 수정본을 나중에 사용자가 Git으로 확인하면 세 운영 코드 파일과 새 검증 자료가 작업 트리의 변경으로 나타날 수 있다. 이것은 `.git` 내부를 수정했다는 뜻이 아니다.

## 6. 재현 방법

프로젝트 루트에서 실행한다. 표준 검증에는 프로젝트 `engines` 조건을 충족하는 Node와 설치된 잠금 파일 의존성이 필요하다. 아래 명령은 엔진 제한을 완화하지 않는다.

```sh
# 지원 Node 환경 + 레지스트리 접근이 가능한 환경에서
npm ci
npm run build
npm test
npm run verify:data-loss
npm run verify:collaboration
npm run verify:security
```

이번 수정의 독립 재현/회귀 검사:

```sh
node --experimental-strip-types --test tests/treeview-resource-followup.node.test.mjs tests/websocket-idle-buffer-resource.node.test.mjs tests/websocket-loopback-resource.node.test.mjs
node --expose-gc --experimental-strip-types scripts/benchmark-resource-followup.mjs > resource-followup-benchmark.json
```

대체 전체 Node 경로는 공식 `tsx` 경로를 대체해 합격 판정하는 수단이 아니다. 이 환경에서 원본/수정본에 **동일하게 적용한 비교 경로**다.

```sh
node --experimental-strip-types --test --test-concurrency=4 tests/*.node.test.mjs
```

실제 Chromium 컴포넌트 검사는 Python Playwright와 Chromium이 필요하다. `--browser`를 생략하면 PATH의 Chromium/Chrome 또는 Playwright의 설치 브라우저를 사용한다. 제공 컨테이너에서는 Chromium 144.0.7559.96를 사용했다. 스크립트의 `--no-sandbox`는 격리된 테스트 실행 옵션이며 앱의 CSP/보안 설정을 변경하지 않는다. 운영 브라우저 실행 정책으로 복사하면 안 된다.

```sh
python scripts/verify-resource-followup-browser.py --browser /path/to/chromium --output resource-followup-browser.json
```

원본 ZIP과 수정 ZIP을 다운로드한 뒤, 압축 파일 자체의 보존 검사는 다음과 같다.

```sh
python scripts/verify-resource-followup-archive.py /path/to/BrainVault.zip /path/to/BrainVault_resource_fixed.zip --output archive-verification.json
```

이 검사는 원본 아카이브의 SHA-256, 모든 원본 항목 보존, 수정 파일 3개 제한, 중복 항목, ZIP CRC, `.git` 내용·메타데이터·원시 압축 레코드 동일성을 검사하고 실패 시 0이 아닌 종료 코드를 반환한다.

## 7. 남은 검증 범위

지원 Node와 완전한 의존성을 갖춘 환경의 공식 빌드/Vitest/전체 통합 검증, 실제 MariaDB 및 로그인 상태의 저장·복원·협업 E2E, 장기 운영 부하, 다른 브라우저/지원 Node 버전에서의 메모리 수치는 검증하지 못했다. 이 수정본을 “전 기능·전 보안 검증 완료” 또는 “다른 자원 낭비가 더는 없음”으로 표현하지 않는다. 이번 결과는 재현된 세 영역의 수정과 실행 가능한 비교 검사에 한정된다.

## 8. 외부 기술 자료

프로젝트 결함과 수치는 첨부 프로젝트에서 직접 재현한 결과이며, 외부 자료는 API 의미와 측정 해석에 사용했다. 검색·확인일: 2026-09-16.

[1] Node.js 공식 Timers 문서 — `timeout.refresh()`, `timeout.unref()`, 타이머 실행 시점. https://nodejs.org/api/timers.html

[2] Node.js 공식 Process 문서 — `process.memoryUsage()`, `heapUsed`, `arrayBuffers`, `external`, RSS와 glibc 할당기 단편화. https://nodejs.org/api/process.html#processmemoryusage

[3] MDN — Map의 순서와 평균 sublinear 접근 요구. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map

[4] MDN — Memory management, 도달 가능성과 가비지 컬렉션. https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Memory_management

[5] Node.js 공식 22.23.2 LTS 릴리스. https://nodejs.org/en/blog/release/v22.23.2

[6] Node.js 공식 Using Heap Snapshot — 메인 스레드 정지와 추가 메모리 위험. https://nodejs.org/learn/diagnostics/memory/using-heap-snapshot
