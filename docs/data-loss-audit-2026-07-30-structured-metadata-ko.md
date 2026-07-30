# BrainVault 구조화 블록 데이터 무결성 심층 감사 및 수정 보고서

감사일: 2026-07-30 (Asia/Seoul)  
대상: 업로드된 `BrainVault.zip` 전체 작업 트리와 보존된 `.git` 디렉터리  
기준 Git HEAD: `96ec2a6`  
중점: 구조화 블록 원본 보존, Yjs 관계형 반영, 파괴적 materialization 순서, 부분 손상 데이터 복구

## 1. 최종 결론

이번 후속 감사에서 새 데이터 무결성 결함 2건을 확인하고 수정했다.

1. **High — BOOKMARK/AI_CHAT 메타데이터의 성공 응답 동반 자동 축약**
   - 직접 블록 생성·수정과 Yjs 관계형 materialization 경로가 원본 metadata를 정규화한 뒤, 정규화 결과를 권위 데이터로 DB에 저장했다.
   - 허용 길이·개수보다 큰 데이터는 요청 자체는 성공하지만 초과 부분이 조용히 사라졌다.
   - 결정론적 재현에서 AI 답변 12,001자가 12,000자로 저장되어 1자가 영구 손실됐다.

2. **Medium — 부분 손상 DATABASE metadata 복구 시 존재하지 않는 속성을 참조하는 기본 뷰 생성**
   - `database` 객체는 있으나 속성·뷰가 불완전한 경우, 정규화된 속성에는 `title`만 남을 수 있는데 기본 board 뷰는 여전히 존재하지 않는 `status` 속성을 `groupPropertyId`와 `hiddenPropertyIds`로 참조했다.
   - 행 데이터 자체를 삭제하지는 않지만, 복구된 metadata가 자기모순 상태가 되어 그룹·숨김 설정이 잘못 표현되거나 다음 편집에서 불안정하게 재정규화될 수 있었다.

수정 후에는 다음 불변식을 강제한다.

```text
성공으로 응답한 구조화 블록 저장
    ⇒ 요청의 권위 metadata가 바이트 의미상 그대로 DB에 남음

UI 정규화가 일부 데이터를 제거할 수 있는 입력
    ⇒ DB/Yjs 관계형 쓰기 전에 전체 요청 또는 materialization을 실패 폐쇄

DATABASE fallback view의 모든 속성 참조
    ⇒ 같은 정규화 결과의 properties 안에 실제로 존재함
```

이번 범위의 수정·회귀 검사 후 별도의 신규 Critical/High 영구 손실 경로는 확인하지 못했다. 다만 실제 MariaDB 프로세스를 사용한 crash-injection과 전체 Vitest 통합 실행은 아래 환경 제한 때문에 이번 샌드박스에서 수행하지 못했다.

## 2. 감사 범위와 방법

다음 경로를 소스 수준 상태기계로 다시 추적했다.

- 직접 블록 생성·수정의 metadata → derived markdown/html → DB 저장 순서
- Yjs durable update log → server-authoritative materialization → SQL UPDATE/DELETE/INSERT 순서
- TABLE, KANBAN, DATABASE, BOOKMARK, AI_CHAT 정규화 함수의 `slice`, 중복 제거, 참조 정리 동작
- 페이지/블록 영구 삭제의 version snapshot, subtree 잠금, FK cascade 전 생존 행 detach
- 첨부파일 exclusive publish, 파일/디렉터리 fsync, commit 결과 불명 시 파일 보존
- 사용자 ZIP 백업/복원의 SHA-256·CRC·staging·generation journal
- 브라우저 recovery의 durable-before-visible 순서와 Yjs ACK 뒤 정리
- 다중 프로세스 stale room·materialization checkpoint fence

검증 방법:

1. 저장 전후의 권위 데이터가 달라지는 모든 정규화 호출 검색
2. 취약 구현을 실제 프로젝트 정규화 함수로 실행하는 무의존 재현기
3. exact-limit, over-limit, 개수 초과, 관계 참조, JSON 단일 직렬화를 검증하는 Node 회귀 테스트
4. 정상 정규화 결과 4,000건(TABLE/KANBAN/DATABASE/AI_CHAT 각 1,000건)을 무작위 생성해 새 검증기가 정상 결과를 거부하지 않는지 대조
5. 기존 데이터 손실 재현기 4종과 내구성/협업 정적 가드 재실행
6. 전체 TypeScript/JavaScript 144개 파일 구문 검사
7. 원본 ZIP과 수정 트리의 파일별 비교
8. 원본과 최종 `.git` 디렉터리의 재귀 SHA-256 및 바이트 비교

## 3. High 결함: 구조화 metadata 자동 축약 저장

### 3.1 취약 코드 경로

기존 `src/routes/block.routes.ts`와 `src/routes/collaboration.routes.ts`의 `prepareBlockContent()`는 다음 순서를 사용했다.

```text
원본 metadata
→ normalizeBookmarkMetadata() 또는 normalizeAiChatMetadata()
→ 요약 markdown 생성
→ 정규화된 metadata를 DB의 권위 값으로 저장
```

정규화 함수는 표시·검색을 위한 안전한 projection으로는 유효하지만, 다음과 같은 파괴적 동작을 포함한다.

- AI 질문 최대 8,000자
- AI 답변 최대 12,000자
- AI model 최대 120자
- BOOKMARK 최대 50개
- URL·제목·설명·사이트명 길이 제한
- 중복 URL 제거
- 제어문자·공백 정리
- 잘못된 provider/view/URL의 기본값 전환 또는 제거

기존 라우트는 이 projection을 단순 파생값으로 사용하지 않고 원본을 대체해 저장했기 때문에, 정상 HTTP 성공 또는 정상 Yjs materialization이 데이터 전체 보존을 의미하지 않았다.

### 3.2 결정론적 재현

추가 명령:

```bash
npm run reproduce:structured-metadata-loss
```

핵심 출력:

```json
{
  "vulnerability": {
    "originalCharacters": 12001,
    "oldStoredCharacters": 12000,
    "silentlyLostCharacters": 1
  },
  "fixedBehavior": {
    "rejectedBeforeWrite": true,
    "rejectedPath": "metadata.aiChat.answer",
    "authoritativeMetadataIsNoLongerReplacedByTheProjection": true
  }
}
```

이 재현은 모형화한 임의 함수를 사용하지 않고 프로젝트의 실제 `normalizeAiChatMetadata()`를 실행한다.

### 3.3 영구 손실 조건

다음 중 하나로 UI 제한을 우회하면 재현 가능했다.

- API 직접 호출
- 브라우저 개발자 도구 또는 확장 프로그램
- 이전/향후 클라이언트 버전의 제한 불일치
- Yjs 문서에 외부 코드가 삽입한 metadata
- 오래된 또는 수동 작성 backup/API payload

서버는 성공으로 응답하고 원본을 따로 보존하지 않으므로, 이후 복구할 사본이 없으면 초과 부분은 영구 소실된다.

## 4. High 결함 수정

### 4.1 권위 metadata와 파생 projection 분리

BOOKMARK/AI_CHAT 저장 경로를 다음과 같이 변경했다.

```text
원본 metadata ───────────────→ DB 권위 metadata
       └→ get*Data() → 요약 markdown / html_cache
```

- `getBookmarkData(metadata)`와 `getAiChatData(metadata)`는 markdown/html 파생에만 사용한다.
- DB에 기록하는 `metadata`는 정규화 결과가 아니라 검증을 통과한 원본 객체다.
- DB에서 JSON 열이 문자열로 반환되는 경우에도 검증기가 JSON 객체로 한 번만 복호화하고, 저장 시 정확히 한 번만 직렬화한다.
- metadata를 보내지 않은 markdown/checked 변경은 기존 metadata 열을 불필요하게 다시 쓰지 않아 이중 JSON 인코딩을 방지한다.
- derived markdown은 검색·미리보기 길이 제한을 유지하지만 원본 저장값을 덮어쓰지 않는다.

### 4.2 서버 공통 fail-closed 검증기

새 파일 `src/lib/structured-metadata-integrity.ts`를 추가했다.

대상:

- TABLE
- KANBAN
- DATABASE
- BOOKMARK
- AI_CHAT

검증 내용:

- 행·열·카드·속성·옵션·뷰·필터·정렬·북마크 개수 상한
- 문자열 길이 상한
- 중복 ID·태그·URL
- 지원되지 않는 enum 값
- 존재하지 않는 속성·옵션·뷰 참조
- 정규화 과정에서 제거될 NUL·제어문자·비정규 공백
- URL scheme, credential, fragment 및 canonical form
- AI answeredAt의 정확한 `YYYY-MM-DDTHH:mm` 형식

검증 실패 시:

- 직접 저장: `400 BLOCK_METADATA_WOULD_TRUNCATE`
- 협업 materialization: `409 COLLABORATION_METADATA_WOULD_TRUNCATE`
- 오류에는 최초 손실 가능 경로를 `details.path`로 포함한다.
- 어떤 DB 쓰기도 실행되기 전에 전체 트랜잭션이 중단된다.

### 4.3 파괴적 협업 반영보다 먼저 검증

협업 snapshot은 모든 materialized block의 구조화 metadata를 먼저 검증한다. 그 이후에만 다음 작업을 수행한다.

- 기존 행 잠금
- 생존 하위 행 detach
- obsolete block 삭제
- UPDATE/INSERT
- materialization checkpoint 갱신

따라서 하나의 잘못된 구조화 블록 때문에 다른 정상 블록이 먼저 삭제되거나 부분 반영되는 상태를 만들 수 없다.

## 5. Medium 결함: DATABASE fallback dangling reference

### 5.1 원인

`getDatabaseData()`는 일부 손상된 metadata를 복구할 때 실제 properties 집합을 먼저 정규화한다. 하지만 유효한 view가 하나도 없으면 완전한 기본 데이터베이스의 view 두 개를 그대로 재사용했다.

부분 입력에서 정규화 결과가 다음처럼 될 수 있었다.

```json
{
  "properties": [
    { "id": "title", "type": "title" }
  ],
  "views": [
    {
      "id": "board-view",
      "groupPropertyId": "status",
      "hiddenPropertyIds": ["status"]
    }
  ]
}
```

`status`가 실제 properties에 없으므로 자체 참조 무결성이 깨진다.

### 5.2 수정

fallback view를 현재 `propertyById`에 맞춰 재조정한다.

- board group은 존재하고 타입이 `select` 또는 `checkbox`인 속성만 허용
- 존재하지 않는 group은 `null`
- hidden property는 실제 존재하고 title이 아닌 속성만 유지
- active view는 정리된 view 집합에서 선택

무작위 정규화-검증 대조에서 수정 전 즉시 재현됐고, 수정 후 TABLE/KANBAN/DATABASE/AI_CHAT 각 1,000건, 총 4,000건의 정상 정규화 결과가 모두 새 무결성 검증을 통과했다.

## 6. 기존 중대 방어 재검증

다음 기존 방어가 현재 소스에 연결되어 있고 회귀 가드를 통과하는 것을 확인했다.

- MariaDB transaction + row lock 기반의 페이지/소유자/블록 직렬화
- commit 결과 불명 오류를 일반 rollback 실패와 구분
- 첨부파일 hard-link exclusive publish, 파일·디렉터리 fsync
- DB commit 결과가 불명확하면 이동된 첨부파일을 삭제하지 않음
- 첨부 정리 직전 owner lock과 DB 존재 재확인
- Yjs durable log를 관계형 상태의 유일한 materialization 권위로 사용
- stale process-local room의 write/compaction 거부
- materialization version 및 exact update checkpoint fence
- ACK된 Yjs 첨부 위치를 stale SQL 위치가 덮어쓰지 않도록 하는 reconciliation fence
- 브라우저 recovery 저장 성공 전 편집을 live state에 노출하지 않는 durable-before-visible 순서
- 페이지/블록 영구 삭제 전에 exact version snapshot과 subtree 검증
- FK cascade 전에 살아남아야 할 하위 block/attachment detach
- backup manifest fingerprint, attachment SHA-256·CRC, staging, restore generation journal
- 복원 commit 결과 불명 시 marker/journal 기반 시작 복구

## 7. 검증 결과

### 7.1 통과

```text
lockfile registry check:                PASS
Node durability tests:                  19/19 PASS
structured metadata reproduction:       PASS
verify:data-loss:                       PASS
verify:collaboration:                    PASS
source syntax check:                    144 files PASS
new TS strict subset compile:            PASS
normalization/validator random crosscheck: 4,000/4,000 PASS
existing loss reproductions:             4/4 PASS
```

기존 손실 재현기:

- forged collaboration materialization
- cross-instance compaction
- browser recovery write failure
- stale SQL attachment position

모두 취약 모델에서는 손실 창을 재현하고 현재 수정 모델에서는 차단됨을 출력했다.

### 7.2 실행 환경 제한

전체 `npm ci`, `npm run build`, Vitest 통합 테스트는 이번 실행 환경에서 완료하지 못했다.

원인:

- 샌드박스가 강제하는 내부 npm mirror가 lockfile의 `zod` 패키지 버전을 404로 반환
- public npm registry 직접 접속은 DNS `EAI_AGAIN`으로 차단

이는 프로젝트 코드 실패가 아니라 패키지 다운로드 환경 제한이다. 따라서 다음 항목은 실제 배포 전 별도 네트워크/DB 환경에서 반드시 재실행해야 한다.

```bash
npm ci
npm run check
```

추가 권장 운영 시험:

- 실제 MariaDB commit 직전/직후 프로세스 강제 종료
- 디스크 공간 부족·read-only·fsync 실패 주입
- 첨부 이동 직후 서버 종료와 시작 복구
- 다중 탭 브라우저 강제 종료
- backup restore 중 DB/파일시스템 각각의 장애 주입
- 운영 proxy를 포함한 장시간 Yjs reconnect/compaction 시험

## 8. 변경 파일

핵심 제품 코드:

- `src/lib/structured-metadata-integrity.ts` — 신규 fail-closed 구조화 metadata 검증기
- `src/routes/block.routes.ts` — 직접 저장 원본 보존과 pre-write 검증
- `src/routes/collaboration.routes.ts` — 파괴적 materialization 전 전체 검증
- `src/lib/database.ts` — fallback view 참조 정합성 복구

재현·회귀:

- `scripts/reproduce-structured-metadata-truncation.mjs`
- `tests/structured-metadata-integrity.node.test.mjs`
- `scripts/verify-data-loss-guards.mjs`
- `package.json`

문서:

- `docs/data-loss-audit-2026-07-30-structured-metadata-ko.md`
- `docs/README.md`

`package-lock.json`과 의존성 버전은 변경하지 않았다.

## 9. `.git` 보존

감사 중 read-only Git 명령이 index stat cache를 갱신할 수 있음을 확인해, 최종 패키징 전 원본 ZIP의 `.git` 내용을 같은 경로에 바이트 그대로 다시 덮어썼다.

최종 검증 조건:

- `.git` 디렉터리 존재
- 원본/수정본의 `.git` 재귀 파일 목록 동일
- 모든 `.git` 파일 SHA-256 동일
- 최종 ZIP 재추출 뒤에도 동일

Git history를 수정·재작성·commit하지 않았다.
